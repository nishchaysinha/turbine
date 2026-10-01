import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Session record kept in memory and mirrored to the ntfy relay so that any
 * serverless instance can serve it. Only a hash of the token is ever stored
 * or published; the raw token is handed back to the desktop once on create.
 */
export interface SignalingSession {
  code: string;
  tokenHash: string;
  offer: unknown;
  offerCandidates: unknown[];
  answer: unknown | null;
  answerCandidates: unknown[];
  createdAt: number;
  /** Bumped whenever the desktop publishes a fresh offer; answers are tied to it. */
  offerVersion: number;
  expiresAt: number;
}

export class SignalingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_PREFIX = 'TRB-';
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

// In-memory L1 cache; the ntfy relay is the shared source of truth across instances.
const localSessions = new Map<string, SignalingSession>();

function relayBase(): string {
  return (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
}

function generatePairingCode(): string {
  let code = CODE_PREFIX;
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(randomInt(CODE_CHARS.length));
  }
  return code;
}

/** Accepts "trb-abc123", "ABC123", "TRB ABC 123" etc. and returns "TRB-ABC123". */
export function normalizeCode(code: string): string {
  let body = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (body.startsWith('TRB')) body = body.slice(3);
  return CODE_PREFIX + body;
}

export function isValidCode(code: string): boolean {
  return new RegExp(`^${CODE_PREFIX}[${CODE_CHARS}]{${CODE_LENGTH}}$`).test(code);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyToken(session: SignalingSession, token: string | null | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(session.tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function topic(code: string): string {
  return `turbine-p2p-${code.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}`;
}

async function publish(suffix: 'offer' | 'answer', code: string, payload: unknown): Promise<boolean> {
  try {
    const resp = await fetch(`${relayBase()}/${topic(code)}-${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch (e) {
    console.error(`[Signaling] Failed to publish ${suffix} to relay:`, e);
    return false;
  }
}

/** Returns relay messages for a topic, newest first. */
async function poll(suffix: 'offer' | 'answer', code: string, sinceSec?: number): Promise<any[]> {
  try {
    const since = sinceSec !== undefined ? `&since=${sinceSec}` : '';
    const resp = await fetch(`${relayBase()}/${topic(code)}-${suffix}/json?poll=1${since}`, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return [];
    const lines = (await resp.text()).trim().split('\n').filter(Boolean);
    const out: any[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const data = typeof parsed.message === 'string' ? JSON.parse(parsed.message) : parsed.message;
        if (data) out.push(data);
      } catch {}
    }
    return out.reverse();
  } catch {
    return [];
  }
}

function isExpired(session: SignalingSession): boolean {
  return Date.now() > session.expiresAt;
}

async function fetchSessionFromRelay(code: string): Promise<SignalingSession | undefined> {
  const messages = await poll('offer', code);
  // Newest first: the latest offer published for this code wins.
  const latest = messages.find((d) => d && d.code === code && d.offer && d.tokenHash);
  return latest as SignalingSession | undefined;
}

export async function createPairingSession(
  offer: unknown,
  offerCandidates: unknown[] = [],
  token?: string,
  customCode?: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<{ session: SignalingSession; token: string }> {
  if (customCode) {
    const code = normalizeCode(customCode);
    if (!isValidCode(code)) throw new SignalingError(400, 'Invalid pairing code format');
    if (!token) throw new SignalingError(400, 'Token is required to reuse a pairing code');

    const existing = await getPairingSession(code);
    if (existing) {
      if (!verifyToken(existing, token)) throw new SignalingError(409, 'Pairing code is already in use');
      const updated = await updateSessionOffer(code, token, offer, offerCandidates, ttlMs);
      if (!updated) throw new SignalingError(401, 'Invalid token or session expired');
      return { session: updated, token };
    }
    return { session: await storeNewSession(code, token, offer, offerCandidates, ttlMs), token };
  }

  let code = generatePairingCode();
  while (localSessions.has(code)) code = generatePairingCode();
  const newToken = token || randomBytes(16).toString('hex');
  return { session: await storeNewSession(code, newToken, offer, offerCandidates, ttlMs), token: newToken };
}

async function storeNewSession(
  code: string,
  token: string,
  offer: unknown,
  offerCandidates: unknown[],
  ttlMs: number
): Promise<SignalingSession> {
  const now = Date.now();
  const session: SignalingSession = {
    code,
    tokenHash: hashToken(token),
    offer,
    offerCandidates,
    answer: null,
    answerCandidates: [],
    createdAt: now,
    offerVersion: now,
    expiresAt: now + ttlMs,
  };
  localSessions.set(code, session);
  await publish('offer', code, session);
  return session;
}

export async function updateSessionOffer(
  code: string,
  token: string,
  offer: unknown,
  offerCandidates: unknown[] = [],
  ttlMs: number = DEFAULT_TTL_MS
): Promise<SignalingSession | null> {
  const cleanCode = normalizeCode(code);
  const session = await getPairingSession(cleanCode);
  if (!session || !verifyToken(session, token)) return null;

  const now = Date.now();
  session.offer = offer;
  session.offerCandidates = offerCandidates;
  session.answer = null;
  session.answerCandidates = [];
  // Strictly increasing so answers to the previous offer are never matched.
  session.offerVersion = Math.max(now, session.offerVersion + 1);
  session.expiresAt = now + ttlMs;

  localSessions.set(cleanCode, session);
  await publish('offer', cleanCode, session);
  return session;
}

export async function getPairingSession(code: string): Promise<SignalingSession | undefined> {
  const cleanCode = normalizeCode(code);
  let session = localSessions.get(cleanCode);

  // Another instance may have refreshed the offer; always prefer the newest one.
  const remote = await fetchSessionFromRelay(cleanCode);
  if (remote && (!session || remote.offerVersion > session.offerVersion)) {
    session = remote;
    localSessions.set(cleanCode, session);
  }

  if (!session) return undefined;
  if (isExpired(session)) {
    localSessions.delete(cleanCode);
    return undefined;
  }

  if (!session.answer) {
    // Only answers published for the current offer count.
    const answers = await poll('answer', cleanCode, Math.floor(session.offerVersion / 1000));
    const match = answers.find((d) => d && d.answer && d.offerVersion === session!.offerVersion);
    if (match) {
      session.answer = match.answer;
      if (Array.isArray(match.candidates)) session.answerCandidates.push(...match.candidates);
    }
  }

  return session;
}

/** Returns false when no session exists; throws 409 when the offer was already answered. */
export async function setPairingAnswer(
  code: string,
  answer: unknown,
  answerCandidates: unknown[] = []
): Promise<boolean> {
  const cleanCode = normalizeCode(code);
  const session = await getPairingSession(cleanCode);
  if (!session) return false;
  if (session.answer) throw new SignalingError(409, 'This pairing offer has already been answered');

  session.answer = answer;
  session.answerCandidates.push(...answerCandidates);

  const ok = await publish('answer', cleanCode, {
    answer,
    candidates: answerCandidates,
    offerVersion: session.offerVersion,
  });
  if (!ok) {
    session.answer = null;
    session.answerCandidates = [];
  }
  return ok;
}

export async function addIceCandidate(
  code: string,
  role: 'desktop' | 'mobile',
  candidate: unknown
): Promise<boolean> {
  const session = await getPairingSession(code);
  if (!session) return false;

  if (role === 'desktop') {
    session.offerCandidates.push(candidate);
  } else {
    session.answerCandidates.push(candidate);
  }
  return true;
}

/** Public view of a session: never includes the token hash. */
export function publicSession(session: SignalingSession) {
  return {
    code: session.code,
    offer: session.offer,
    offerCandidates: session.offerCandidates,
    answer: session.answer,
    answerCandidates: session.answerCandidates,
    offerVersion: session.offerVersion,
    expiresAt: session.expiresAt,
  };
}

/** Test helper. */
export function __resetStore() {
  localSessions.clear();
}
