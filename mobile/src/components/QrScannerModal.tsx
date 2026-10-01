import React, { useRef } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parseLanPayload, parsePairingPayload, type LanTarget } from '../utils/pairing';

interface QrScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onScanned: (payload: { pairingCode: string; signalingUrl?: string }) => void;
  onScannedLan?: (target: LanTarget) => void;
}

/** Scans the pairing QR shown in Turbine's Companion dialog. */
export const QrScannerModal: React.FC<QrScannerModalProps> = ({ visible, onClose, onScanned, onScannedLan }) => {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  const handleScan = ({ data }: { data: string }) => {
    if (handled.current) return;
    const lan = parseLanPayload(data);
    if (lan && onScannedLan) {
      handled.current = true;
      onScannedLan(lan);
      return;
    }
    const payload = parsePairingPayload(data);
    if (!payload) return;
    handled.current = true;
    onScanned(payload);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => {
        handled.current = false;
      }}
    >
      <View style={styles.container}>
        <Text style={styles.title}>Scan pairing QR</Text>
        <Text style={styles.sub}>In Turbine, open 📱 Companion → Start Pairing and point your camera at the QR code.</Text>

        <View style={styles.cameraBox}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleScan}
            />
          ) : (
            <View style={styles.permission}>
              <Text style={styles.sub}>Camera access is needed to scan the code.</Text>
              <TouchableOpacity style={styles.button} onPress={requestPermission}>
                <Text style={styles.buttonText}>Allow camera</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.reticle} pointerEvents="none" />
        </View>

        <TouchableOpacity style={styles.cancel} onPress={onClose}>
          <Text style={styles.cancelText}>Enter code manually instead</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050c16', padding: 24, paddingTop: 64 },
  title: { color: '#00e5c8', fontSize: 22, fontWeight: '800', marginBottom: 6 },
  sub: { color: '#8ba5bd', fontSize: 13, lineHeight: 18, textAlign: 'center' },
  cameraBox: {
    marginTop: 24,
    aspectRatio: 1,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#091728',
    borderWidth: 1,
    borderColor: '#173757',
    justifyContent: 'center',
  },
  permission: { padding: 24, alignItems: 'center', gap: 12 },
  reticle: {
    position: 'absolute',
    top: '20%',
    left: '20%',
    right: '20%',
    bottom: '20%',
    borderWidth: 2,
    borderColor: '#00e5c8',
    borderRadius: 12,
  },
  button: { backgroundColor: '#00e5c8', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 18 },
  buttonText: { color: '#050c16', fontWeight: '700' },
  cancel: { marginTop: 24, alignItems: 'center', padding: 12 },
  cancelText: { color: '#00e5c8', fontSize: 14, fontWeight: '600' },
});
