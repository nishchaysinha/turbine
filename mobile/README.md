# Turbine Mobile Companion (React Native)

Native mobile companion app for **Turbine** built with React Native and Expo. It allows developers to monitor and control their desktop terminal workspace, AI swarms, kanban tasks, and git diffs remotely from their iPhone or Android phone.

---

## Features

- **Direct P2P link**: a WebRTC DataChannel straight to Turbine Desktop. The signaling service only relays the handshake; codes look like `TRB-XXXXXX` and stay valid for 24h, so reconnecting is one tap.
- **Pair by QR or code**: scan the QR in Turbine's Companion dialog, type the code (any case, with or without `TRB-`), or tap a **recent desktop**.
- **Auto-reconnect**: if the link drops the app keeps its state, shows a banner and re-pairs with the same code.
- **Desktop Layout Mirroring**: View your multi-pane terminal workspace on mobile with the exact spatial layout and proportions as your desktop monitor.
- **Focus-to-Type Mode**: Tap any pane for a 1:1 xterm view at the desktop PTY size (fit width / fit screen / 1:1 / zoom). Type directly into the PTY, or switch to **compose mode** (✎) to write a full line and Send. The key bar has `Esc`, `Tab`, sticky `Ctrl` (applies to the next key from either keyboard), `^C`, `^D`, `^Z`, arrows and `y`/`n`.
- **AI Swarm Orchestration**: Launch runs with a chosen agent preset, **reply** to a running agent or **stop** it, and get a banner / local notification when an agent finishes.
- **Kanban Task Board**: Manage project tasks, update statuses, and trigger 1-tap "Run with Agent".
- **Code review (Orca-style)**: Code → Changes shows per-file diffs with line numbers and next/previous-change navigation. Tap any line to leave a note; send all notes as one review prompt to a running agent (pasted as a single message), a new agent run, or the focused terminal. Notes survive reconnects and restarts.
- **File explorer**: Code → Files browses the focused project lazily with git badges (M/U/A/D), and previews files with line numbers (tap a line to comment on it).
- **Run history**: Swarm → History lists past runs for the project grouped by day, searchable across prompts and agent summaries, with one-tap **Re-run**.
- **Troubleshooting**: a connection log on the connect screen and in the Control tab.

---

## Running with Expo

### Prerequisites
- Node.js 20+
- [Expo Go](https://expo.dev/go) app installed on your iPhone or Android phone (from App Store or Google Play).

### Start Dev Server
```bash
pnpm install
pnpm start        # dev client / Expo Go
pnpm web          # runs in a browser (WebView is shimmed with an iframe)
```

1. Scan the Metro QR code shown in the terminal with the **Expo Go** app on your phone.
2. When the Turbine Companion app opens on your phone, enter the 6-character pairing code displayed in Turbine Desktop (or scan the pairing QR code).

---

## Testing

```bash
pnpm typecheck
pnpm test                 # unit tests (connection lifecycle, protocol, helpers)

cd e2e && pnpm install
pnpm test                 # full end-to-end run, see below
```

`e2e/run.mjs` pairs the real app (web build) with the real desktop `P2PBridge` from the
`turbine` repo over a real WebRTC DataChannel, using the real `turbine-signaling` handlers
(with an in-memory ntfy). It expects `turbine` and `turbine-signaling` checked out next to this
repo (override with `TURBINE_DIR` / `SIGNALING_DIR`). Every step is screenshotted into
[`e2e/screenshots`](e2e/screenshots/README.md), which doubles as a visual walkthrough of the app.
