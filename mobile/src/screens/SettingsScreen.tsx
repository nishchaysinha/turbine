import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { socketService } from '../services/socketService';
import type { Workspace } from '../types';
import { ConnectionLog } from '../components/ConnectionLog';

interface SettingsScreenProps {
  onDisconnect: () => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ onDisconnect }) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(socketService.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(socketService.activeWorkspaceId);
  const [latencyMs, setLatencyMs] = useState(socketService.latencyMs);
  const [status, setStatus] = useState(socketService.getStatus());

  useEffect(() => {
    const unsub = socketService.subscribe(() => {
      setWorkspaces(socketService.workspaces);
      setActiveWorkspaceId(socketService.activeWorkspaceId);
      setLatencyMs(socketService.latencyMs);
      setStatus(socketService.getStatus());
    });
    return unsub;
  }, []);

  const handleSwitchWorkspace = (wsId: string) => {
    socketService.switchWorkspace(wsId);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Companion Controls</Text>
        <Text style={styles.subtitle}>Session & workspace management</Text>
      </View>

      {/* Connection Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Connection Info</Text>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Status:</Text>
          <View style={[styles.statusPill, status !== 'connected' && styles.statusPillWarn]}>
            <View style={[styles.statusDot, status !== 'connected' && styles.statusDotWarn]} />
            <Text style={[styles.statusText, status !== 'connected' && styles.statusTextWarn]}>
              {status !== 'connected' ? 'Reconnecting…' : socketService.lanTarget ? 'Local network' : 'Direct P2P (DTLS)'}
            </Text>
          </View>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Latency:</Text>
          <Text style={styles.infoValue}>{status !== 'connected' ? '—' : latencyMs !== null ? `⚡ ${latencyMs}ms` : 'measuring…'}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Protocol:</Text>
          <Text style={styles.infoValue}>
            {socketService.hostProtocol === null
              ? 'negotiating…'
              : socketService.hostProtocol >= 2
                ? `v${socketService.hostProtocol} (${[...socketService.hostCapabilities].join(', ')})`
                : 'v1 (legacy desktop)'}
          </Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>{socketService.lanTarget ? 'Address:' : 'Pairing code:'}</Text>
          <Text style={styles.infoValue}>
            {socketService.lanTarget ? socketService.lanTarget.url.replace(/^wss?:\/\//, '') : socketService.pairingCode}
          </Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Signaling:</Text>
          <Text style={styles.infoValue} numberOfLines={1}>
            {socketService.currentServerUrl.replace(/^https?:\/\//, '')}
          </Text>
        </View>
      </View>

      {/* Workspace Switcher */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Desktop Workspaces</Text>
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          return (
            <TouchableOpacity
              key={ws.id}
              style={[styles.wsRow, isActive && styles.wsRowActive]}
              onPress={() => handleSwitchWorkspace(ws.id)}
            >
              <View
                style={[
                  styles.wsDot,
                  { backgroundColor: ws.tabColor || '#00e5c8' },
                ]}
              />
              <View style={styles.wsInfo}>
                <Text style={[styles.wsName, isActive && styles.wsNameActive]}>
                  {ws.name}
                </Text>
                <Text style={styles.wsPanes}>{ws.panes.length} {ws.panes.length === 1 ? 'pane' : 'panes'}</Text>
              </View>
              {isActive && <Text style={styles.activeCheck}>✓ Active</Text>}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Troubleshooting */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Connection log</Text>
        <ConnectionLog limit={15} />
      </View>

      {/* Disconnect Button */}
      <TouchableOpacity style={styles.disconnectBtn} onPress={onDisconnect}>
        <Text style={styles.disconnectText}>Disconnect Session</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
  content: {
    padding: 16,
    gap: 16,
  },
  header: {
    marginBottom: 8,
  },
  title: {
    color: '#00e5c8',
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: '#7b96ad',
    fontSize: 12,
    marginTop: 2,
  },
  card: {
    backgroundColor: '#081626',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#183654',
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    color: '#d6e6f5',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoLabel: {
    color: '#7f9db8',
    fontSize: 13,
  },
  infoValue: {
    flexShrink: 1,
    marginLeft: 12,
    color: '#c4d8ea',
    fontSize: 12,
    fontFamily: 'Courier',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0, 229, 200, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusPillWarn: {
    backgroundColor: 'rgba(255, 203, 107, 0.15)',
  },
  statusDotWarn: {
    backgroundColor: '#ffcb6b',
  },
  statusTextWarn: {
    color: '#ffcb6b',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00e5c8',
  },
  statusText: {
    color: '#00e5c8',
    fontSize: 11,
    fontWeight: '600',
  },
  wsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  wsRowActive: {
    backgroundColor: '#0c2238',
    borderColor: '#1d466e',
  },
  wsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  wsInfo: {
    flex: 1,
  },
  wsName: {
    color: '#b0c7db',
    fontSize: 13,
    fontWeight: '500',
  },
  wsNameActive: {
    color: '#00e5c8',
    fontWeight: '700',
  },
  wsPanes: {
    color: '#658299',
    fontSize: 11,
  },
  activeCheck: {
    color: '#00e5c8',
    fontSize: 12,
    fontWeight: '700',
  },
  disconnectBtn: {
    backgroundColor: 'rgba(255, 82, 82, 0.15)',
    borderWidth: 1,
    borderColor: '#ff5252',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  disconnectText: {
    color: '#ff6b6b',
    fontSize: 14,
    fontWeight: '700',
  },
});
