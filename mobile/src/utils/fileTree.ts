/** Lazy file-tree projection: directories are fetched one level at a time as they're expanded. */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  status?: string;
}

export interface DirectoryState {
  entries: FileEntry[];
  loading?: boolean;
  error?: string;
}

export type DirectoryCache = Record<string, DirectoryState | undefined>;

export type TreeRow =
  | { kind: 'entry'; entry: FileEntry; depth: number; expanded: boolean }
  | { kind: 'loading' | 'error'; path: string; depth: number; message?: string };

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export function flattenTree(cache: DirectoryCache, expanded: ReadonlySet<string>, dir = '', depth = 0): TreeRow[] {
  const state = cache[dir];
  if (!state) return [];
  if (state.error) return [{ kind: 'error', path: dir, depth, message: state.error }];
  if (state.loading && state.entries.length === 0) return [{ kind: 'loading', path: dir, depth }];

  const rows: TreeRow[] = [];
  for (const entry of [...state.entries].sort(compareEntries)) {
    const isOpen = entry.isDir && expanded.has(entry.path);
    rows.push({ kind: 'entry', entry, depth, expanded: isOpen });
    if (isOpen) {
      const child = cache[entry.path];
      if (!child) rows.push({ kind: 'loading', path: entry.path, depth: depth + 1 });
      else rows.push(...flattenTree(cache, expanded, entry.path, depth + 1));
    }
  }
  return rows;
}

export function fileIcon(entry: FileEntry, expanded: boolean): string {
  if (entry.isDir) return expanded ? '📂' : '📁';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return '🟦';
  if (['md', 'mdx', 'txt'].includes(ext)) return '📝';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '⚙️';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['rs', 'go', 'py', 'rb', 'java', 'kt', 'swift', 'c', 'cpp', 'h'].includes(ext)) return '🟧';
  return '📄';
}

export function statusLabel(status?: string): { text: string; color: string } | null {
  if (!status) return null;
  if (status === '??' || status.includes('A')) return { text: status === '??' ? 'U' : 'A', color: '#5af78e' };
  if (status.includes('D')) return { text: 'D', color: '#ff5c57' };
  if (status.includes('R')) return { text: 'R', color: '#57c7ff' };
  return { text: 'M', color: '#ffcb6b' };
}
