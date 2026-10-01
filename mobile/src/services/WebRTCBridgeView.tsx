import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { setWebRTCBridge } from './bridgeRegistry';

export type { WebRTCBridgeRef } from './bridgeRegistry';
export { getWebRTCBridge } from './bridgeRegistry';

interface WebRTCBridgeViewProps {
  onStatusChange: (status: 'disconnected' | 'connecting' | 'connected', latency?: number) => void;
  onMessage: (message: string) => void;
  onError: (error: string) => void;
}

/**
 * WebRTC engine page. Runs inside a hidden WebView so the DataChannel works
 * in Expo Go (no native WebRTC module required).
 */
export const WEBRTC_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Turbine WebRTC Engine</title>
</head>
<body>
<script>
  let pc = null;
  let dc = null;
  let pingInterval = null;
  let lastPingTime = null;
  let attempt = 0;

  function postToApp(type, payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, payload || {})));
    }
  }

  async function readError(resp, fallback) {
    try {
      const body = await resp.json();
      if (body && body.error) return body.error;
    } catch (e) {}
    return fallback;
  }

  window.connectP2P = async function(signalingUrl, pairingCode) {
    window.disconnectP2P(true);
    const myAttempt = ++attempt;
    try {
      postToApp('status', { status: 'connecting' });

      const cleanUrl = signalingUrl.replace(/\\/+$/, '');
      const code = encodeURIComponent(pairingCode.toUpperCase().trim());

      // 1. Fetch the desktop's offer
      const resp = await fetch(cleanUrl + '/api/pair/' + code);
      if (!resp.ok) {
        throw new Error(resp.status === 404
          ? 'Pairing code not found or expired. Check the code shown in Turbine.'
          : await readError(resp, 'Signaling server error (' + resp.status + ')'));
      }
      const data = await resp.json();
      if (myAttempt !== attempt) return;
      if (!data.offer) throw new Error('No offer found for this pairing code.');
      if (data.answer) throw new Error('This code is already connected to another device. Generate a new code in Turbine.');

      // 2. Peer connection
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
        ]
      });
      const thisPc = pc;

      const localCandidates = [];
      const iceDone = new Promise(function(resolve) {
        thisPc.onicecandidate = function(event) {
          if (event.candidate) {
            localCandidates.push(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
          } else {
            resolve();
          }
        };
        setTimeout(resolve, 2000);
      });

      thisPc.onconnectionstatechange = function() {
        if (thisPc !== pc) return;
        if (thisPc.connectionState === 'failed') {
          postToApp('error', { message: 'Peer-to-peer connection failed (network blocked?).' });
          window.disconnectP2P();
        }
      };

      // 3. DataChannel is created by the desktop
      thisPc.ondatachannel = function(event) {
        if (thisPc !== pc) return;
        dc = event.channel;
        const thisDc = dc;

        thisDc.onopen = function() {
          postToApp('status', { status: 'connected' });
          if (pingInterval) clearInterval(pingInterval);
          pingInterval = setInterval(function() {
            if (thisDc.readyState === 'open') {
              lastPingTime = Date.now();
              thisDc.send(JSON.stringify({ type: 'ping', payload: { clientTime: lastPingTime }, timestamp: lastPingTime }));
            }
          }, 3000);
        };

        thisDc.onclose = function() {
          if (thisDc !== dc) return;
          if (pingInterval) clearInterval(pingInterval);
          postToApp('status', { status: 'disconnected' });
        };

        thisDc.onerror = function(err) {
          console.warn('DataChannel error', err && err.message);
        };

        thisDc.onmessage = function(msgEvent) {
          try {
            const parsed = JSON.parse(msgEvent.data);
            if (parsed.type === 'pong' && lastPingTime) {
              postToApp('latency', { latency: Math.max(1, Date.now() - lastPingTime) });
              return;
            }
          } catch (e) {}
          postToApp('message', { data: msgEvent.data });
        };
      };

      // 4. Apply offer, create answer
      await thisPc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const offerCandidates = Array.isArray(data.offerCandidates) ? data.offerCandidates : [];
      for (let i = 0; i < offerCandidates.length; i++) {
        try { await thisPc.addIceCandidate(offerCandidates[i]); } catch (e) {}
      }
      const answer = await thisPc.createAnswer();
      await thisPc.setLocalDescription(answer);
      await iceDone;
      if (myAttempt !== attempt) return;

      // 5. Submit answer
      const answerResp = await fetch(cleanUrl + '/api/pair/' + code, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: thisPc.localDescription, candidates: localCandidates })
      });
      if (!answerResp.ok) {
        throw new Error(answerResp.status === 409
          ? 'This code is already connected to another device. Generate a new code in Turbine.'
          : await readError(answerResp, 'Failed to submit answer to signaling service'));
      }
    } catch (e) {
      if (myAttempt !== attempt) return;
      postToApp('error', { message: (e && e.message) || String(e) });
      window.disconnectP2P();
    }
  };

  window.sendDataChannel = function(rawString) {
    if (dc && dc.readyState === 'open') {
      dc.send(rawString);
    }
  };

  window.disconnectP2P = function(silent) {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    const oldDc = dc;
    const oldPc = pc;
    dc = null;
    pc = null;
    if (oldDc) { try { oldDc.close(); } catch (e) {} }
    if (oldPc) { try { oldPc.close(); } catch (e) {} }
    if (!silent) postToApp('status', { status: 'disconnected' });
  };

  postToApp('ready', {});
</script>
</body>
</html>
`;

export const WebRTCBridgeView: React.FC<WebRTCBridgeViewProps> = ({
  onStatusChange,
  onMessage,
  onError,
}) => {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const propsRef = useRef({ onStatusChange, onMessage, onError });
  propsRef.current = { onStatusChange, onMessage, onError };

  const run = useCallback((js: string) => {
    if (readyRef.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(js);
    } else {
      queueRef.current.push(js);
    }
  }, []);

  useEffect(() => {
    setWebRTCBridge({
      connect: (signalingUrl: string, pairingCode: string) => {
        // A new connect supersedes anything still queued.
        queueRef.current = [];
        run(`window.connectP2P(${JSON.stringify(signalingUrl)}, ${JSON.stringify(pairingCode)}); true;`);
      },
      send: (message: string) => {
        if (!readyRef.current) return;
        webViewRef.current?.injectJavaScript(`window.sendDataChannel(${JSON.stringify(message)}); true;`);
      },
      disconnect: () => {
        queueRef.current = [];
        if (readyRef.current) webViewRef.current?.injectJavaScript(`window.disconnectP2P(); true;`);
      },
    });
    return () => setWebRTCBridge(null);
  }, [run]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let data: any;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch (err) {
      console.error('[WebRTCBridgeView] Message parse error:', err);
      return;
    }
    const { onStatusChange, onMessage, onError } = propsRef.current;
    switch (data.type) {
      case 'ready': {
        readyRef.current = true;
        const pending = queueRef.current;
        queueRef.current = [];
        pending.forEach((js) => webViewRef.current?.injectJavaScript(js));
        break;
      }
      case 'status':
        onStatusChange(data.status);
        break;
      case 'latency':
        onStatusChange('connected', data.latency);
        break;
      case 'message':
        onMessage(data.data);
        break;
      case 'error':
        onError(data.message);
        break;
    }
  };

  const handleReset = () => {
    // The WebContent process died (iOS memory pressure): any live pipe is gone.
    readyRef.current = false;
    propsRef.current.onStatusChange('disconnected');
    webViewRef.current?.reload();
  };

  return (
    <View style={styles.hiddenContainer} pointerEvents="none">
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: WEBRTC_HTML, baseUrl: 'https://localhost' }}
        onMessage={handleMessage}
        onContentProcessDidTerminate={handleReset}
        onRenderProcessGone={handleReset}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        style={styles.hiddenWebView}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  hiddenContainer: {
    width: 0,
    height: 0,
    opacity: 0,
    position: 'absolute',
    left: -9999,
  },
  hiddenWebView: {
    width: 1,
    height: 1,
  },
});
