import { AGENT_STATE_LABELS, useAgentStatusStore, type AgentState } from '../../state/agentStatusStore';
import './agents.css';

/** Small status pill for a pane header. Renders nothing when no agent has reported. */
export function AgentStatusChip({ paneId }: { paneId: string }) {
  const row = useAgentStatusStore((s) => s.rows[paneId]);
  const unread = useAgentStatusStore((s) => Boolean(s.unread[paneId]));
  if (!row) return null;
  const title = [row.agent, row.tool ? `${row.tool}${row.toolInput ? `: ${row.toolInput}` : ''}` : null, row.message]
    .filter(Boolean)
    .join(' — ');
  return (
    <span className={`agent-chip agent-chip--${row.state}${unread ? ' agent-chip--unread' : ''}`} title={title}>
      <span className="agent-chip__dot" />
      {AGENT_STATE_LABELS[row.state]}
      {row.state === 'working' && row.tool ? <span className="agent-chip__tool">· {row.tool}</span> : null}
    </span>
  );
}

/** Highest-priority state across a set of panes (for workspace tabs). */
export function rollupState(states: AgentState[]): AgentState | null {
  for (const s of ['blocked', 'done', 'working', 'waiting'] as const) {
    if (states.includes(s)) return s;
  }
  return null;
}

export function WorkspaceAgentDot({ paneIds }: { paneIds: string[] }) {
  const state = useAgentStatusStore((s) => {
    const relevant = paneIds
      .map((id) => s.rows[id])
      .filter((r) => r && (r.state !== 'done' || s.unread[r.paneId]))
      .map((r) => r!.state);
    return rollupState(relevant);
  });
  if (!state) return null;
  return <span className={`agent-tab-dot agent-tab-dot--${state}`} title={`Agents: ${AGENT_STATE_LABELS[state]}`} />;
}
