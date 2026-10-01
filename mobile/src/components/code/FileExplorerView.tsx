import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { socketService } from '../../services/socketService';
import { flattenTree, fileIcon, statusLabel, type TreeRow } from '../../utils/fileTree';
import { FilePreviewModal } from './FilePreviewModal';
import { codeStyles as c } from './codeStyles';

/** Lazy project explorer: each folder is fetched from the desktop when first opened. */
export const FileExplorerView: React.FC = () => {
  const [directories, setDirectories] = useState(socketService.directories);
  const [root, setRoot] = useState(socketService.projectRoot);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsub = socketService.subscribe(() => {
      setDirectories(socketService.directories);
      setRoot(socketService.projectRoot);
    });
    if (!socketService.directories['']) socketService.requestDirectory('');
    return unsub;
  }, []);

  // A new project root resets the open folders.
  useEffect(() => setExpanded(new Set()), [root]);

  const rows = useMemo(() => flattenTree(directories, expanded), [directories, expanded]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!socketService.directories[path]) socketService.requestDirectory(path);
      }
      return next;
    });
  };

  const renderRow = ({ item }: { item: TreeRow }) => {
    const indent = { paddingLeft: 12 + item.depth * 16 };
    if (item.kind !== 'entry') {
      return (
        <View style={[c.treeRow, indent]}>
          <Text style={c.treeInfo}>{item.kind === 'loading' ? 'Loading…' : `⚠️ ${item.message}`}</Text>
        </View>
      );
    }
    const { entry, expanded: isOpen } = item;
    const status = statusLabel(entry.status);
    return (
      <TouchableOpacity
        style={[c.treeRow, indent]}
        onPress={() => (entry.isDir ? toggle(entry.path) : socketService.readFile(entry.path))}
        accessibilityLabel={entry.isDir ? `Folder ${entry.name}` : `File ${entry.name}`}
      >
        <Text style={c.treeIcon}>{fileIcon(entry, isOpen)}</Text>
        <Text style={[c.treeName, entry.isDir && c.treeDir]} numberOfLines={1}>
          {entry.name}
        </Text>
        {status && <Text style={[c.treeStatus, { color: status.color }]}>{status.text}</Text>}
      </TouchableOpacity>
    );
  };

  const rootState = directories[''];
  return (
    <View style={{ flex: 1 }}>
      <View style={c.toolbar}>
        <Text style={c.rootLabel} numberOfLines={1}>
          📦 {root ? root.split('/').filter(Boolean).pop() : 'Project'}
        </Text>
        <View style={c.toolbarButtons}>
          {expanded.size > 0 && (
            <TouchableOpacity style={c.iconBtn} onPress={() => setExpanded(new Set())} accessibilityLabel="Collapse all">
              <Text style={c.iconText}>⇱</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={c.iconBtn} onPress={() => socketService.refreshFiles()} accessibilityLabel="Refresh files">
            <Text style={c.iconText}>{rootState?.loading ? '…' : '↻'}</Text>
          </TouchableOpacity>
        </View>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'entry' ? `e:${r.entry.path}` : `${r.kind}:${r.path}`)}
        renderItem={renderRow}
        initialNumToRender={40}
        ListEmptyComponent={
          rootState && !rootState.loading ? (
            <View style={c.emptyCard}>
              <Text style={c.emptySub}>This folder is empty.</Text>
            </View>
          ) : null
        }
      />
      <FilePreviewModal />
    </View>
  );
};
