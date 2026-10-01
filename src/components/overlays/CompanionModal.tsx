import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { p2pBridge, type LanInfo } from '../../services/p2pBridge';
import type { RelayConnectionStatus, RelaySessionInfo, RelayPeerInfo } from '../../types/relay';
import './CompanionModal.css';

interface CompanionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CompanionModal({ isOpen, onClose }: CompanionModalProps) {
  const [p2pStatus, setP2pStatus] = useState<RelayConnectionStatus>(p2pBridge.getStatus());
  const [p2pSession, setP2pSession] = useState<RelaySessionInfo | null>(p2pBridge.getSession());
  const [p2pPeers, setP2pPeers] = useState<RelayPeerInfo[]>(p2pBridge.getPeers());
  const [signalingUrl, setSignalingUrl] = useState(p2pBridge.getSignalingUrl());

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(p2pBridge.getLatency());
  const [lan, setLan] = useState<LanInfo | null>(p2pBridge.getLanInfo());
  const [lanQr, setLanQr] = useState<string | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const webrtc = p2pBridge.webrtcAvailable();

  useEffect(() => p2pBridge.onLanChange(setLan), []);

  useEffect(() => {
    if (!lan?.running || !lan.urls.length) {
      setLanQr(null);
      return;
    }
    const payload = JSON.stringify({ type: 'turbine-lan', url: lan.urls[0], urls: lan.urls, token: lan.token });
    QRCode.toDataURL(payload, { width: 180, margin: 1, color: { dark: '#00e5c8', light: '#071320' } })
      .then(setLanQr)
      .catch(() => setLanQr(null));
  }, [lan]);

  const toggleLan = async () => {
    setLanBusy(true);
    setErrorMsg(null);
    try {
      if (lan?.running) await p2pBridge.stopLan();
      else await p2pBridge.startLan();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLanBusy(false);
    }
  };

  useEffect(() => {
    const unsubP2pStatus = p2pBridge.onStatusChange((status) => {
      setP2pStatus(status);
      setLatency(p2pBridge.getLatency());
    });
    const unsubP2pSession = p2pBridge.onSessionChange(setP2pSession);
    const unsubP2pPeers = p2pBridge.onPeersChange(setP2pPeers);

    return () => {
      unsubP2pStatus();
      unsubP2pSession();
      unsubP2pPeers();
    };
  }, []);

  // Generate QR code on session change
  useEffect(() => {
    if (!p2pSession) {
      setQrDataUrl(null);
      return;
    }

    const payload = JSON.stringify({
      type: 'turbine-p2p',
      signalingUrl: p2pSession.relayUrl,
      pairingCode: p2pSession.pairingCode,
    });

    QRCode.toDataURL(payload, {
      width: 200,
      margin: 1,
      color: {
        dark: '#00e5c8',
        light: '#071320',
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch((err) => console.error('QR generation failed:', err));
  }, [p2pSession]);

  const handleConnect = async (fresh = false) => {
    setIsConnecting(true);
    setErrorMsg(null);
    try {
      await p2pBridge.connect(signalingUrl, { fresh });
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    p2pBridge.disconnect();
    setP2pSession(null);
    setQrDataUrl(null);
  };

  const handleCopyCode = () => {
    if (p2pSession?.pairingCode) {
      navigator.clipboard.writeText(p2pSession.pairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="companion-modal-backdrop" onClick={onClose}>
      <div className="companion-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="companion-modal-header">
          <div className="companion-modal-title">
            <span className="companion-icon">📱</span>
            <div>
              <h2>Mobile Companion</h2>
              <span className="companion-badge">{webrtc ? 'Direct P2P (WebRTC, encrypted) or local network' : 'Local network'}</span>
            </div>
          </div>
          <button className="companion-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="companion-modal-subtitle">
          {webrtc
            ? 'Pair your phone directly. With P2P, terminal output and keystrokes never touch a server; on the same Wi-Fi you can also connect over the local network.'
            : 'Pair your phone over your local network.'}
        </p>

        {/* Signaling Configuration (WebRTC) */}
        {webrtc && (
        <div className="companion-config-card">
          <label className="companion-label">Signaling Service (Vercel Serverless):</label>
          <div className="companion-input-group">
            <input
              type="text"
              className="companion-input-field"
              value={signalingUrl}
              onChange={(e) => setSignalingUrl(e.target.value)}
              placeholder="https://signaling-taupe.vercel.app"
              disabled={p2pStatus === 'connected' || isConnecting}
            />
            {p2pSession ? (
              <>
                <button
                  className="companion-btn-start"
                  onClick={() => handleConnect(true)}
                  disabled={isConnecting}
                  title="Invalidate this code and generate a new one"
                >
                  New Code
                </button>
                <button className="companion-btn-stop" onClick={handleDisconnect}>
                  Stop
                </button>
              </>
            ) : (
              <button
                className="companion-btn-start"
                onClick={() => handleConnect()}
                disabled={isConnecting}
              >
                {isConnecting ? 'Starting...' : 'Start Pairing'}
              </button>
            )}
          </div>
          <p className="companion-hint">
            🔒 The server only relays the WebRTC handshake. The code stays valid for 24h, so your phone can reconnect with it.
          </p>
        </div>
        )}

        {errorMsg && <div className="companion-error-banner">{errorMsg}</div>}

        {p2pSession && (
          <div className="companion-pairing-section">
            <div className="companion-qr-container">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Pairing QR Code" className="companion-qr-image" />
              ) : (
                <div className="companion-qr-skeleton">Generating QR...</div>
              )}
              <span className="companion-qr-hint">Scan with Turbine Companion app</span>
            </div>

            <div className="companion-code-container">
              <span className="companion-code-label">6-Character Pairing Code</span>
              <div className="companion-code-box" onClick={handleCopyCode} title="Click to copy code">
                <span className="companion-code-text">{p2pSession.pairingCode}</span>
                <span className="companion-copy-badge">{copied ? '✓ Copied' : 'Copy'}</span>
              </div>
              <p className="companion-code-sub">
                Enter this code in the Turbine app on your phone to establish the direct P2P connection!
              </p>
            </div>
          </div>
        )}

        {!webrtc && (
          <div className="companion-error-banner">
            Peer-to-peer pairing needs WebRTC, which this system's web engine doesn't provide (WebKitGTK on Linux). Use
            local network pairing below.
          </div>
        )}

        {/* Direct LAN connection (Rust WebSocket server) */}
        <div className="companion-config-card">
          <label className="companion-label">Local network</label>
          <div className="companion-input-group">
            <span className="companion-hint" style={{ flex: 1, margin: 0 }}>
              {lan?.running
                ? `Listening on ${lan.urls.join('  ·  ')}${lan.clients ? ` — ${lan.clients} phone connected` : ''}`
                : 'Let your phone connect directly over Wi-Fi (same network, no internet needed).'}
            </span>
            <button
              className={lan?.running ? 'companion-btn-stop' : 'companion-btn-start'}
              onClick={toggleLan}
              disabled={lanBusy}
            >
              {lanBusy ? '…' : lan?.running ? 'Stop' : 'Enable'}
            </button>
          </div>
          {lan?.running && (
            <div className="companion-pairing-section">
              <div className="companion-qr-container">
                {lanQr ? <img src={lanQr} alt="LAN pairing QR Code" className="companion-qr-image" /> : null}
                <span className="companion-qr-hint">Scan with Turbine Companion</span>
              </div>
              <div className="companion-code-container">
                <span className="companion-code-label">Address</span>
                <div className="companion-code-box">
                  <span className="companion-code-text" style={{ fontSize: 14 }}>{lan.urls[0]?.replace('ws://', '')}</span>
                </div>
                <span className="companion-code-label">Token</span>
                <div className="companion-code-box" title="Click to copy" onClick={() => navigator.clipboard.writeText(lan.token)}>
                  <span className="companion-code-text" style={{ fontSize: 13, letterSpacing: 0 }}>{lan.token}</span>
                </div>
                <p className="companion-code-sub">
                  ⚠️ Not encrypted — use on trusted networks only. Stopping and re-enabling keeps the same token; anyone with
                  it on your network can control your terminals.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Status / Peer Footer */}
        <div className="companion-footer">
          <div className="companion-status-row">
            <span
              className={`companion-status-dot ${
                p2pStatus === 'connected'
                  ? 'dot-connected'
                  : p2pSession || lan?.running
                  ? 'dot-waiting'
                  : isConnecting
                  ? 'dot-connecting'
                  : 'dot-disconnected'
              }`}
            />
            <span className="companion-status-text">
              {p2pStatus === 'connected'
                ? `🟢 Connected${p2pPeers[0]?.deviceName ? ` · ${p2pPeers[0].deviceName}` : ''}${latency !== null ? ` • ⚡ ${latency}ms` : ''}`
                : p2pSession || lan?.running
                ? `🟡 Waiting for your phone${lan?.running ? ' (local network' + (p2pSession ? ' or P2P code)' : ')') : '…'}`
                : isConnecting
                ? '🔄 Registering offer…'
                : webrtc
                ? '⚪ Offline — Start Pairing or enable Local network'
                : '⚪ Offline — enable Local network to pair'}
            </span>
          </div>

          {p2pPeers.length > 0 && (
            <div className="companion-peers-list">
              <span className="companion-peers-header">Connected Devices ({p2pPeers.length}):</span>
              {p2pPeers.map((peer, idx) => (
                <div key={idx} className="companion-peer-tag">
                  📱 {peer.deviceName || 'Mobile Phone'} ({new Date(peer.timestamp).toLocaleTimeString()})
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
