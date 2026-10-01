import { describe, expect, it } from 'vitest';
import { changeBlockStarts, nextIndex, parseUnifiedDiff } from './diff';
import { bracketedPaste, formatReviewNote, formatReviewPrompt, type ReviewNote } from './review';
import { flattenTree, statusLabel } from './fileTree';
import { filterRuns, groupRunsByDay, type HistoryRun } from './history';

const DIFF = [
  'diff --git a/src/server.ts b/src/server.ts',
  'index 3b18e51..a9c2f47 100644',
  '--- a/src/server.ts',
  '+++ b/src/server.ts',
  '@@ -12,4 +12,5 @@ export function createServer() {',
  '   const app = express();',
  '-  app.use(cors());',
  "+  app.use(cors({ origin: '*' }));",
  '+  app.use(rateLimit());',
  '   return app;',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1,2 @@',
  '+# Limits',
  '+100 req/min',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/renamed.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to renamed.txt',
].join('\n');

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF);

  it('splits files with status and counts', () => {
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/server.ts', 'modified', 2, 1],
      ['docs/new.md', 'added', 2, 0],
      ['renamed.txt', 'renamed', 0, 0],
    ]);
    expect(files[2].oldPath).toBe('old.txt');
  });

  it('tracks old/new line numbers', () => {
    const lines = files[0].lines;
    expect(lines.map((l) => `${l.kind}:${l.oldNo ?? '-'}:${l.newNo ?? '-'}`)).toEqual([
      'hunk:-:-',
      'ctx:12:12',
      'del:13:-',
      'add:-:13',
      'add:-:14',
      'ctx:14:15',
    ]);
    expect(files[1].lines.at(-1)?.kind).toBe('meta');
  });

  it('finds change blocks and cycles through them', () => {
    const starts = changeBlockStarts(files[0].lines);
    expect(starts).toEqual([2]);
    expect(nextIndex([2, 9], 2, 1)).toBe(9);
    expect(nextIndex([2, 9], 9, 1)).toBe(2);
    expect(nextIndex([2, 9], 2, -1)).toBe(9);
    expect(nextIndex([], 0, 1)).toBeNull();
  });
});

describe('review notes', () => {
  const note: ReviewNote = {
    id: '1',
    filePath: 'src/server.ts',
    lineNumber: 14,
    side: 'new',
    lineText: '  app.use(rateLimit());',
    body: 'Make the limit "configurable"\nvia env',
    createdAt: 0,
  };

  it('uses the stable, quote-safe note format', () => {
    expect(formatReviewNote(note)).toBe(
      'File: src/server.ts\nLine: 14\nCode: app.use(rateLimit());\nUser comment: "Make the limit \\"configurable\\"\\nvia env"'
    );
    expect(formatReviewNote({ ...note, lineNumber: 0, lineText: '' })).toContain('Scope: file');
  });

  it('builds a prompt sorted by file and line', () => {
    const prompt = formatReviewPrompt([{ ...note, lineNumber: 20, id: '2' }, note]);
    expect(prompt.indexOf('Line: 14')).toBeLessThan(prompt.indexOf('Line: 20'));
    expect(prompt).toMatch(/^You are reviewing/);
    expect(prompt).toContain('Run relevant tests');
  });

  it('wraps text in bracketed paste and strips nested markers', () => {
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~\r');
    expect(bracketedPaste('x\x1b[201~y', false)).toBe('\x1b[200~xy\x1b[201~');
  });
});

describe('flattenTree', () => {
  const cache = {
    '': { entries: [
      { name: 'src', path: 'src', isDir: true, status: 'M' },
      { name: 'README.md', path: 'README.md', isDir: false },
      { name: 'docs', path: 'docs', isDir: true },
    ] },
    src: { entries: [{ name: 'server.ts', path: 'src/server.ts', isDir: false, status: ' M' }] },
  };

  it('lists folders first and expands lazily', () => {
    const rows = flattenTree(cache, new Set(['src', 'docs']));
    expect(rows.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.entry.name}` : `${r.depth}:${r.kind}`))).toEqual([
      '0:docs',
      '1:loading',
      '0:src',
      '1:server.ts',
      '0:README.md',
    ]);
  });

  it('labels git statuses', () => {
    expect(statusLabel(' M')?.text).toBe('M');
    expect(statusLabel('??')?.text).toBe('U');
    expect(statusLabel(undefined)).toBeNull();
  });
});

describe('run history', () => {
  const run = (id: string, started: string, prompt: string): HistoryRun => ({
    id,
    prompt,
    status: 'Completed',
    started_at: started,
    agents: [{ id: `a${id}`, role: 'builder', output_summary: id === '1' ? 'added rate limit' : null } as any],
  });
  const now = new Date('2026-10-01T15:00:00');
  const runs = [
    run('1', '2026-10-01T09:00:00', 'Add rate limiting'),
    run('2', '2026-09-30T09:00:00', 'Fix flaky test'),
    run('3', '2026-09-20T09:00:00', 'Write docs'),
  ];

  it('groups by day, newest first', () => {
    const sections = groupRunsByDay(runs, now);
    expect(sections.map((s) => s.label).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(sections).toHaveLength(3);
  });

  it('searches prompts and agent summaries', () => {
    expect(filterRuns(runs, 'flaky').map((r) => r.id)).toEqual(['2']);
    expect(filterRuns(runs, 'RATE LIMIT').map((r) => r.id)).toEqual(['1']);
    expect(filterRuns(runs, '')).toHaveLength(3);
  });
});
