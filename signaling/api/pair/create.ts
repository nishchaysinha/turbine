import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPairingSession, SignalingError } from '../../lib/store.js';
import { BadRequest, readJson, sendJson, setCors } from '../../lib/http.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  setCors(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const data = await readJson(req);
    if (!data.offer) {
      sendJson(res, 400, { error: 'WebRTC SDP offer is required' });
      return;
    }

    const { session, token } = await createPairingSession(
      data.offer,
      Array.isArray(data.candidates) ? data.candidates : [],
      typeof data.token === 'string' ? data.token : undefined,
      typeof data.code === 'string' ? data.code : undefined
    );

    sendJson(res, 200, {
      code: session.code,
      token,
      offerVersion: session.offerVersion,
      expiresAt: session.expiresAt,
    });
  } catch (e) {
    if (e instanceof BadRequest) sendJson(res, 400, { error: e.message });
    else if (e instanceof SignalingError) sendJson(res, e.status, { error: e.message });
    else {
      console.error('[Signaling] create failed:', e);
      sendJson(res, 500, { error: 'Internal error' });
    }
  }
}
