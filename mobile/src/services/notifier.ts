import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import { socketService } from './socketService';
import { finishedAgents, type AgentEvent } from './agentActivity';
import type { SwarmAgent } from '../types';
import type { AgentStatusRow } from './protocol';

type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();

/** In-app subscribers (the toast banner) for agent completion events. */
export function onAgentFinished(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let started = false;

/**
 * Watches swarm agents and tells the user when one finishes: an in-app
 * banner while the app is open, a local notification when it's backgrounded.
 */
export function startAgentNotifier() {
  if (started) return;
  started = true;

  if (Platform.OS !== 'web') {
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });
      Notifications.requestPermissionsAsync().catch(() => {});
    } catch {}
  }

  let prev: SwarmAgent[] = socketService.swarmAgents;
  let prevStatus: Record<string, AgentStatusRow> = socketService.agentStatus;
  socketService.subscribe(() => {
    // Hosts with the status hub tell us exactly when an agent needs us or finishes.
    if (socketService.agentStatus !== prevStatus) {
      const before = prevStatus;
      prevStatus = socketService.agentStatus;
      for (const row of Object.values(prevStatus)) {
        const prevRow = before[row.paneId];
        if (prevRow === row) continue;
        const was = prevRow?.state;
        const exited = row.exitCode !== null && row.exitCode !== undefined && prevRow?.exitCode !== row.exitCode;
        if (row.state === 'blocked' && was !== 'blocked') announceStatus(row, 'blocked');
        // A finished turn, or a process exit (agents without hooks only ever report that).
        else if (row.state === 'done' && (was === 'working' || exited)) announceStatus(row, row.exitCode ? 'failed' : 'completed');
      }
    }
    const next = socketService.swarmAgents;
    if (next === prev) return;
    const events = finishedAgents(prev, next);
    prev = next;
    // Legacy hosts only: with the status hub the exit marker already announced these.
    if (!socketService.supports('agents')) events.forEach(announce);
  });
}

function paneTitle(paneId: string, fallback: string): string {
  const pane = socketService.workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId);
  return pane?.title || pane?.label || fallback;
}

function announceStatus(row: AgentStatusRow, kind: 'blocked' | 'completed' | 'failed') {
  const who = paneTitle(row.paneId, row.agent);
  const title = kind === 'blocked' ? `🟡 ${who} needs you` : kind === 'completed' ? `✅ ${who} finished` : `⚠️ ${who} failed`;
  const body = row.message || row.prompt || 'Open Turbine Companion';
  try {
    Haptics.notificationAsync(
      kind === 'completed' ? Haptics.NotificationFeedbackType.Success : kind === 'blocked' ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error
    );
  } catch {}
  statusListeners.forEach((fn) => fn({ title, body, kind, paneId: row.paneId }));
  if (Platform.OS !== 'web' && AppState.currentState !== 'active') {
    Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null }).catch(() => {});
  }
}

export interface StatusAnnouncement {
  title: string;
  body: string;
  kind: 'blocked' | 'completed' | 'failed';
  paneId: string;
}
const statusListeners = new Set<(a: StatusAnnouncement) => void>();

/** In-app subscribers for agent status announcements (needs you / finished). */
export function onAgentStatusAnnouncement(fn: (a: StatusAnnouncement) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function announce(event: AgentEvent) {
  const title = event.kind === 'completed' ? `✅ ${event.agent.role} finished` : `⚠️ ${event.agent.role} failed`;
  const body = event.agent.output_summary || 'Open Turbine Companion to review the run.';

  try {
    Haptics.notificationAsync(
      event.kind === 'completed' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
    );
  } catch {}
  listeners.forEach((fn) => fn(event));

  if (Platform.OS !== 'web' && AppState.currentState !== 'active') {
    Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null }).catch(() => {});
  }
}
