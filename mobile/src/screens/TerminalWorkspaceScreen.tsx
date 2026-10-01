import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { socketService } from '../services/socketService';
import { TiledWorkspaceView } from '../components/TiledWorkspaceView';
import { FocusedTerminalView } from '../components/FocusedTerminalView';

export const TerminalWorkspaceScreen: React.FC = () => {
  const [workspaces, setWorkspaces] = useState(socketService.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(socketService.activeWorkspaceId);
  const [focusedPaneId, setFocusedPaneIdState] = useState<string | null>(null);
  const [, setOutputTick] = useState(0);

  useEffect(() => {
    const unsub = socketService.subscribe(() => {
      setWorkspaces(socketService.workspaces);
      setActiveWorkspaceId(socketService.activeWorkspaceId);
    });
    // Re-render the tiled previews when output arrives, at most ~3x/second.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setOutputTick((t) => t + 1);
      }, 300);
    };
    const unsubOutput = socketService.onTerminalOutput(bump);
    const unsubSync = socketService.onTerminalSync(bump);
    return () => {
      unsub();
      unsubOutput();
      unsubSync();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const setFocusedPaneId = (paneId: string | null) => {
    setFocusedPaneIdState(paneId);
    // Tell the desktop which pane we're driving (also scopes diffs/tasks to its project).
    socketService.setFocusedPane(paneId);
  };

  // Opened from the Agents tab: jump to that pane (switching workspace if needed).
  useEffect(() => {
    const target = socketService.pendingFocusPaneId;
    if (!target) return;
    socketService.pendingFocusPaneId = null;
    const ws = socketService.workspaces.find((w) => w.panes.some((p) => p.id === target));
    if (ws && ws.id !== socketService.activeWorkspaceId) socketService.switchWorkspace(ws.id);
    setFocusedPaneId(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0];

  const focusedPane = activeWorkspace?.panes.find((p) => p.id === focusedPaneId);

  // Only stream what's on screen: the focused pane, or the tiles of this workspace.
  const visiblePaneIds = focusedPane
    ? [focusedPane.id]
    : (activeWorkspace?.panes ?? []).filter((p) => p.type === 'terminal' || p.id.startsWith('swarm-')).map((p) => p.id);
  const visibleKey = visiblePaneIds.join('|');
  useEffect(() => {
    socketService.subscribeTerminals(visibleKey ? visibleKey.split('|') : []);
  }, [visibleKey]);
  useEffect(() => () => socketService.subscribeTerminals([]), []);

  if (!activeWorkspace) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No Active Workspace</Text>
        <Text style={styles.emptySub}>
          Connect to Turbine Desktop or create a workspace on your computer.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Workspace Tabs Header */}
      {workspaces.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsContainer}
          contentContainerStyle={styles.tabsContent}
        >
          {workspaces.map((ws) => (
            <TouchableOpacity
              key={ws.id}
              style={[
                styles.tabItem,
                ws.id === activeWorkspace.id && styles.tabItemActive,
              ]}
              onPress={() => {
                socketService.switchWorkspace(ws.id);
                setFocusedPaneId(null);
              }}
            >
              <View
                style={[
                  styles.tabDot,
                  { backgroundColor: ws.tabColor || '#00e5c8' },
                ]}
              />
              <Text
                style={[
                  styles.tabText,
                  ws.id === activeWorkspace.id && styles.tabTextActive,
                ]}
              >
                {ws.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Main Content: Focused Terminal vs Tiled Desktop View */}
      {focusedPane ? (
        <FocusedTerminalView
          pane={focusedPane}
          allPanes={activeWorkspace.panes}
          onUnfocus={() => setFocusedPaneId(null)}
          onSwitchPane={(paneId) => setFocusedPaneId(paneId)}
        />
      ) : (
        <TiledWorkspaceView
          layout={activeWorkspace.layout}
          panes={activeWorkspace.panes}
          onSelectPane={(paneId) => setFocusedPaneId(paneId)}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
  tabsContainer: {
    backgroundColor: '#081422',
    borderBottomWidth: 1,
    borderBottomColor: '#142d45',
    maxHeight: 38,
  },
  tabsContent: {
    paddingHorizontal: 8,
    gap: 6,
    alignItems: 'center',
  },
  tabItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  tabItemActive: {
    backgroundColor: '#0e243a',
  },
  tabDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  tabText: {
    color: '#8ba4ba',
    fontSize: 12,
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#d6e8f7',
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#050c16',
  },
  emptyTitle: {
    color: '#00e5c8',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySub: {
    color: '#7b95ab',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});
