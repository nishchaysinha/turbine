import { invoke } from '@tauri-apps/api/core';

/**
 * Drains pending output bytes for a pane. PTY data travels over the raw-byte
 * invoke response path instead of Tauri events: event payloads are injected as
 * JSON literals inside evaluateJavaScript source strings, which forces WebKit
 * to parse megabytes of script per second under output floods. The backend
 * emits a tiny `pty_data_ready { pane_id }` signal; consumers call this to pull.
 */
export async function takePtyOutput(paneId: string): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer>('pty_take_output', { paneId });
  return new Uint8Array(data);
}

const drainingPanes = new Set<string>();

/**
 * Output taps see every chunk of every pane exactly once, whoever drains it.
 * `pty_take_output` is destructive, so there must be a single reader per pane;
 * other interested parties (swarm summaries, the phone bridge) tap instead of
 * draining, or chunks get split between readers and each sees a garbled stream.
 */
export type PtyOutputTap = (paneId: string, bytes: Uint8Array, text: string) => void;
const taps = new Set<PtyOutputTap>();
const decoders = new Map<string, TextDecoder>();
const owners = new Map<string, number>();

export function onPtyOutput(tap: PtyOutputTap): () => void {
  taps.add(tap);
  return () => taps.delete(tap);
}

/** Marks a pane as drained by a mounted view (e.g. its TerminalPane). Returns a release fn. */
export function claimPaneOutput(paneId: string): () => void {
  owners.set(paneId, (owners.get(paneId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (owners.get(paneId) ?? 1) - 1;
    if (n <= 0) owners.delete(paneId);
    else owners.set(paneId, n);
  };
}

export function isPaneOutputClaimed(paneId: string): boolean {
  return owners.has(paneId);
}

/** Decodes with a per-pane streaming decoder so multi-byte chars split across chunks survive. */
function decodeChunk(paneId: string, bytes: Uint8Array): string {
  let decoder = decoders.get(paneId);
  if (!decoder) {
    decoder = new TextDecoder();
    decoders.set(paneId, decoder);
  }
  return decoder.decode(bytes, { stream: true });
}

export function forgetPaneOutput(paneId: string) {
  decoders.delete(paneId);
}

/**
 * Pulls a pane's output until its buffer runs dry, invoking `onBytes` per take.
 * Paced to ~30 takes/s: an unthrottled pull loop spins hundreds of raw-byte IPC
 * roundtrips per second, and the per-response buffers churn WebKit's C++ heap
 * hard enough to peg the content process. 30Hz × 4MB buffer ≫ any PTY's output
 * rate, while the Rust side blocks the child when the buffer fills.
 * Re-entrant calls for a pane already draining return immediately.
 */
export async function drainPtyOutput(
  paneId: string,
  onBytes: (bytes: Uint8Array, text: string) => void | Promise<void>,
  paceMs = 33,
): Promise<void> {
  if (drainingPanes.has(paneId)) return;
  drainingPanes.add(paneId);
  try {
    let bytes = await takePtyOutput(paneId);
    while (bytes.length > 0) {
      const text = decodeChunk(paneId, bytes);
      for (const tap of taps) {
        try {
          tap(paneId, bytes, text);
        } catch (e) {
          console.error('[ptyData] output tap failed', e);
        }
      }
      await onBytes(bytes, text);
      await new Promise((r) => setTimeout(r, paceMs));
      bytes = await takePtyOutput(paneId);
    }
  } catch {
    // PTY gone — pty_exit handles cleanup.
  } finally {
    drainingPanes.delete(paneId);
  }
}
