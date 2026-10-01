import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  __resetStore,
  addIceCandidate,
  createPairingSession,
  getPairingSession,
  normalizeCode,
  publicSession,
  setPairingAnswer,
  updateSessionOffer,
} from './store.js';
import { installFakeNtfy } from '../test/fakeNtfy.js';

const offer = { type: 'offer', sdp: 'v=0 offer' };
const answer = { type: 'answer', sdp: 'v=0 answer' };

describe('SignalingStore', () => {
  let ntfy: ReturnType<typeof installFakeNtfy>;

  beforeEach(() => {
    __resetStore();
    ntfy = installFakeNtfy();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('creates a session with a 6-character code and a random token', async () => {
    const { session, token } = await createPairingSession(offer, [{ candidate: 'c1' }]);
    expect(session.code).toMatch(/^TRB-[2-9A-HJ-NP-Z]{6}$/);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(session.offerCandidates).toHaveLength(1);
    expect((await getPairingSession(session.code))?.offer).toEqual(offer);
  });

  it('never publishes or exposes the raw token', async () => {
    const { session, token } = await createPairingSession(offer);
    const published = [...ntfy.topics.values()].flat().map((m) => m.message).join('\n');
    expect(published).not.toContain(token);
    expect(JSON.stringify(publicSession(session))).not.toContain(session.tokenHash);
  });

  it('normalizes loosely typed codes', async () => {
    const { session } = await createPairingSession(offer);
    const loose = session.code.slice(4).toLowerCase();
    expect(normalizeCode(loose)).toBe(session.code);
    expect(await getPairingSession(`trb ${loose}`)).toBeDefined();
  });

  it('stores an answer and rejects a second answer for the same offer', async () => {
    const { session } = await createPairingSession(offer);
    expect(await setPairingAnswer(session.code, answer, [{ candidate: 'a1' }])).toBe(true);

    const got = await getPairingSession(session.code);
    expect(got?.answer).toEqual(answer);
    expect(got?.answerCandidates).toHaveLength(1);

    await expect(setPairingAnswer(session.code, { type: 'answer', sdp: 'evil' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('serves sessions and answers from the relay on a cold instance', async () => {
    const { session } = await createPairingSession(offer);
    __resetStore();
    expect(await setPairingAnswer(session.code, answer)).toBe(true);
    __resetStore();
    const got = await getPairingSession(session.code);
    expect(got?.offer).toEqual(offer);
    expect(got?.answer).toEqual(answer);
  });

  it('ignores answers to a previous offer after the desktop refreshes', async () => {
    const { session, token } = await createPairingSession(offer);
    await setPairingAnswer(session.code, answer);
    ntfy.tick();

    const offer2 = { type: 'offer', sdp: 'v=0 offer2' };
    const updated = await updateSessionOffer(session.code, token, offer2);
    expect(updated?.answer).toBeNull();

    // Cold instance must pick the newest offer and not the stale answer.
    __resetStore();
    const got = await getPairingSession(session.code);
    expect(got?.offer).toEqual(offer2);
    expect(got?.answer).toBeNull();

    const answer2 = { type: 'answer', sdp: 'v=0 answer2' };
    expect(await setPairingAnswer(session.code, answer2)).toBe(true);
    __resetStore();
    expect((await getPairingSession(session.code))?.answer).toEqual(answer2);
  });

  it('refuses offer refresh with a wrong token', async () => {
    const { session } = await createPairingSession(offer);
    expect(await updateSessionOffer(session.code, 'nope', offer)).toBeNull();
  });

  it('reuses a code only with the matching token', async () => {
    const { session, token } = await createPairingSession(offer);
    const again = await createPairingSession({ type: 'offer', sdp: 'v2' }, [], token, session.code);
    expect(again.session.code).toBe(session.code);
    expect(again.session.offer).toEqual({ type: 'offer', sdp: 'v2' });

    await expect(createPairingSession(offer, [], 'attacker', session.code)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('expires sessions', async () => {
    const { session } = await createPairingSession(offer, [], undefined, undefined, 1000);
    vi.useFakeTimers({ now: Date.now() + 2000, toFake: ['Date'] });
    expect(await getPairingSession(session.code)).toBeUndefined();
  });

  it('adds trickled ICE candidates', async () => {
    const { session } = await createPairingSession(offer);
    expect(await addIceCandidate(session.code, 'desktop', { candidate: 'd2' })).toBe(true);
    expect((await getPairingSession(session.code))?.offerCandidates).toHaveLength(1);
  });

  it('returns undefined for a non-existent session', async () => {
    expect(await getPairingSession('TRB-ZZZZZZ')).toBeUndefined();
    expect(await setPairingAnswer('TRB-ZZZZZZ', answer)).toBe(false);
  });
});
