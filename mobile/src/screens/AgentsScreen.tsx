import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { socketService } from '../services/socketService';
import type { AgentStatusRow } from '../services/protocol';
import type { Workspace } from '../types';

const LABELS: Record<string, string> = { working: 'Working', blocked: 'Needs you', waiting: 'Waiting', done: 'Done' };
const COLORS: Record<string, string> = { working: '#00e5c8', blocked: '#ffcb6b', waiting: '#7b96ad', done: '#5af78e' };
const ORDER: Record<string, number> = { blocked: 0, working: 1, done: 2, waiting: 3 };

function elapsed(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Command center on the phone: every agent on the desktop, what it's doing
 * and what it needs — mirrored live from the desktop's agent status hub.
 */
export const AgentsScreen: React.FC<{ onOpenPane: (paneId: string) => void }> = ({ onOpenPane }) => {
  const [rows, setRows] = useState(socketService.agentStatus);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(socketService.workspaces);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsub = socketService.subscribe(() => {
      setRows(socketService.agentStatus);
      setWorkspaces(socketService.workspaces);
    });
    const timer = setInterval(() => setTick((t) => t + 1), 5000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);

  const groups = useMemo(() => {
    const placed = new Set<string>();
    const out = workspaces
      .map((ws) => ({
        key: ws.id,
        name: ws.name,
        items: ws.panes
          .filter((p) => rows[p.id])
          .map((p) => {
            placed.add(p.id);
            return { paneId: p.id, title: p.title || p.label || rows[p.id].agent, row: rows[p.id] };
          }),
      }))
      .filter((g) => g.items.length);
    // Agents whose pane isn't in a workspace (e.g. background swarm agents).
    const orphans = Object.values(rows).filter((r) => !placed.has(r.paneId));
    if (orphans.length) {
      out.push({ key: 'other', name: 'Background', items: orphans.map((r) => ({ paneId: r.paneId, title: r.agent, row: r })) });
    }
    for (const g of out) g.items.sort((a, b) => (ORDER[a.row.state] ?? 9) - (ORDER[b.row.state] ?? 9) || b.row.updatedAt - a.row.updatedAt);
    return out;
  }, [rows, workspaces]);

  const counts = useMemo(() => {
    const all = Object.values(rows);
    return {
      blocked: all.filter((r) => r.state === 'blocked').length,
      working: all.filter((r) => r.state === 'working').length,
    };
  }, [rows]);

  const act = async (row: AgentStatusRow, action: 'approve' | 'deny' | 'interrupt' | 'prompt', text?: string) => {
    setBusy(`${row.paneId}:${action}`);
    try {
      await socketService.agentAction(row.paneId, action, text);
      if (action === 'prompt') setDrafts((d) => ({ ...d, [row.paneId]: '' }));
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
    } catch (e) {
      socketService.lastCommandError = e instanceof Error ? e.message : String(e);
      socketService.notify();
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  const supportsAgents = socketService.supports('agents') || Object.keys(rows).length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Agents</Text>
          <Text style={styles.subtitle}>Live from your desktop</Text>
        </View>
        <View style={styles.counts}>
          {counts.blocked > 0 && <Text style={[styles.count, styles.countBlocked]}>{counts.blocked} need you</Text>}
          {counts.working > 0 && <Text style={[styles.count, styles.countWorking]}>{counts.working} working</Text>}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {groups.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{supportsAgents ? 'No agents reporting' : 'Update Turbine Desktop'}</Text>
            <Text style={styles.emptySub}>
              {supportsAgents
                ? 'Start Claude Code or a swarm run in Turbine. With status hooks installed (Turbine → Agents), they appear here with live status.'
                : 'This desktop version does not report agent status yet.'}
            </Text>
          </View>
        ) : (
          groups.map((g) => (
            <View key={g.key}>
              <Text style={styles.groupName}>{g.name}</Text>
              {g.items.map(({ paneId, title, row }) => {
                const color = COLORS[row.state] ?? '#7b96ad';
                return (
                  <View key={paneId} style={[styles.card, row.state === 'blocked' && styles.cardBlocked]}>
                    <TouchableOpacity style={styles.cardHead} onPress={() => onOpenPane(paneId)} accessibilityLabel={`Open ${title}`}>
                      <View style={[styles.chip, { borderColor: color }]}>
                        <View style={[styles.chipDot, { backgroundColor: color }]} />
                        <Text style={[styles.chipText, { color }]}>{LABELS[row.state] ?? row.state}</Text>
                      </View>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {title}
                      </Text>
                      <Text style={styles.time}>{elapsed(row.state === 'working' ? row.startedAt : row.updatedAt, now)}</Text>
                    </TouchableOpacity>
                    {row.prompt ? (
                      <Text style={styles.prompt} numberOfLines={3}>
                        {row.prompt}
                      </Text>
                    ) : null}
                    {row.state === 'working' && row.tool ? (
                      <Text style={styles.tool} numberOfLines={1}>
                        <Text style={styles.toolName}>{row.tool}</Text> {row.toolInput ?? ''}
                      </Text>
                    ) : null}
                    {row.message && row.state !== 'working' ? (
                      <Text style={styles.message} numberOfLines={4}>
                        {row.message}
                      </Text>
                    ) : null}
                    {row.exitCode !== null && row.exitCode !== undefined ? (
                      <Text style={[styles.message, row.exitCode !== 0 && { color: '#ff7b76' }]}>Exited with code {row.exitCode}</Text>
                    ) : null}

                    <View style={styles.actions}>
                      {row.state === 'blocked' && (
                        <>
                          <TouchableOpacity
                            style={[styles.btn, styles.btnPrimary]}
                            onPress={() => act(row, 'approve')}
                            disabled={busy !== null}
                            accessibilityLabel={`Approve ${title}`}
                          >
                            <Text style={styles.btnPrimaryText}>Approve</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.btn} onPress={() => act(row, 'deny')} disabled={busy !== null} accessibilityLabel={`Deny ${title}`}>
                            <Text style={styles.btnText}>Deny</Text>
                          </TouchableOpacity>
                        </>
                      )}
                      {row.state === 'working' && (
                        <TouchableOpacity style={styles.btn} onPress={() => act(row, 'interrupt')} disabled={busy !== null} accessibilityLabel={`Interrupt ${title}`}>
                          <Text style={styles.btnText}>Interrupt</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity style={styles.btn} onPress={() => onOpenPane(paneId)}>
                        <Text style={styles.btnText}>Terminal</Text>
                      </TouchableOpacity>
                    </View>

                    {(row.state === 'waiting' || row.state === 'done') && (row.exitCode === null || row.exitCode === undefined) && (
                      <View style={styles.reply}>
                        <TextInput
                          style={styles.replyInput}
                          value={drafts[paneId] ?? ''}
                          onChangeText={(t) => setDrafts((d) => ({ ...d, [paneId]: t }))}
                          placeholder="Reply to agent…"
                          placeholderTextColor="#4a657e"
                          returnKeyType="send"
                          onSubmitEditing={() => drafts[paneId]?.trim() && act(row, 'prompt', drafts[paneId])}
                        />
                        <TouchableOpacity
                          style={[styles.btn, styles.btnPrimary]}
                          onPress={() => drafts[paneId]?.trim() && act(row, 'prompt', drafts[paneId])}
                          accessibilityLabel={`Send reply to ${title}`}
                        >
                          <Text style={styles.btnPrimaryText}>Send</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050c16' },
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
  title: { color: '#00e5c8', fontSize: 16, fontWeight: '700' },
  subtitle: { color: '#7b96ad', fontSize: 11, marginTop: 2 },
  counts: { flexDirection: 'row', gap: 6 },
  count: { fontSize: 11, fontWeight: '800', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, overflow: 'hidden' },
  countBlocked: { backgroundColor: '#ffcb6b', color: '#1a1300' },
  countWorking: { color: '#00e5c8', borderWidth: 1, borderColor: '#00e5c8' },
  list: { padding: 12, paddingBottom: 30 },
  groupName: { color: '#7f9db8', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', marginTop: 6, marginBottom: 6, letterSpacing: 0.5 },
  card: { backgroundColor: '#081626', borderRadius: 10, borderWidth: 1, borderColor: '#173654', padding: 12, marginBottom: 10, gap: 6 },
  cardBlocked: { borderColor: '#ffcb6b' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: 10, fontWeight: '800' },
  cardTitle: { flex: 1, color: '#d6e6f5', fontSize: 14, fontWeight: '700' },
  time: { color: '#5c768d', fontSize: 11 },
  prompt: { color: '#c4d8ea', fontSize: 13, lineHeight: 18 },
  tool: { color: '#7f9db8', fontSize: 12, fontFamily: 'Courier' },
  toolName: { color: '#00e5c8', fontWeight: '700' },
  message: { color: '#9cb5cc', fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 },
  btn: { borderWidth: 1, borderColor: '#1d3e5f', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  btnText: { color: '#d0e2f2', fontSize: 13, fontWeight: '600' },
  btnPrimary: { backgroundColor: '#00e5c8', borderColor: '#00e5c8' },
  btnPrimaryText: { color: '#05111c', fontSize: 13, fontWeight: '800' },
  reply: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  replyInput: {
    flex: 1,
    backgroundColor: '#050c16',
    borderWidth: 1,
    borderColor: '#193959',
    borderRadius: 8,
    color: '#f0f6fc',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  empty: { padding: 24, alignItems: 'center' },
  emptyTitle: { color: '#d6e6f5', fontSize: 15, fontWeight: '700', marginBottom: 6 },
  emptySub: { color: '#7b96ad', fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
