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
