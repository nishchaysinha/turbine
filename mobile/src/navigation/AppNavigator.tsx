import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import type { ActiveTab } from '../types';
import { TerminalWorkspaceScreen } from '../screens/TerminalWorkspaceScreen';
import { SwarmScreen } from '../screens/SwarmScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { CodeScreen } from '../screens/CodeScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { socketService } from '../services/socketService';
import { onAgentFinished } from '../services/notifier';
import * as Haptics from 'expo-haptics';

interface AppNavigatorProps {
  onDisconnect: () => void;
}

const TABS: { id: ActiveTab; label: string; icon: string }[] = [
  { id: 'workspace', label: 'Workspace', icon: '📟' },
  { id: 'swarm', label: 'Swarm', icon: '🤖' },
  { id: 'tasks', label: 'Tasks', icon: '📋' },
  { id: 'code', label: 'Code', icon: '📁' },
  { id: 'settings', label: 'Control', icon: '⚙️' },
];

export const AppNavigator: React.FC<AppNavigatorProps> = ({ onDisconnect }) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');
  const [reconnecting, setReconnecting] = useState(socketService.reconnecting);
  const [commandError, setCommandError] = useState<string | null>(null);

  useEffect(() => {
    return socketService.subscribe(() => {
      setReconnecting(socketService.reconnecting);
      if (socketService.lastCommandError) {
        setCommandError(socketService.lastCommandError);
        socketService.lastCommandError = null;
      }
    });
  }, []);

  const [agentToast, setAgentToast] = useState<string | null>(null);
  useEffect(
    () =>
      onAgentFinished((e) =>
        setAgentToast(`${e.kind === 'completed' ? '✅' : '⚠️'} ${e.agent.role} ${e.kind === 'completed' ? 'finished' : 'failed'}`)
      ),
    []
  );
  useEffect(() => {
    if (!agentToast) return;
    const t = setTimeout(() => setAgentToast(null), 6000);
    return () => clearTimeout(t);
  }, [agentToast]);

  useEffect(() => {
    if (!commandError) return;
    const t = setTimeout(() => setCommandError(null), 5000);
    return () => clearTimeout(t);
  }, [commandError]);

  const handleTabPress = (tab: ActiveTab) => {
    setActiveTab(tab);
    try {
      Haptics.selectionAsync();
    } catch {}
  };

  const renderActiveScreen = () => {
    switch (activeTab) {
      case 'workspace':
        return <TerminalWorkspaceScreen />;
      case 'swarm':
        return <SwarmScreen />;
      case 'tasks':
        return <TasksScreen />;
      case 'code':
        return <CodeScreen />;
      case 'settings':
        return <SettingsScreen onDisconnect={onDisconnect} />;
      default:
        return <TerminalWorkspaceScreen />;
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {reconnecting && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Connection lost — reconnecting to desktop…</Text>
        </View>
      )}
      {commandError && (
        <TouchableOpacity style={[styles.banner, styles.bannerError]} onPress={() => setCommandError(null)}>
          <Text style={styles.bannerText}>Desktop: {commandError}</Text>
        </TouchableOpacity>
      )}

      {agentToast && (
        <TouchableOpacity
          style={[styles.banner, styles.bannerAgent]}
          onPress={() => {
            setAgentToast(null);
            setActiveTab('swarm');
          }}
        >
          <Text style={styles.bannerText}>{agentToast} — tap to view</Text>
        </TouchableOpacity>
      )}

      {/* Screen Body */}
      <View style={styles.body}>{renderActiveScreen()}</View>

      {/* Bottom Navigation Bar */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={styles.tabButton}
              onPress={() => handleTabPress(tab.id)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabIcon, isActive && styles.tabIconActive]}>
                {tab.icon}
              </Text>
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
  body: {
    flex: 1,
  },
  banner: {
    backgroundColor: '#5a4a00',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  bannerAgent: {
    backgroundColor: '#0b4a43',
  },
  bannerError: {
    backgroundColor: '#5a1a1a',
  },
  bannerText: {
    color: '#fff3c4',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#071524',
    borderTopWidth: 1,
    borderTopColor: '#142d45',
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  tabIcon: {
    fontSize: 18,
    marginBottom: 2,
    opacity: 0.6,
  },
  tabIconActive: {
    opacity: 1,
  },
  tabLabel: {
    fontSize: 10,
    color: '#6e8ba3',
    fontWeight: '500',
  },
  tabLabelActive: {
    color: '#00e5c8',
    fontWeight: '700',
  },
});
