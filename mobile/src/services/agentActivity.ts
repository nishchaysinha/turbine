import type { SwarmAgent } from '../types';

export interface AgentEvent {
  agent: SwarmAgent;
  kind: 'completed' | 'failed';
}

const FINISHED: Record<string, AgentEvent['kind'] | undefined> = {
  completed: 'completed',
  failed: 'failed',
};

/**
 * Agents that moved into a finished state between two snapshots. Agents seen
 * for the first time are ignored so a fresh sync doesn't replay old runs.
 */
export function finishedAgents(prev: SwarmAgent[], next: SwarmAgent[]): AgentEvent[] {
  const before = new Map(prev.map((a) => [a.id, a.status]));
  const events: AgentEvent[] = [];
  for (const agent of next) {
    const was = before.get(agent.id);
    const kind = FINISHED[agent.status];
    if (was !== undefined && kind && was !== agent.status) {
      events.push({ agent, kind });
    }
  }
  return events;
}
