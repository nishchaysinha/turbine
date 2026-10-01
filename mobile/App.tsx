import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet } from 'react-native';
import { socketService } from './src/services/socketService';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { AppNavigator } from './src/navigation/AppNavigator';
import { WebRTCBridgeView } from './src/services/WebRTCBridgeView';
import { startAgentNotifier } from './src/services/notifier';

/** Stay on the main UI while connected or while silently reconnecting. */
function isSessionActive(): boolean {
  return socketService.getStatus() === 'connected' || socketService.reconnecting;
}

export default function App() {
  const [isConnected, setIsConnected] = useState(isSessionActive());

  useEffect(() => {
    startAgentNotifier();
    return socketService.subscribe(() => setIsConnected(isSessionActive()));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <WebRTCBridgeView
        onStatusChange={(status, latency) => socketService.setStatus(status, latency)}
        onMessage={(msg) => socketService.handleMessage(msg)}
        onError={(err) => socketService.setErrorMessage(err)}
      />
      {isConnected ? (
        <AppNavigator onDisconnect={() => socketService.disconnect()} />
      ) : (
        <ConnectScreen />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
});
