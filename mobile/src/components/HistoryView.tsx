import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, SectionList, RefreshControl, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { socketService } from '../services/socketService';
import { filterRuns, groupRunsByDay, runDuration, type HistoryRun } from '../utils/history';

const STATUS_COLORS: Record<string, string> = {
  Completed: '#5af78e',
  Failed: '#ff5c57',
  Running: '#00e5c8',
  Reviewing: '#57c7ff',
  Paused: '#ffcb6b',
  Initializing: '#00e5c8',
};

/** Past swarm runs for the focused project: search, grouped by day, one-tap re-run (Orca's agent history). */
export const HistoryView: React.FC<{ onRerun?: () => void }> = ({ onRerun }) => {
  const [runs, setRuns] = useState<HistoryRun[]>(socketService.history);
  const [loading, setLoading] = useState(socketService.historyLoading);
  const [error, setError] = useState(socketService.historyError);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = socketService.subscribe(() => {
      setRuns(socketService.history);
      setLoading(socketService.historyLoading);
      setError(socketService.historyError);
    });
    socketService.requestHistory();
    return unsub;
  }, []);

  const sections = useMemo(() => groupRunsByDay(filterRuns(runs, query)), [runs, query]);

  const rerun = (run: HistoryRun) => {
    if (!run.prompt) return;
    const presetId = (run.agents[0] as { preset_id?: string | null } | undefined)?.preset_id ?? undefined;
    socketService.triggerSwarm(run.prompt, presetId || undefined);
    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {}
    onRerun?.();
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search prompts, agents, summaries"
          placeholderTextColor="#4a657e"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => socketService.requestHistory()} tintColor="#00e5c8" />}
        stickySectionHeadersEnabled
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.label}</Text>}
        contentContainerStyle={{ paddingBottom: 20 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {error ? `⚠️ ${error}` : loading ? 'Loading history…' : query ? 'No runs match your search.' : 'No past runs for this project yet.'}
            </Text>
          </View>
        }
        renderItem={({ item: run }) => {
          const open = expandedId === run.id;
          const time = run.started_at ? new Date(run.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          const duration = runDuration(run);
          const color = STATUS_COLORS[run.status] ?? '#9cb5cc';
          const summaries = run.agents.filter((a) => a.output_summary);
          return (
            <TouchableOpacity style={styles.card} activeOpacity={0.8} onPress={() => setExpandedId(open ? null : run.id)}>
              <View style={styles.cardTop}>
                <Text style={[styles.status, { color, borderColor: color }]}>{run.status}</Text>
                <Text style={styles.meta}>
                  {time}
                  {duration ? ` · ${duration}` : ''}
                </Text>
              </View>
              <Text style={styles.prompt} numberOfLines={open ? undefined : 2}>
                {run.prompt || 'Ad-hoc run'}
              </Text>
              <View style={styles.agentRow}>
                {run.agents.map((a) => (
                  <Text key={a.id} style={styles.agentChip}>
                    {a.status === 'completed' ? '✓' : a.status === 'failed' ? '✗' : '•'} {a.role}
                  </Text>
                ))}
              </View>
              {open &&
                summaries.map((a) => (
                  <Text key={a.id} style={styles.summary}>
                    <Text style={styles.summaryRole}>{a.role}: </Text>
                    {a.output_summary}
                  </Text>
                ))}
              {!open && summaries[0] && (
                <Text style={styles.summary} numberOfLines={1}>
                  {summaries[0].output_summary}
                </Text>
              )}
              {run.prompt ? (
                <TouchableOpacity style={styles.rerun} onPress={() => rerun(run)} accessibilityLabel={`Re-run ${run.prompt}`}>
                  <Text style={styles.rerunText}>↻ Re-run</Text>
                </TouchableOpacity>
              ) : null}
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  searchWrap: { padding: 10, backgroundColor: '#081422', borderBottomWidth: 1, borderBottomColor: '#13283c' },
  search: {
    backgroundColor: '#050c16',
    borderWidth: 1,
    borderColor: '#193959',
    borderRadius: 10,
    color: '#f0f6fc',
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  sectionHeader: {
    color: '#7f9db8',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#050c16',
  },
  card: {
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#173654',
    backgroundColor: '#081626',
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  status: { fontSize: 10, fontWeight: '800', borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  meta: { color: '#5c768d', fontSize: 11 },
  prompt: { color: '#d6e6f5', fontSize: 13, lineHeight: 18 },
  agentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  agentChip: {
    color: '#9cb5cc',
    fontSize: 11,
    backgroundColor: '#0e2338',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  summary: { color: '#7f9db8', fontSize: 12, marginTop: 6 },
  summaryRole: { color: '#9cb5cc', fontWeight: '700' },
  rerun: {
    alignSelf: 'flex-end',
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#00e5c8',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  rerunText: { color: '#00e5c8', fontSize: 12, fontWeight: '700' },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7b96ad', fontSize: 13, textAlign: 'center' },
});
