# Turbine P2P WebRTC Signaling Server (Vercel Serverless)

A lightweight, serverless signaling service for **Turbine Mobile Companion** WebRTC DataChannel connections.

---

## How it works

1. **Zero Bandwidth**: It only handles the initial 2-second SDP handshake (Offer, Answer, and ICE candidates).
2. **Zero Permanent Storage**: Sessions live in memory and are mirrored to an ntfy relay topic so any serverless instance can serve them. They expire after 24 hours.
3. **100% Free**: Operates entirely within Vercel's free serverless hobby tier forever.
4. **100% Private**: Once the peer-to-peer WebRTC DataChannel is established, all terminal streams, keystrokes, agent outputs, and code diffs flow **directly device-to-device with DTLS end-to-end encryption**.

---

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/pair/create` | desktop | `{ offer, candidates?, code?, token? }` → `{ code, token, offerVersion, expiresAt }`. Passing an existing `code` + its `token` refreshes the offer. |
| `GET` | `/api/pair/:code[?token=]` | both | Offer, answer and candidates. Never returns the token. |
| `PUT` | `/api/pair/:code` | desktop | `{ token, offer, candidates? }` refreshes the offer and clears the old answer. |
| `POST` | `/api/pair/:code` | mobile | `{ answer, candidates? }`. Only the first answer per offer is accepted (409 afterwards). |
| `PATCH` | `/api/pair/:code` | both | `{ role, candidate, token? }` trickles an ICE candidate (desktop must send its token). |

Pairing codes look like `TRB-XXXXXX` (6 random characters, ~1 billion combinations); the mobile app accepts them with or without the prefix/dash. Only a SHA-256 hash of the session token is stored or published.

Set `NTFY_URL` to use a self-hosted ntfy instance instead of `https://ntfy.sh`.

## Development

```bash
pnpm install
pnpm test      # vitest, ntfy is faked in-memory
pnpm build     # typecheck
```

---

## Deploy to Vercel

```bash
npx vercel
```
Or import this directory into your [Vercel Dashboard](https://vercel.com/new).

Once deployed, copy your deployment URL (e.g. `https://turbine-signaling.vercel.app`) into Turbine Desktop!
