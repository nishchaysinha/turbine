import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { socketService } from '../services/socketService';
import * as Haptics from 'expo-haptics';

const MAX_LINES = 5000;

export const DiffsScreen: React.FC = () => {
  const [diff, setDiff] = useState(socketService.gitDiff);
  const [error, setError] = useState(socketService.gitDiffError);
  const [isRefreshing, setIsRefreshing] = useState(true);

  useEffect(() => {
    let seenVersion = socketService.gitDiffVersion;
    const unsub = socketService.subscribe(() => {
      // Only a new diff:data response ends the refresh (pings also notify).
      if (socketService.gitDiffVersion === seenVersion) return;
      seenVersion = socketService.gitDiffVersion;
      setDiff(socketService.gitDiff);
      setError(socketService.gitDiffError);
      setIsRefreshing(false);
    });
    socketService.requestDiff('.');
    const timeout = setTimeout(() => setIsRefreshing(false), 15000);
    return () => {
      unsub();
      clearTimeout(timeout);
    };
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    socketService.requestDiff('.');
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  };

  const allLines = (diff || '').split('\n');
  const truncated = allLines.length > MAX_LINES;
  const lines = truncated ? allLines.slice(0, MAX_LINES) : allLines;

  const renderLine = useCallback(({ item: line }: { item: string }) => {
    const isAdd = line.startsWith('+') && !line.startsWith('+++');
    const isDel = line.startsWith('-') && !line.startsWith('---');
    const isHeader = line.startsWith('diff --git') || line.startsWith('index ');
    const isChunk = line.startsWith('@@');

    return (
      <View style={[styles.diffLine, isAdd && styles.addLine, isDel && styles.delLine, isHeader && styles.headerLine]}>
        <Text
          style={[
            styles.diffText,
            isAdd && styles.addText,
            isDel && styles.delText,
            isChunk && styles.chunkText,
            isHeader && styles.headerText,
          ]}
        >
          {line || ' '}
        </Text>
      </View>
    );
  }, []);

  const empty = error ? (
    <View style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>Couldn't load diff</Text>
      <Text style={styles.emptySub}>{error}</Text>
    </View>
  ) : isRefreshing ? (
    <View style={styles.emptyCard}>
      <Text style={styles.emptySub}>Loading changes from desktop…</Text>
    </View>
  ) : (
    <View style={styles.emptyCard}>
      <Text style={styles.emptyTitle}>Working Tree Clean</Text>
      <Text style={styles.emptySub}>No uncommitted git changes in the active project.</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Git Changes</Text>
          <Text style={styles.subtitle}>Live diff of the focused project on desktop</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={handleRefresh} disabled={isRefreshing}>
          <Text style={styles.refreshText}>{isRefreshing ? 'Loading...' : '↻ Refresh'}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        style={styles.diffView}
        contentContainerStyle={styles.diffContent}
        data={diff ? lines : []}
        keyExtractor={(_, idx) => String(idx)}
        renderItem={renderLine}
        ListEmptyComponent={empty}
        ListFooterComponent={
          truncated ? (
            <Text style={styles.emptySub}>… {allLines.length - MAX_LINES} more lines (view on desktop)</Text>
          ) : null
        }
        initialNumToRender={60}
        windowSize={11}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#091829',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#173654',
  },
  title: {
    color: '#00e5c8',
    fontSize: 16,
    fontWeight: '700',
  },
  subtitle: {
    color: '#7b96ad',
    fontSize: 11,
    marginTop: 2,
  },
  refreshBtn: {
    backgroundColor: '#0e253c',
    borderWidth: 1,
    borderColor: '#1d4369',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  refreshText: {
    color: '#00e5c8',
    fontSize: 12,
    fontWeight: '600',
  },
  diffView: {
    flex: 1,
  },
  diffContent: {
    paddingVertical: 8,
  },
  diffLine: {
    paddingHorizontal: 12,
    paddingVertical: 1,
  },
  addLine: {
    backgroundColor: 'rgba(76, 175, 80, 0.15)',
  },
  delLine: {
    backgroundColor: 'rgba(255, 82, 82, 0.15)',
  },
  headerLine: {
    backgroundColor: '#0b1d30',
    marginTop: 8,
    paddingVertical: 4,
  },
  diffText: {
    fontFamily: 'Courier',
    fontSize: 11,
    color: '#c4d8ea',
    lineHeight: 16,
  },
  addText: {
    color: '#81c784',
  },
  delText: {
    color: '#ff6b6b',
  },
  chunkText: {
    color: '#64b5f6',
    fontWeight: '700',
  },
  headerText: {
    color: '#00e5c8',
    fontWeight: '700',
  },
  emptyCard: {
    backgroundColor: '#081626',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#183654',
    padding: 24,
    alignItems: 'center',
    margin: 16,
    marginTop: 40,
  },
  emptyTitle: {
    color: '#d2e4f2',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySub: {
    color: '#718c9e',
    fontSize: 12,
  },
});
