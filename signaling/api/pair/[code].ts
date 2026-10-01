import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  getPairingSession,
  setPairingAnswer,
  addIceCandidate,
  updateSessionOffer,
  publicSession,
  verifyToken,
  SignalingError,
} from '../../lib/store.js';
import { BadRequest, readJson, sendJson, setCors } from '../../lib/http.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  setCors(res, 'GET, POST, PUT, PATCH, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const parts = reqUrl.pathname.split('/').filter(Boolean);
  const code = reqUrl.searchParams.get('code') || decodeURIComponent(parts[parts.length - 1] || '');

  if (!code) {
    sendJson(res, 400, { error: 'Pairing code is required' });
    return;
  }

  try {
    const session = await getPairingSession(code);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found or expired' });
      return;
    }

    // GET: retrieve offer / poll for answer. A token, if given, must be valid.
    if (req.method === 'GET') {
      const token = reqUrl.searchParams.get('token');
      if (token !== null && !verifyToken(session, token)) {
        sendJson(res, 401, { error: 'Invalid session token' });
        return;
      }
      sendJson(res, 200, publicSession(session));
      return;
    }

    // PUT: desktop refreshes its offer for an existing persistent session.
    if (req.method === 'PUT') {
      const data = await readJson(req);
      if (!data.token || !data.offer) {
        sendJson(res, 400, { error: 'Token and WebRTC SDP offer are required' });
        return;
      }
      const updated = await updateSessionOffer(
        code,
        data.token,
        data.offer,
        Array.isArray(data.candidates) ? data.candidates : []
      );
      if (!updated) {
        sendJson(res, 401, { error: 'Invalid token or session expired' });
        return;
      }
      sendJson(res, 200, {
        success: true,
        code: updated.code,
        offerVersion: updated.offerVersion,
        expiresAt: updated.expiresAt,
      });
      return;
    }

    // POST: mobile submits its answer.
    if (req.method === 'POST') {
      const data = await readJson(req);
      if (!data.answer) {
        sendJson(res, 400, { error: 'WebRTC SDP answer is required' });
        return;
      }
      const success = await setPairingAnswer(
        code,
        data.answer,
        Array.isArray(data.candidates) ? data.candidates : []
      );
      sendJson(res, success ? 200 : 502, { success });
      return;
    }

    // PATCH: trickle an ICE candidate.
    if (req.method === 'PATCH') {
      const data = await readJson(req);
      if (!data.candidate) {
        sendJson(res, 400, { error: 'Candidate is required' });
        return;
      }
      const role = data.role === 'desktop' ? 'desktop' : 'mobile';
      if (role === 'desktop' && !verifyToken(session, data.token)) {
        sendJson(res, 401, { error: 'Invalid session token' });
        return;
      }
      const success = await addIceCandidate(code, role, data.candidate);
      sendJson(res, success ? 200 : 404, { success });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (e instanceof BadRequest) sendJson(res, 400, { error: e.message });
    else if (e instanceof SignalingError) sendJson(res, e.status, { error: e.message });
    else {
      console.error('[Signaling] request failed:', e);
      sendJson(res, 500, { error: 'Internal error' });
    }
  }
}
