import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { parseUnifiedDiff, type DiffFile, type DiffLine } from '../../utils/diffParse';
import { formatReviewPrompt, type ReviewNote } from '../../utils/reviewNotes';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useAgentStatusStore, AGENT_STATE_LABELS } from '../../state/agentStatusStore';
import { useAgentStore } from '../../state/agentStore';
import { useSwarmStore } from '../../state/swarmStore';
import { agentActions } from '../../services/agentActions';
import './DiffViewer.css';
import '../agents/agents.css';

interface DiffViewerProps {
  projectPath: string;
  onFocus?: () => void;
}

type Scope = 'all' | 'unstaged' | 'staged' | 'branch';

interface GitReview {
  scope: Scope;
  diff: string;
  base: string | null;
  branch: string | null;
  truncated: boolean;
  untracked: number;
}

interface NoteTarget {
  filePath: string;
  lineNumber: number;
  side: 'new' | 'old';
  lineText: string;
  noteId?: string;
}

const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'all', label: 'All changes', hint: 'Everything not committed yet, including new files' },
  { id: 'unstaged', label: 'Unstaged', hint: 'Working tree changes and new files' },
  { id: 'staged', label: 'Staged', hint: 'What the next commit contains' },
  { id: 'branch', label: 'Branch', hint: 'Everything on this branch since it left its base' },
];

const LARGE_FILE_LINES = 1500;

function anchorOf(line: DiffLine): { lineNumber: number; side: 'new' | 'old' } | null {
  if (line.kind === 'add' || line.kind === 'ctx') return { lineNumber: line.newNo!, side: 'new' };
  if (line.kind === 'del') return { lineNumber: line.oldNo!, side: 'old' };
  return null;
}

function notesKey(projectPath: string) {
  return `turbine.reviewNotes:${projectPath}`;
}

function loadNotes(projectPath: string): ReviewNote[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(notesKey(projectPath)) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Orca-style review: scoped diffs (all / unstaged / staged / branch, new files
 * included), a file list, line numbers, notes on any line, and one-click
 * hand-off of all notes to an agent as a single review prompt.
 */
export function DiffViewer({ projectPath, onFocus }: DiffViewerProps) {
  const [scope, setScope] = useState<Scope>('all');
  const [review, setReview] = useState<GitReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedLarge, setExpandedLarge] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<ReviewNote[]>(() => loadNotes(projectPath));
  const [target, setTarget] = useState<NoteTarget | null>(null);
  const [draft, setDraft] = useState('');
  const [sendOpen, setSendOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileRefs = useRef(new Map<string, HTMLDivElement>());

  const loadDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReview(await invoke<GitReview>('get_git_review', { path: projectPath, scope }));
    } catch (e) {
      setError(String(e));
      setReview(null);
    } finally {
      setLoading(false);
    }
  }, [projectPath, scope]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  useEffect(() => setNotes(loadNotes(projectPath)), [projectPath]);

  useEffect(() => {
    if (useAgentStore.getState().presets.length === 0) void useAgentStore.getState().loadPresets();
  }, []);

  const saveNotes = useCallback(
    (next: ReviewNote[]) => {
      setNotes(next);
      try {
        localStorage.setItem(notesKey(projectPath), JSON.stringify(next));
      } catch {}
    },
    [projectPath],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const files = useMemo(() => parseUnifiedDiff(review?.diff ?? ''), [review]);
  const totals = useMemo(
    () => files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }),
    [files],
  );

  const openNote = (t: NoteTarget) => {
    setTarget(t);
    setDraft(t.noteId ? notes.find((n) => n.id === t.noteId)?.body ?? '' : '');
  };

  const commitNote = () => {
    if (!target) return;
    const body = draft.trim();
    if (target.noteId) {
      saveNotes(body ? notes.map((n) => (n.id === target.noteId ? { ...n, body } : n)) : notes.filter((n) => n.id !== target.noteId));
    } else if (body) {
      saveNotes([
        ...notes,
        {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          filePath: target.filePath,
          lineNumber: target.lineNumber,
          side: target.side,
          lineText: target.lineText,
          body,
          createdAt: Date.now(),
        },
      ]);
    }
    setTarget(null);
    setDraft('');
  };

  // Where review notes can go: agents in this workspace first, then any terminal.
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const statusRows = useAgentStatusStore((s) => s.rows);
  const presets = useAgentStore((s) => s.presets);
  const targets = useMemo(() => {
    const panes = (workspace?.panes ?? []).filter((p) => p.type === 'terminal');
    return panes
      .map((p) => ({ pane: p, row: statusRows[p.id] }))
      .sort((a, b) => Number(Boolean(b.row)) - Number(Boolean(a.row)));
  }, [workspace, statusRows]);

  const prompt = useMemo(() => formatReviewPrompt(notes), [notes]);

  const sendToPane = async (paneId: string, label: string, isAgent: boolean) => {
    if (isAgent) await agentActions.sendPrompt(paneId, prompt);
    else await agentActions.pasteOnly(paneId, prompt);
    saveNotes([]);
    setSendOpen(false);
    setToast(
      isAgent
        ? `Sent ${notes.length} note${notes.length === 1 ? '' : 's'} to ${label}`
        : `Pasted into ${label} — press Enter there once the agent is ready`,
    );
  };

  const sendToNewRun = async (presetId: string, name: string) => {
    const swarm = useSwarmStore.getState();
    const run = await swarm.startAdHocRun(projectPath, prompt, workspace?.id, null);
    await swarm.spawnAgent(run.id, presetId, prompt, projectPath);
    saveNotes([]);
    setSendOpen(false);
    setToast(`Started ${name} with your review`);
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setToast('Review prompt copied');
    } catch {
      setToast('Could not access the clipboard');
    }
    setSendOpen(false);
  };

  const scrollToFile = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    requestAnimationFrame(() => fileRefs.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  const renderNoteEditor = () => (
    <div className="review-note-editor" onClick={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        className="review-note-editor__input"
        value={draft}
        placeholder="What should change here? (Ctrl+Enter to save)"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitNote();
          if (e.key === 'Escape') setTarget(null);
        }}
      />
      <div className="review-note-editor__actions">
        <button className="diff-btn diff-btn--primary" onClick={commitNote} disabled={!draft.trim() && !target?.noteId}>
          {target?.noteId ? (draft.trim() ? 'Update note' : 'Delete note') : 'Add note'}
        </button>
        <button className="diff-btn" onClick={() => setTarget(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  const renderFile = (file: DiffFile) => {
    const isCollapsed = collapsed.has(file.path);
    const fileNotes = notes.filter((n) => n.filePath === file.path);
    const tooLarge = file.lines.length > LARGE_FILE_LINES && !expandedLarge.has(file.path);
    return (
      <div
        key={file.path}
        className="review-file"
        ref={(el) => {
          if (el) fileRefs.current.set(file.path, el);
          else fileRefs.current.delete(file.path);
        }}
      >
        <div
          className="review-file__header"
          onClick={() =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(file.path)) next.delete(file.path);
              else next.add(file.path);
              return next;
            })
          }
        >
          <span className="review-file__chevron">{isCollapsed ? '▸' : '▾'}</span>
          <span className="review-file__path">{file.path}</span>
          {file.oldPath && <span className="review-file__meta">from {file.oldPath}</span>}
          {file.status !== 'modified' && <span className={`review-file__badge review-file__badge--${file.status}`}>{file.status}</span>}
          {fileNotes.length > 0 && <span className="review-file__notes">💬 {fileNotes.length}</span>}
          <span className="diff-add">+{file.additions}</span>
          <span className="diff-del">−{file.deletions}</span>
          <button
            className="review-file__comment"
            title="Note on the whole file"
            onClick={(e) => {
              e.stopPropagation();
              openNote({ filePath: file.path, lineNumber: 0, side: 'new', lineText: '' });
            }}
          >
            💬
          </button>
        </div>
        {!isCollapsed && (
          <div className="review-file__body">
            {target && target.filePath === file.path && target.lineNumber === 0 && !target.noteId && renderNoteEditor()}
            {fileNotes
              .filter((n) => n.lineNumber === 0)
              .map((n) => (
                <NoteBubble key={n.id} note={n} editing={target?.noteId === n.id} onEdit={() => openNote({ ...n, noteId: n.id })} editor={renderNoteEditor} />
              ))}
            {tooLarge ? (
              <button className="review-file__large" onClick={() => setExpandedLarge((s) => new Set(s).add(file.path))}>
                Large diff ({file.lines.length} lines) — show anyway
              </button>
            ) : (
              file.lines.map((line, i) => {
                if (line.kind === 'hunk' || line.kind === 'meta') {
                  return (
                    <div key={i} className="review-line review-line--hunk">
                      {line.text}
                    </div>
                  );
                }
                const anchor = anchorOf(line)!;
                const lineNotes = fileNotes.filter((n) => n.lineNumber === anchor.lineNumber && n.side === anchor.side);
                const editingHere =
                  target && !target.noteId && target.filePath === file.path && target.lineNumber === anchor.lineNumber && target.side === anchor.side;
                return (
                  <div key={i}>
                    <div
                      className={`review-line review-line--${line.kind}`}
                      onClick={() => openNote({ filePath: file.path, ...anchor, lineText: line.text })}
                      title="Click to add a review note"
                    >
                      <span className="review-line__no">{line.oldNo ?? ''}</span>
                      <span className="review-line__no">{line.newNo ?? ''}</span>
                      <span className="review-line__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
                      <span className="review-line__code">{line.text || ' '}</span>
                    </div>
                    {lineNotes.map((n) => (
                      <NoteBubble key={n.id} note={n} editing={target?.noteId === n.id} onEdit={() => openNote({ ...n, noteId: n.id })} editor={renderNoteEditor} />
                    ))}
                    {editingHere && renderNoteEditor()}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="diff-viewer" onClick={onFocus}>
      <div className="diff-viewer__header">
        <div className="diff-viewer__scopes" role="tablist">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={scope === s.id}
              title={s.hint}
              className={`diff-scope ${scope === s.id ? 'diff-scope--active' : ''}`}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="diff-viewer__summary">
          {review?.branch && <span className="diff-viewer__branch">⎇ {review.branch}{review.base ? ` vs ${review.base}` : ''}</span>}
          {files.length} file{files.length === 1 ? '' : 's'} <span className="diff-add">+{totals.add}</span>{' '}
          <span className="diff-del">−{totals.del}</span>
        </span>
        <button className="diff-viewer__refresh-btn" onClick={() => void loadDiff()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="diff-viewer__body">
        {files.length > 0 && (
          <div className="diff-viewer__files">
            {files.map((f) => {
              const count = notes.filter((n) => n.filePath === f.path).length;
              return (
                <button key={f.path} className="diff-file-item" onClick={() => scrollToFile(f.path)} title={f.path}>
                  <span className={`diff-file-item__status diff-file-item__status--${f.status}`}>
                    {f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M'}
                  </span>
                  <span className="diff-file-item__name">{f.path.split('/').pop()}</span>
                  {count > 0 && <span className="review-file__notes">{count}</span>}
                  <span className="diff-file-item__dir">{f.path.split('/').slice(0, -1).join('/')}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="diff-viewer__content">
          {error && <div className="diff-viewer__error">{error}</div>}
          {!error && !loading && files.length === 0 && (
            <div className="diff-viewer__empty">
              {scope === 'staged' ? 'Nothing staged.' : scope === 'branch' ? 'No changes on this branch.' : 'No changes found.'}
            </div>
          )}
          {review?.truncated && (
            <div className="diff-viewer__notice">Diff truncated — it's very large. Showing the first part.</div>
          )}
          {!error && files.map(renderFile)}
        </div>
      </div>

      {(notes.length > 0 || toast) && (
        <div className="review-bar">
          {toast ? (
            <span className="review-bar__toast">{toast}</span>
          ) : (
            <>
              <span className="review-bar__count">
                {notes.length} review note{notes.length === 1 ? '' : 's'}
              </span>
              <button className="diff-btn" onClick={() => saveNotes([])}>
                Discard
              </button>
              <div className="review-bar__send">
                <button className="diff-btn diff-btn--primary" onClick={() => setSendOpen((v) => !v)}>
                  Send to agent ▾
                </button>
                {sendOpen && (
                  <div className="review-send-menu">
                    {targets.some((t) => t.row) && <div className="review-send-menu__section">Agents</div>}
                    {targets
                      .filter((t) => t.row)
                      .map(({ pane, row }) => (
                        <button
                          key={pane.id}
                          className="review-send-menu__item"
                          onClick={() => void sendToPane(pane.id, pane.title || pane.label || 'agent', true)}
                        >
                          <span>{pane.title || pane.label || row!.agent}</span>
                          <span className={`agent-chip agent-chip--${row!.state}`}>{AGENT_STATE_LABELS[row!.state]}</span>
                        </button>
                      ))}
                    {targets.some((t) => !t.row) && <div className="review-send-menu__section">Paste into terminal (no Enter)</div>}
                    {targets
                      .filter((t) => !t.row)
                      .map(({ pane }) => (
                        <button
                          key={pane.id}
                          className="review-send-menu__item"
                          onClick={() => void sendToPane(pane.id, pane.title || pane.label || 'terminal', false)}
                        >
                          <span>{pane.title || pane.label || 'Terminal'}</span>
                        </button>
                      ))}
                    {presets.length > 0 && <div className="review-send-menu__section">New agent run</div>}
                    {presets.map((p) => (
                      <button key={p.id} className="review-send-menu__item" onClick={() => void sendToNewRun(p.id, p.name)}>
                        ＋ {p.name}
                      </button>
                    ))}
                    <div className="review-send-menu__section">Other</div>
                    <button className="review-send-menu__item" onClick={() => void copyPrompt()}>
                      Copy prompt
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NoteBubble({
  note,
  editing,
  onEdit,
  editor,
}: {
  note: ReviewNote;
  editing: boolean;
  onEdit: () => void;
  editor: () => ReactElement;
}) {
  if (editing) return editor();
  return (
    <div className="review-note" onClick={onEdit} title="Click to edit">
      <span className="review-note__label">💬 Note{note.lineNumber === 0 ? ' on file' : ''}</span>
      <span className="review-note__body">{note.body}</span>
    </div>
  );
}
