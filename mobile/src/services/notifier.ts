import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import { socketService } from './socketService';
import { finishedAgents, type AgentEvent } from './agentActivity';
import type { SwarmAgent } from '../types';

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
  socketService.subscribe(() => {
    const next = socketService.swarmAgents;
    if (next === prev) return;
    const events = finishedAgents(prev, next);
    prev = next;
    events.forEach(announce);
  });
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
