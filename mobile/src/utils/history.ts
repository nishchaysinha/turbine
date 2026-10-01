import type { SwarmAgent } from '../types';

export interface HistoryRun {
  id: string;
  prompt: string | null;
  status: string;
  project_path?: string;
  started_at: string | null;
  updated_at?: string | null;
  agents: SwarmAgent[];
}

export interface HistorySection {
  key: string;
  label: string;
  data: HistoryRun[];
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Search across prompt, status, agent roles and summaries. */
export function filterRuns(runs: readonly HistoryRun[], query: string): HistoryRun[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...runs];
  return runs.filter((r) =>
    [r.prompt ?? '', r.status, ...r.agents.flatMap((a) => [a.role, a.output_summary ?? ''])]
      .join('\n')
      .toLowerCase()
      .includes(q)
  );
}

/** Groups runs into Today / Yesterday / dated sections (SectionList-shaped). */
export function groupRunsByDay(runs: readonly HistoryRun[], now: Date = new Date()): HistorySection[] {
  const today = dayKey(now);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const yesterday = dayKey(y);

  const sections = new Map<string, HistorySection>();
  const sorted = [...runs].sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
  for (const run of sorted) {
    const date = run.started_at ? new Date(run.started_at) : null;
    const key = date && !Number.isNaN(date.getTime()) ? dayKey(date) : 'unknown';
    const label =
      key === 'unknown'
        ? 'Undated'
        : key === today
          ? 'Today'
          : key === yesterday
            ? 'Yesterday'
            : date!.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!sections.has(key)) sections.set(key, { key, label, data: [] });
    sections.get(key)!.data.push(run);
  }
  return [...sections.values()];
}

export function runDuration(run: HistoryRun): string | null {
  if (!run.started_at) return null;
  const end = run.agents
    .map((a) => (a as SwarmAgent & { completed_at?: string | null }).completed_at)
    .filter(Boolean)
    .sort()
    .pop();
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(run.started_at).getTime();
  if (!(ms > 0)) return null;
  const mins = Math.round(ms / 60000);
  return mins < 1 ? '<1 min' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
