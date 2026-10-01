import { useEffect, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { useAgentStatusStore, type AgentStatusRow } from '../state/agentStatusStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useNotificationStore } from '../state/notificationStore';

let permission: boolean | null = null;
async function canNotify(): Promise<boolean> {
  if (permission !== null) return permission;
  try {
    permission = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
  } catch {
    permission = false;
  }
  return permission;
}

function describe(row: AgentStatusRow): { title: string; body: string } | null {
  const ws = useWorkspaceStore.getState().workspaces.find((w) => w.panes.some((p) => p.id === row.paneId));
  const pane = ws?.panes.find((p) => p.id === row.paneId);
  const who = pane?.title || pane?.label || row.agent;
  const where = ws ? ` · ${ws.name}` : '';
  if (row.state === 'blocked') return { title: `${who} needs you${where}`, body: row.message ?? 'Waiting for permission' };
  if (row.state === 'done') {
    const failed = row.exitCode !== null && row.exitCode !== 0;
    return {
      title: `${who} ${failed ? `failed (exit ${row.exitCode})` : 'finished'}${where}`,
      body: row.message ?? row.prompt ?? 'Turn complete',
    };
  }
  return null;
}

/**
 * Notifies when an agent finishes a turn or needs permission — from hook
 * status (authoritative), unless you're already looking at that pane.
 * Native notification when the window is in the background, a toast otherwise.
 */
export function useAgentNotifications(focusedPaneId: string | null) {
  const focusedRef = useRef(focusedPaneId);
  focusedRef.current = focusedPaneId;

  useEffect(() => {
    if (focusedPaneId) useAgentStatusStore.getState().markRead(focusedPaneId);
  }, [focusedPaneId]);

  useEffect(
    () =>
      useAgentStatusStore.getState().onTransition(async (row, prev) => {
        if (prev?.state === row.state) return;
        if (row.state !== 'blocked' && !(row.state === 'done' && prev?.state === 'working')) return;
        const text = describe(row);
        if (!text) return;

        let windowFocused = false;
        try {
          windowFocused = await getCurrentWebviewWindow().isFocused();
        } catch {}
        if (windowFocused && focusedRef.current === row.paneId) {
          useAgentStatusStore.getState().markRead(row.paneId);
          return;
        }
        if (windowFocused) {
          useNotificationStore
            .getState()
            .addNotification(text.title, text.body, row.state === 'blocked' ? 'warning' : row.exitCode ? 'error' : 'success');
        } else if (await canNotify()) {
          sendNotification({ title: text.title, body: text.body });
        }
      }),
    [],
  );
}
