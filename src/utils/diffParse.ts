/** Parsed `git diff` output (shared shape with turbine-mobile/src/utils/diff.ts). */
export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file (del/ctx). */
  oldNo: number | null;
  /** Line number in the new file (add/ctx). */
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = {
        path: m ? m[2] : line.slice(11),
        oldPath: null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;

    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
      else if (line.startsWith('Binary files ')) file.status = 'binary';
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4));
    }

    const hunk = line.match(HUNK_RE);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      file.additions++;
      file.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      file.deletions++;
      file.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\')) {
      file.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    }
  }
  return files;
}

/** Indexes of lines that begin a run of changes (for next/previous change navigation). */
export function changeBlockStarts(lines: readonly { kind: DiffLineKind }[]): number[] {
  const starts: number[] = [];
  lines.forEach((l, i) => {
    const changed = l.kind === 'add' || l.kind === 'del';
    const prevChanged = i > 0 && (lines[i - 1].kind === 'add' || lines[i - 1].kind === 'del');
    if (changed && !prevChanged) starts.push(i);
  });
  return starts;
}

export function nextIndex(starts: readonly number[], current: number, direction: 1 | -1): number | null {
  if (starts.length === 0) return null;
  if (direction === 1) return starts.find((s) => s > current) ?? starts[0];
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < current) return starts[i];
  return starts[starts.length - 1];
}
