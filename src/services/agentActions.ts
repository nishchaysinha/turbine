import { invoke } from '@tauri-apps/api/core';

/**
 * Actions on a running agent's terminal, shared by the desktop Agents panel
 * and the phone bridge so both behave identically.
 */
async function write(paneId: string, text: string) {
  await invoke('pty_write', { paneId, data: Array.from(new TextEncoder().encode(text)) });
}

/**
 * Bracketed paste makes TUIs (Claude Code, Codex, …) treat a multi-line
 * prompt as one message instead of submitting at the first newline.
 */
export function bracketedPaste(text: string, submit = true): string {
  return `\x1b[200~${text.replace(/\x1b\[20[01]~/g, '')}\x1b[201~${submit ? '\r' : ''}`;
}

export const agentActions = {
  sendPrompt: (paneId: string, prompt: string) =>
    write(paneId, prompt.includes('\n') ? bracketedPaste(prompt) : `${prompt}\r`),
  /** Accept the default choice of a permission prompt (Enter). */
  approve: (paneId: string) => write(paneId, '\r'),
  /** Dismiss a permission prompt / interrupt the current turn (Esc). */
  deny: (paneId: string) => write(paneId, '\x1b'),
  interrupt: (paneId: string) => write(paneId, '\x1b'),
  /** Hard stop (Ctrl+C), for agents that ignore Esc. */
  kill: (paneId: string) => write(paneId, '\x03'),
};
