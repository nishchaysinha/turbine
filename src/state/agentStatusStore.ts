import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

/**
 * Mirror of the backend agent status hub (src-tauri/src/agent_status.rs).
 * The backend is authoritative; this store only subscribes. Same vocabulary
 * as Orca: working → blocked (needs you) → waiting (idle at prompt) → done.
 */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done';

export interface AgentStatusRow {
  paneId: string;
  state: AgentState;
  agent: string;
  prompt: string | null;
  tool: string | null;
  toolInput: string | null;
  message: string | null;
  exitCode: number | null;
  sessionId: string | null;
  startedAt: number;
  updatedAt: number;
  lastEvent: string;
}

export interface AgentHooksInfo {
  port: number;
  scriptPath: string;
  claudeSettingsPath: string | null;
  claudeInstalled: boolean;
}

type Listener = (row: AgentStatusRow, prev: AgentStatusRow | undefined) => void;

interface AgentStatusState {
  rows: Record<string, AgentStatusRow>;
  /** Panes whose latest done/blocked state the user hasn't looked at yet. */
  unread: Record<string, true>;
  hooks: AgentHooksInfo | null;
  init: () => Promise<void>;
  markRead: (paneId: string) => void;
  clear: (paneId: string) => Promise<void>;
  refreshHooks: () => Promise<void>;
  setClaudeHooks: (install: boolean) => Promise<void>;
  onTransition: (fn: Listener) => () => void;
}

const transitionListeners = new Set<Listener>();
let initPromise: Promise<void> | null = null;

export const useAgentStatusStore = create<AgentStatusState>((set, get) => {
  const apply = (row: AgentStatusRow) => {
    const prev = get().rows[row.paneId];
    const needsAttention = row.state === 'done' || row.state === 'blocked';
    set((s) => ({
      rows: { ...s.rows, [row.paneId]: row },
      unread: needsAttention && prev?.state !== row.state ? { ...s.unread, [row.paneId]: true } : s.unread,
    }));
    transitionListeners.forEach((fn) => {
      try {
        fn(row, prev);
      } catch (e) {
        console.error('[agentStatus] listener failed', e);
      }
    });
  };

  return {
    rows: {},
    unread: {},
    hooks: null,

    init: () => {
      if (!initPromise) {
        initPromise = (async () => {
          const win = getCurrentWebviewWindow();
          await win.listen<AgentStatusRow>('agent_status', (e) => apply(e.payload));
          await win.listen<{ paneId: string }>('agent_status_clear', (e) => {
            set((s) => {
              const rows = { ...s.rows };
              const unread = { ...s.unread };
              delete rows[e.payload.paneId];
              delete unread[e.payload.paneId];
              return { rows, unread };
            });
          });
          try {
            const snapshot = await invoke<AgentStatusRow[]>('agent_status_snapshot');
            set({ rows: Object.fromEntries(snapshot.map((r) => [r.paneId, r])) });
          } catch (e) {
            console.error('[agentStatus] snapshot failed', e);
          }
          await get().refreshHooks();
        })();
      }
      return initPromise;
    },

    markRead: (paneId) => {
      if (!get().unread[paneId]) return;
      set((s) => {
        const unread = { ...s.unread };
        delete unread[paneId];
        return { unread };
      });
    },

    clear: async (paneId) => {
      await invoke('agent_status_clear', { paneId });
    },

    refreshHooks: async () => {
      try {
        set({ hooks: await invoke<AgentHooksInfo>('agent_hooks_info') });
      } catch {
        set({ hooks: null });
      }
    },

    setClaudeHooks: async (install) => {
      set({ hooks: await invoke<AgentHooksInfo>('agent_hooks_set_claude', { install }) });
    },

    onTransition: (fn) => {
      transitionListeners.add(fn);
      return () => transitionListeners.delete(fn);
    },
  };
});

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/**
 * Appends the exit marker to an agent command so the hub learns the real exit
 * code even though the surrounding interactive shell keeps running. On
 * Windows (cmd.exe expands %errorlevel% too early) the shell exits instead,
 * which the PTY-exit path already handles.
 */
export function withExitMarker(command: string): string {
  if (!command.trim()) return command;
  return isWindows ? `${command} & exit` : `${command}; "$TURBINE_HOOK_SCRIPT" exit $?`;
}

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  working: 'Working',
  blocked: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
};
