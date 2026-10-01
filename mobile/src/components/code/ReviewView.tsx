import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, type ViewToken } from 'react-native';
import * as Haptics from 'expo-haptics';
import { socketService } from '../../services/socketService';
import { reviewNotes } from '../../services/reviewNotes';
import { parseUnifiedDiff, nextIndex, type DiffFile, type DiffLine } from '../../utils/diff';
import type { ReviewNote } from '../../utils/review';
import { CommentSheet, type CommentTarget } from './CommentSheet';
import { SendReviewSheet } from './SendReviewSheet';
import { codeStyles as c } from './codeStyles';

type Row =
  | { type: 'file'; key: string; file: DiffFile }
  | { type: 'line'; key: string; file: DiffFile; line: DiffLine }
  | { type: 'note'; key: string; note: ReviewNote };

function noteAnchor(filePath: string, line: DiffLine): { lineNumber: number; side: 'new' | 'old' } | null {
  if (line.kind === 'add' || line.kind === 'ctx') return { lineNumber: line.newNo!, side: 'new' };
  if (line.kind === 'del') return { lineNumber: line.oldNo!, side: 'old' };
  return null;
}

/**
 * Orca-style diff review: per-file diffs, tap any line to leave a note,
 * jump between changes, then send all notes to an agent as one prompt.
 */
export const ReviewView: React.FC = () => {
  const [diff, setDiff] = useState(socketService.gitDiff);
  const [error, setError] = useState(socketService.gitDiffError);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<ReviewNote[]>(reviewNotes.get());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  const topIndex = useRef(0);
  const lastJumpAt = useRef(0);

  useEffect(() => {
    reviewNotes.load();
    const unsubNotes = reviewNotes.subscribe(setNotes);
    let seen = socketService.gitDiffVersion;
    const unsub = socketService.subscribe(() => {
      if (socketService.gitDiffVersion === seen) return;
      seen = socketService.gitDiffVersion;
      setDiff(socketService.gitDiff);
      setError(socketService.gitDiffError);
      setLoading(false);
    });
    socketService.requestDiff('.');
    const timeout = setTimeout(() => setLoading(false), 15000);
    return () => {
      unsub();
      unsubNotes();
      clearTimeout(timeout);
    };
  }, []);

  const files = useMemo(() => parseUnifiedDiff(diff || ''), [diff]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const file of files) {
      out.push({ type: 'file', key: `f:${file.path}`, file });
      if (collapsed.has(file.path)) continue;
      const fileNotes = notes.filter((n) => n.filePath === file.path);
      fileNotes
        .filter((n) => n.lineNumber === 0)
        .forEach((note) => out.push({ type: 'note', key: `n:${note.id}`, note }));
      file.lines.forEach((line, i) => {
        out.push({ type: 'line', key: `l:${file.path}:${i}`, file, line });
        const anchor = noteAnchor(file.path, line);
        if (!anchor) return;
        fileNotes
          .filter((n) => n.lineNumber === anchor.lineNumber && n.side === anchor.side)
          .forEach((note) => out.push({ type: 'note', key: `n:${note.id}`, note }));
      });
    }
    return out;
  }, [files, collapsed, notes]);

  const changeStarts = useMemo(
    () =>
      rows.flatMap((r, i) => {
        if (r.type !== 'line' || (r.line.kind !== 'add' && r.line.kind !== 'del')) return [];
        const prev = rows[i - 1];
        const prevChanged = prev?.type === 'line' && (prev.line.kind === 'add' || prev.line.kind === 'del');
        return prevChanged ? [] : [i];
      }),
    [rows]
  );

  const totals = useMemo(
    () => files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 }),
    [files]
  );

  const jump = (direction: 1 | -1) => {
    const idx = nextIndex(changeStarts, topIndex.current, direction);
    if (idx === null) return;
    topIndex.current = idx;
    lastJumpAt.current = Date.now();
    try {
      Haptics.selectionAsync();
    } catch {}
    listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.15, animated: true });
  };

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    // Ignore the scroll a jump itself causes, or ▼ would land on the same change again.
    if (Date.now() - lastJumpAt.current < 1000) return;
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index !== undefined && first.index !== null) topIndex.current = first.index;
  }).current;

  const toggleFile = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const refresh = () => {
    setLoading(true);
    socketService.requestDiff('.');
  };

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.type === 'file') {
        const f = item.file;
        const isCollapsed = collapsed.has(f.path);
        const count = notes.filter((n) => n.filePath === f.path).length;
        return (
          <TouchableOpacity style={c.fileHeader} onPress={() => toggleFile(f.path)} onLongPress={() => setTarget({ filePath: f.path, lineNumber: 0, side: 'new', lineText: '' })}>
            <Text style={c.chevron}>{isCollapsed ? '▸' : '▾'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={c.filePath} numberOfLines={1}>
                {f.path}
              </Text>
              {f.oldPath ? <Text style={c.fileMeta}>renamed from {f.oldPath}</Text> : null}
            </View>
            {f.status !== 'modified' && <Text style={c.fileBadge}>{f.status}</Text>}
            {count > 0 && <Text style={c.noteCount}>💬 {count}</Text>}
            <Text style={c.addCount}>+{f.additions}</Text>
            <Text style={c.delCount}>−{f.deletions}</Text>
          </TouchableOpacity>
        );
      }
      if (item.type === 'note') {
        const n = item.note;
        return (
          <TouchableOpacity
            style={c.noteBubble}
            onPress={() => setTarget({ filePath: n.filePath, lineNumber: n.lineNumber, side: n.side, lineText: n.lineText, note: n })}
          >
            <Text style={c.noteAuthor}>💬 Your note{n.lineNumber === 0 ? ' on this file' : ''}</Text>
            <Text style={c.noteBody}>{n.body}</Text>
          </TouchableOpacity>
        );
      }
      const { line, file } = item;
      if (line.kind === 'hunk' || line.kind === 'meta') {
        return (
          <View style={c.hunkRow}>
            <Text style={c.hunkText} numberOfLines={1}>
              {line.text}
            </Text>
          </View>
        );
      }
      const anchor = noteAnchor(file.path, line)!;
      return (
        <TouchableOpacity
          activeOpacity={0.6}
          style={[c.lineRow, line.kind === 'add' && c.addRow, line.kind === 'del' && c.delRow]}
          onPress={() => setTarget({ filePath: file.path, ...anchor, lineText: line.text })}
          accessibilityLabel={`Comment on ${file.path} line ${anchor.lineNumber}${anchor.side === 'old' ? ' (removed)' : ''}`}
        >
          <Text style={c.lineNo}>{line.oldNo ?? ''}</Text>
          <Text style={c.lineNo}>{line.newNo ?? ''}</Text>
          <Text style={[c.sign, line.kind === 'add' && c.addText, line.kind === 'del' && c.delText]}>
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
          </Text>
          <Text style={[c.code, line.kind === 'add' && c.addText, line.kind === 'del' && c.delText]}>{line.text || ' '}</Text>
        </TouchableOpacity>
      );
    },
    [collapsed, notes]
  );

  const empty = error ? (
    <View style={c.emptyCard}>
      <Text style={c.emptyTitle}>Couldn't load diff</Text>
      <Text style={c.emptySub}>{error}</Text>
    </View>
  ) : loading ? (
    <View style={c.emptyCard}>
      <Text style={c.emptySub}>Loading changes from desktop…</Text>
    </View>
  ) : (
    <View style={c.emptyCard}>
      <Text style={c.emptyTitle}>Working tree clean</Text>
      <Text style={c.emptySub}>No uncommitted changes in the focused project.</Text>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={c.toolbar}>
        <Text style={c.summary}>
          {files.length} {files.length === 1 ? 'file' : 'files'} · <Text style={c.addText}>+{totals.add}</Text>{' '}
          <Text style={c.delText}>−{totals.del}</Text>
        </Text>
        <View style={c.toolbarButtons}>
          <TouchableOpacity style={c.iconBtn} onPress={() => jump(-1)} accessibilityLabel="Previous change">
            <Text style={c.iconText}>▲</Text>
          </TouchableOpacity>
          <TouchableOpacity style={c.iconBtn} onPress={() => jump(1)} accessibilityLabel="Next change">
            <Text style={c.iconText}>▼</Text>
          </TouchableOpacity>
          <TouchableOpacity style={c.iconBtn} onPress={refresh} disabled={loading} accessibilityLabel="Refresh diff">
            <Text style={c.iconText}>{loading ? '…' : '↻'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={diff ? rows : []}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        ListEmptyComponent={empty}
        initialNumToRender={80}
        windowSize={15}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.15 }), 80);
        }}
        contentContainerStyle={{ paddingBottom: notes.length ? 80 : 16 }}
      />

      {notes.length > 0 && (
        <View style={c.sendBar}>
          <Text style={c.sendBarText}>
            {notes.length} review {notes.length === 1 ? 'note' : 'notes'}
          </Text>
          <TouchableOpacity style={c.sendBtn} onPress={() => setSending(true)}>
            <Text style={c.sendBtnText}>Send to agent →</Text>
          </TouchableOpacity>
        </View>
      )}

      <CommentSheet target={target} onClose={() => setTarget(null)} />
      <SendReviewSheet visible={sending} notes={notes} onClose={() => setSending(false)} />
    </View>
  );
};
