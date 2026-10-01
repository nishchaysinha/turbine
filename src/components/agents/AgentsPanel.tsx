import { useMemo, useState } from 'react';
import { useAgentStatusStore, AGENT_STATE_LABELS, type AgentStatusRow } from '../../state/agentStatusStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { agentActions } from '../../services/agentActions';
import './agents.css';

interface AgentsPanelProps {
  onFocusPane: (workspaceId: string, paneId: string) => void;
}

function elapsed(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ORDER = { blocked: 0, working: 1, done: 2, waiting: 3 } as const;

/**
 * Command center: every agent in every workspace, what it's doing, and what
 * it needs from you — fed by the backend status hub (hooks), not guesses.
 */
export function AgentsPanel({ onFocusPane }: AgentsPanelProps) {
  const rows = useAgentStatusStore((s) => s.rows);
  const unread = useAgentStatusStore((s) => s.unread);
  const hooks = useAgentStatusStore((s) => s.hooks);
  const setClaudeHooks = useAgentStatusStore((s) => s.setClaudeHooks);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const groups = useMemo(() => {
    const byWorkspace = workspaces
      .map((ws) => ({
        ws,
        agents: ws.panes
          .map((p) => ({ pane: p, row: rows[p.id] }))
          .filter((x): x is { pane: typeof x.pane; row: AgentStatusRow } => Boolean(x.row))
          .sort((a, b) => ORDER[a.row.state] - ORDER[b.row.state] || b.row.updatedAt - a.row.updatedAt),
      }))
      .filter((g) => g.agents.length > 0);
    return byWorkspace;
  }, [rows, workspaces]);

  const counts = useMemo(() => {
    const all = Object.values(rows);
    return {
      working: all.filter((r) => r.state === 'working').length,
      blocked: all.filter((r) => r.state === 'blocked').length,
      done: all.filter((r) => r.state === 'done' && unread[r.paneId]).length,
    };
  }, [rows, unread]);

  const send = async (paneId: string) => {
    const text = drafts[paneId]?.trim();
    if (!text) return;
    await agentActions.sendPrompt(paneId, text);
    setDrafts((d) => ({ ...d, [paneId]: '' }));
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await setClaudeHooks(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="agents-panel">
      <div className="agents-panel__header">
        <span className="agents-panel__title">Agents</span>
        <span className="agents-panel__counts">
          {counts.blocked > 0 && <span className="agents-count agents-count--blocked">{counts.blocked} need you</span>}
          {counts.working > 0 && <span className="agents-count agents-count--working">{counts.working} working</span>}
          {counts.done > 0 && <span className="agents-count agents-count--done">{counts.done} done</span>}
        </span>
      </div>

      {hooks && !hooks.claudeInstalled && (
        <div className="agents-panel__setup">
          <div className="agents-panel__setup-title">Live status for Claude Code</div>
          <div className="agents-panel__setup-text">
            Install Turbine's status hooks so agents report when they're working, need permission, or finish. Adds
            entries to <code>{hooks.claudeSettingsPath ?? '~/.claude/settings.json'}</code> (your own hooks are kept;
            a backup is saved). They do nothing outside Turbine.
          </div>
          <button className="agents-btn agents-btn--primary" onClick={install} disabled={installing}>
            {installing ? 'Installing…' : 'Install hooks'}
          </button>
          {error && <div className="agents-panel__error">{error}</div>}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="agents-panel__empty">
          No agents reporting yet. Start Claude Code (or a swarm run) in a Turbine terminal and it appears here.
        </div>
      ) : (
        <div className="agents-panel__list">
          {groups.map(({ ws, agents }) => (
            <div key={ws.id} className="agents-group">
              <div className="agents-group__name">{ws.name}</div>
              {agents.map(({ pane, row }) => (
                <div
                  key={pane.id}
                  className={`agent-card agent-card--${row.state}${unread[pane.id] ? ' agent-card--unread' : ''}`}
                >
                  <button className="agent-card__head" onClick={() => onFocusPane(ws.id, pane.id)} title="Focus pane">
                    <span className={`agent-chip agent-chip--${row.state}`}>
                      <span className="agent-chip__dot" />
                      {AGENT_STATE_LABELS[row.state]}
                    </span>
                    <span className="agent-card__name">{pane.title || pane.label || row.agent}</span>
                    <span className="agent-card__time">{elapsed(row.state === 'working' ? row.startedAt : row.updatedAt, now)}</span>
                  </button>
                  {row.prompt && <div className="agent-card__prompt">{row.prompt}</div>}
                  {row.state === 'working' && row.tool && (
                    <div className="agent-card__tool">
                      <span className="agent-card__tool-name">{row.tool}</span> {row.toolInput}
                    </div>
                  )}
                  {row.message && row.state !== 'working' && <div className="agent-card__message">{row.message}</div>}
                  {row.exitCode !== null && row.exitCode !== undefined && (
                    <div className="agent-card__message">Exited with code {row.exitCode}</div>
                  )}
                  <div className="agent-card__actions">
                    {row.state === 'blocked' && (
                      <>
                        <button className="agents-btn agents-btn--primary" onClick={() => agentActions.approve(pane.id)}>
                          Approve
                        </button>
                        <button className="agents-btn" onClick={() => agentActions.deny(pane.id)}>
                          Deny
                        </button>
                      </>
                    )}
                    {row.state === 'working' && (
                      <button className="agents-btn" onClick={() => agentActions.interrupt(pane.id)}>
                        Interrupt
                      </button>
                    )}
                    <button className="agents-btn" onClick={() => onFocusPane(ws.id, pane.id)}>
                      Open
                    </button>
                  </div>
                  {(row.state === 'waiting' || row.state === 'done') && row.exitCode == null && (
                    <form
                      className="agent-card__reply"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send(pane.id);
                      }}
                    >
                      <input
                        className="agent-card__input"
                        placeholder="Reply to agent…"
                        value={drafts[pane.id] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [pane.id]: e.target.value }))}
                      />
                      <button className="agents-btn agents-btn--primary" type="submit">
                        Send
                      </button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
