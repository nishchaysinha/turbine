import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { socketService, DEFAULT_SIGNALING_URL } from '../services/socketService';
import { normalizeLanUrl, normalizePairingCode, normalizeSignalingUrl, parseLanPayload, parsePairingPayload, type LanTarget } from '../utils/pairing';
import { loadSavedHosts, rememberHost, forgetHost, type SavedHost } from '../services/savedHosts';
import { QrScannerModal } from '../components/QrScannerModal';
import { ConnectionLog } from '../components/ConnectionLog';
import * as Haptics from 'expo-haptics';

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export const ConnectScreen: React.FC = () => {
  // Pre-fill from the previous session so reconnecting is one tap.
  const [pairingCode, setPairingCode] = useState(socketService.pairingCode);
  const [signalingUrl, setSignalingUrl] = useState(socketService.currentServerUrl || DEFAULT_SIGNALING_URL);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(socketService.getErrorMessage());
  const [hosts, setHosts] = useState<SavedHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showLan, setShowLan] = useState(false);
  const [lanUrl, setLanUrl] = useState(socketService.lanTarget?.url ?? '');
  const [lanToken, setLanToken] = useState(socketService.lanTarget?.token ?? '');

  useEffect(() => {
    let alive = true;
    loadSavedHosts().then((saved) => {
      if (!alive) return;
      setHosts(saved);
      // First launch after a restart: pre-fill the most recent desktop.
      if (saved[0] && !socketService.pairingCode) {
        setPairingCode(saved[0].pairingCode);
        setSignalingUrl(saved[0].signalingUrl);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleLanConnect = async (target?: LanTarget) => {
    const t = target ?? { url: lanUrl, token: lanToken };
    const url = normalizeLanUrl(t.url);
    if (!url || !t.token.trim()) {
      setError('Enter the address and token from Turbine → Companion → Local network.');
      return;
    }
    setLanUrl(url);
    setLanToken(t.token.trim());
    setLoading(true);
    setError(null);
    try {
      await socketService.connectLan({ url, token: t.token });
      rememberHost({
        pairingCode: 'LAN',
        signalingUrl: url,
        lanToken: t.token.trim(),
        label: 'Local network',
        lastConnectedAt: Date.now(),
      }).catch(() => {});
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'LAN connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeChange = (text: string) => {
    const lan = parseLanPayload(text);
    if (lan) {
      setShowLan(true);
      setLanUrl(lan.url);
      setLanToken(lan.token);
      return;
    }
    // Allow pasting the QR payload JSON as well as a bare code.
    const payload = parsePairingPayload(text);
    if (payload) {
      setPairingCode(payload.pairingCode);
      if (payload.signalingUrl) setSignalingUrl(payload.signalingUrl);
      return;
    }
    setPairingCode(text.toUpperCase());
  };

  const handleConnect = async (override?: { pairingCode: string; signalingUrl?: string }) => {
    const code = normalizePairingCode(override?.pairingCode ?? pairingCode);
    const url = normalizeSignalingUrl(override?.signalingUrl ?? signalingUrl) || DEFAULT_SIGNALING_URL;
    if (override?.signalingUrl) setSignalingUrl(url);
    if (code.length < 10) {
      setError('Please enter the 6-character pairing code shown in Turbine (e.g. TRB-AB12CD).');
      return;
    }

    setPairingCode(code);
    setLoading(true);
    setError(null);

    try {
      // Resolves only once the direct DataChannel is open; App then switches screens.
      await socketService.connectP2P({ signalingUrl: url, pairingCode: code });
      const existing = hosts.find((h) => h.pairingCode === code && h.signalingUrl === url);
      rememberHost({
        pairingCode: code,
        signalingUrl: url,
        label: existing?.label || 'Turbine Desktop',
        lastConnectedAt: Date.now(),
      }).catch(() => {});
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'P2P Connection failed');
      try {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } catch {}
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Brand Header */}
      <View style={styles.brandHeader}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoIcon}>⚡</Text>
        </View>
        <Text style={styles.title}>Turbine Companion</Text>
        <Text style={styles.subtitle}>100% Peer-to-Peer Mobile Mission Control</Text>
      </View>

      {/* Pairing Card */}
      <View style={styles.card}>
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>🔒 Direct P2P (DTLS Encrypted)</Text>
          </View>
        </View>

        <Text style={styles.cardTitle}>Direct WebRTC Pairing</Text>
        <Text style={styles.cardSub}>
          Connects directly device-to-device with your Mac. No terminal data, code, or keystrokes ever touch a server.
        </Text>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>6-Character Pairing Code:</Text>
          <TextInput
            style={styles.codeInput}
            value={pairingCode}
            onChangeText={handleCodeChange}
            placeholder="TRB-XXXXXX"
            placeholderTextColor="#4a657e"
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="go"
            onSubmitEditing={() => handleConnect()}
            editable={!loading}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Signaling Server URL (Vercel Serverless):</Text>
          <TextInput
            style={styles.urlInput}
            value={signalingUrl}
            onChangeText={setSignalingUrl}
            placeholder={DEFAULT_SIGNALING_URL}
            placeholderTextColor="#4a657e"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!loading}
          />
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={() => handleConnect()}
          disabled={loading}
          accessibilityLabel="Connect"
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#050c16" />
              <Text style={styles.buttonText}>Connecting…</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={() => setScanning(true)} disabled={loading}>
          <Text style={styles.secondaryButtonText}>📷 Scan pairing QR</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.logToggle} onPress={() => setShowLan((v) => !v)}>
        <Text style={styles.logToggleText}>{showLan ? '▾' : '▸'} Connect over local network</Text>
      </TouchableOpacity>
      {showLan && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Local network</Text>
          <Text style={styles.cardSub}>
            In Turbine, open 📱 Companion → Local network → Enable, then scan its QR or type the address and token. Same
            Wi-Fi only; not encrypted.
          </Text>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Address</Text>
            <TextInput
              style={styles.urlInput}
              value={lanUrl}
              onChangeText={setLanUrl}
              placeholder="192.168.1.20:6970"
              placeholderTextColor="#4a657e"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Token</Text>
            <TextInput
              style={styles.urlInput}
              value={lanToken}
              onChangeText={setLanToken}
              placeholder="32-character token"
              placeholderTextColor="#4a657e"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!loading}
            />
          </View>
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={() => handleLanConnect()}
            disabled={loading}
            accessibilityLabel="Connect over LAN"
          >
            <Text style={styles.buttonText}>Connect over LAN</Text>
          </TouchableOpacity>
        </View>
      )}

      {hosts.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent desktops</Text>
          {hosts.map((h) => (
            <View key={`${h.signalingUrl}-${h.pairingCode}`} style={styles.hostRow}>
              <TouchableOpacity
                style={styles.hostInfo}
                disabled={loading}
                onPress={() => {
                  if (h.lanToken) {
                    handleLanConnect({ url: h.signalingUrl, token: h.lanToken });
                    return;
                  }
                  setPairingCode(h.pairingCode);
                  handleConnect({ pairingCode: h.pairingCode, signalingUrl: h.signalingUrl });
                }}
              >
                <Text style={styles.hostCode}>{h.lanToken ? `LAN · ${h.signalingUrl.replace(/^wss?:\/\//, '')}` : h.pairingCode}</Text>
                <Text style={styles.hostMeta} numberOfLines={1}>
                  {h.label} · {timeAgo(h.lastConnectedAt)} · {h.signalingUrl.replace(/^https?:\/\//, '')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.hostForget}
                onPress={() => forgetHost(h.pairingCode, h.signalingUrl).then(setHosts)}
                accessibilityLabel={`Forget ${h.pairingCode}`}
              >
                <Text style={styles.hostForgetText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity style={styles.logToggle} onPress={() => setShowLog((v) => !v)}>
        <Text style={styles.logToggleText}>{showLog ? '▾' : '▸'} Connection log</Text>
      </TouchableOpacity>
      {showLog && (
        <View style={[styles.infoCard, { marginBottom: 20 }]}>
          <ConnectionLog />
        </View>
      )}

      <QrScannerModal
        visible={scanning}
        onClose={() => setScanning(false)}
        onScanned={(payload) => {
          setScanning(false);
          setPairingCode(payload.pairingCode);
          handleConnect(payload);
        }}
        onScannedLan={(target) => {
          setScanning(false);
          setShowLan(true);
          handleLanConnect(target);
        }}
      />

      {/* Info Card */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>How it works:</Text>
        <Text style={styles.infoStep}>1. In Turbine Desktop, click 📱 Companion in the status bar.</Text>
        <Text style={styles.infoStep}>2. Click Start Pairing to get your pairing code.</Text>
        <Text style={styles.infoStep}>3. Enter the code above and tap Connect. The code stays valid for 24h, so you can reconnect with it.</Text>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050c16',
  },
  content: {
    padding: 24,
    paddingTop: 48,
    paddingBottom: 40,
  },
  brandHeader: {
    alignItems: 'center',
    marginBottom: 24,
  },
  logoCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0, 229, 200, 0.1)',
    borderWidth: 1.5,
    borderColor: '#00e5c8',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  logoIcon: {
    fontSize: 28,
  },
  title: {
    color: '#00e5c8',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: '#8ba5bd',
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#091728',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#173757',
    marginBottom: 20,
  },
  badgeRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  badge: {
    backgroundColor: 'rgba(0, 229, 200, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 229, 200, 0.3)',
  },
  badgeText: {
    color: '#00e5c8',
    fontSize: 12,
    fontWeight: '600',
  },
  cardTitle: {
    color: '#f0f6fc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  cardSub: {
    color: '#8ba5bd',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 20,
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    color: '#8ba5bd',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  codeInput: {
    backgroundColor: '#050c16',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#00e5c8',
    color: '#00e5c8',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 4,
    paddingVertical: 12,
  },
  urlInput: {
    backgroundColor: '#050c16',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#173757',
    color: '#f0f6fc',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorBox: {
    backgroundColor: 'rgba(255, 68, 68, 0.15)',
    borderLeftWidth: 3,
    borderLeftColor: '#ff4444',
    padding: 10,
    borderRadius: 6,
    marginBottom: 16,
  },
  errorText: {
    color: '#ff8888',
    fontSize: 13,
  },
  button: {
    backgroundColor: '#00e5c8',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  secondaryButton: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#173757',
  },
  secondaryButtonText: {
    color: '#00e5c8',
    fontSize: 14,
    fontWeight: '600',
  },
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#10263e',
    paddingVertical: 10,
  },
  hostInfo: {
    flex: 1,
  },
  hostCode: {
    color: '#f0f6fc',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  hostMeta: {
    color: '#5c768d',
    fontSize: 11,
    marginTop: 2,
  },
  hostForget: {
    padding: 8,
  },
  hostForgetText: {
    color: '#5c768d',
    fontSize: 14,
  },
  logToggle: {
    paddingVertical: 8,
    marginBottom: 8,
  },
  logToggleText: {
    color: '#5c768d',
    fontSize: 12,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#050c16',
    fontSize: 15,
    fontWeight: '700',
  },
  infoCard: {
    backgroundColor: '#071220',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#10263e',
  },
  infoTitle: {
    color: '#8ba5bd',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  infoStep: {
    color: '#5c768d',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
});
