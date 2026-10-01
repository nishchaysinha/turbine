import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import createHandler from '../api/pair/create.js';
import codeHandler from '../api/pair/[code].js';
import { __resetStore } from '../lib/store.js';
import { installFakeNtfy } from './fakeNtfy.js';

let server: Server;
let base = '';
let realFetch: typeof fetch;

beforeAll(async () => {
  realFetch = globalThis.fetch;
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/pair/create')) return void createHandler(req, res);
    if (req.url?.startsWith('/api/pair/')) return void codeHandler(req, res);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

beforeEach(() => {
  __resetStore();
  installFakeNtfy();
});

const call = (path: string, init?: RequestInit) => realFetch(base + path, init);
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('pairing API', () => {
  it('runs the full offer/answer handshake', async () => {
    const created = await call('/api/pair/create', json('POST', { offer: { type: 'offer', sdp: 'x' } }));
    expect(created.status).toBe(200);
    const { code, token } = await created.json();

    const got = await (await call(`/api/pair/${code}`)).json();
    expect(got.offer).toEqual({ type: 'offer', sdp: 'x' });
    expect(got.token).toBeUndefined();
    expect(got.tokenHash).toBeUndefined();

    const ans = await call(`/api/pair/${code}`, json('POST', { answer: { type: 'answer', sdp: 'y' } }));
    expect(ans.status).toBe(200);

    const polled = await (await call(`/api/pair/${code}?token=${token}`)).json();
    expect(polled.answer).toEqual({ type: 'answer', sdp: 'y' });

    const again = await call(`/api/pair/${code}`, json('POST', { answer: { type: 'answer', sdp: 'z' } }));
    expect(again.status).toBe(409);
  });

  it('rejects bad tokens, bad JSON, missing sessions and wrong methods', async () => {
    const { code } = await (await call('/api/pair/create', json('POST', { offer: {} }))).json();
    expect((await call(`/api/pair/${code}?token=bad`)).status).toBe(401);
    expect((await call(`/api/pair/${code}`, json('PUT', { token: 'bad', offer: {} }))).status).toBe(401);
    expect(
      (await call(`/api/pair/${code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))
        .status
    ).toBe(400);
    expect((await call('/api/pair/TRB-ZZZZZZ')).status).toBe(404);
    expect((await call('/api/pair/create')).status).toBe(405);
    expect((await call('/api/pair/create', json('POST', {}))).status).toBe(400);
  });

  it('lets the desktop refresh its offer with its token', async () => {
    const { code, token } = await (await call('/api/pair/create', json('POST', { offer: { v: 1 } }))).json();
    const put = await call(`/api/pair/${code}`, json('PUT', { token, offer: { v: 2 } }));
    expect(put.status).toBe(200);
    expect((await (await call(`/api/pair/${code}`)).json()).offer).toEqual({ v: 2 });
  });
});
