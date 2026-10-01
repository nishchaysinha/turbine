/**
 * Registry for the hidden WebView WebRTC engine. Kept free of React Native
 * imports so the connection logic in socketService can be unit tested.
 */
export interface WebRTCBridgeRef {
  connect: (signalingUrl: string, pairingCode: string) => void;
  send: (message: string) => void;
  disconnect: () => void;
}

let current: WebRTCBridgeRef | null = null;

export function getWebRTCBridge(): WebRTCBridgeRef | null {
  return current;
}

export function setWebRTCBridge(bridge: WebRTCBridgeRef | null) {
  current = bridge;
}
