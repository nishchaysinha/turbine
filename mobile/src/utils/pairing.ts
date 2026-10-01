/** Accepts "trb-abc123", "abc123", "TRB ABC 123"… and returns "TRB-ABC123". */
export function normalizePairingCode(input: string): string {
  let body = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (body.startsWith('TRB')) body = body.slice(3);
  return body ? `TRB-${body}` : '';
}

export function normalizeSignalingUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** Parses the desktop QR payload `{ type: 'turbine-p2p', signalingUrl, pairingCode }`. */
export function parsePairingPayload(text: string): { signalingUrl?: string; pairingCode: string } | null {
  try {
    const data = JSON.parse(text);
    if (data && data.type === 'turbine-p2p' && typeof data.pairingCode === 'string') {
      return {
        pairingCode: normalizePairingCode(data.pairingCode),
        signalingUrl: typeof data.signalingUrl === 'string' ? normalizeSignalingUrl(data.signalingUrl) : undefined,
      };
    }
  } catch {}
  return null;
}

export interface LanTarget {
  url: string;
  token: string;
}

/**
 * LAN pairing: the desktop QR `{ type: 'turbine-lan', url, token }`, or a typed
 * address like `192.168.1.5:6970` / `ws://host:port` plus a separate token.
 */
export function parseLanPayload(text: string): LanTarget | null {
  try {
    const data = JSON.parse(text);
    if (data && data.type === 'turbine-lan' && typeof data.url === 'string' && typeof data.token === 'string') {
      return { url: normalizeLanUrl(data.url), token: data.token };
    }
  } catch {}
  return null;
}

export function normalizeLanUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url.replace(/^https?:\/\//i, '')}`;
  if (!/:\d+$/.test(url)) url = `${url}:6970`;
  return url;
}
