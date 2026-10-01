import type { Workspace, Task, SwarmRun, SwarmAgent, AgentPresetInfo, ConnectionStatus } from '../types';
import { getWebRTCBridge } from './bridgeRegistry';
import { normalizePairingCode, normalizeSignalingUrl } from '../utils/pairing';
import type { DirectoryCache, FileEntry } from '../utils/fileTree';
import type { HistoryRun } from '../utils/history';
import { bracketedPaste } from '../utils/review';

export interface FilePreview {
  path: string;
  content: string;
  loading: boolean;
  error?: string;
  truncated?: boolean;
  binary?: boolean;
  totalSize?: number;
}

type Listener = () => void;

export const DEFAULT_SIGNALING_URL = 'https://signaling-taupe.vercel.app';
const CONNECT_TIMEOUT_MS = 20000;
const RECONNECT_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 20000, 30000];
/** The desktop re-arms its code a few seconds after a peer leaves; retry "busy" this many times. */
const BUSY_RETRIES = 4;
const BUSY_RETRY_DELAY_MS = 2000;
const BUSY_PATTERN = /already connected/i;
const MAX_PANE_BUFFER = 100000;
const MAX_LOG_ENTRIES = 200;

export interface ConnectionLogEntry {
  at: number;
  message: string;
}

/**
 * Phone side of the Turbine link. Owns all mirrored desktop state and the
 * connection lifecycle; the actual WebRTC work happens in the hidden
 * WebView engine (WebRTCBridgeView) or, if available, a native
 * RTCPeerConnection.
 */
export class SocketService {
  private pc: any | null = null;
  private dc: any | null = null;
  private status: ConnectionStatus = 'disconnected';
  private errorMessage: string | null = null;

  public workspaces: Workspace[] = [];
  public activeWorkspaceId: string = '';
  public tasks: Task[] = [];
  public swarmRuns: SwarmRun[] = [];
  public swarmAgents: SwarmAgent[] = [];
  public presets: AgentPresetInfo[] = [];
  public gitDiff: string = '';
  public gitDiffError: string | null = null;
  /** Bumped on every diff:data so screens can tell a fresh response from other updates. */
  public gitDiffVersion = 0;
  public lastCommandError: string | null = null;
  /** Lazy file tree, keyed by project-relative directory ('' = root). */
  public directories: DirectoryCache = {};
  public projectRoot: string = '';
  public filePreview: FilePreview | null = null;
  public history: HistoryRun[] = [];
  public historyLoading = false;
  public historyError: string | null = null;
  public focusedPaneId: string | null = null;
  public paneOutputs: Map<string, string> = new Map();
  public paneDimensions: Map<string, { cols: number; rows: number }> = new Map();
  public currentServerUrl: string = DEFAULT_SIGNALING_URL;
  public pairingCode: string = '';
  public connectionMode: 'p2p' = 'p2p';
  public latencyMs: number | null = null;
  /** True while we lost the desktop and are retrying with the same code. */
  public reconnecting = false;

  /** Recent connection events for the troubleshooting view (newest last). */
  public connectionLog: ConnectionLogEntry[] = [];

  private listeners: Set<Listener> = new Set();
  private outputListeners: Set<(paneId: string, data: string) => void> = new Set();
  private resizeListeners: Set<(paneId: string, cols: number, rows: number) => void> = new Set();
  private syncListeners: Set<(paneId: string, cols: number, rows: number, buffer: string) => void> = new Set();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private wantConnected = false;
  private pendingConnect: { resolve: () => void; reject: (e: Error) => void; promise: Promise<void> } | null = null;
  private busyRetriesLeft = 0;

  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public onTerminalOutput(fn: (paneId: string, data: string) => void): () => void {
    this.outputListeners.add(fn);
    return () => this.outputListeners.delete(fn);
  }

  public onTerminalResize(fn: (paneId: string, cols: number, rows: number) => void): () => void {
    this.resizeListeners.add(fn);
    return () => this.resizeListeners.delete(fn);
  }

  public onTerminalSync(fn: (paneId: string, cols: number, rows: number, buffer: string) => void): () => void {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }

  public notify() {
    this.listeners.forEach((fn) => {
      try { fn(); } catch (e) { console.warn('[SocketService] listener failed:', e); }
    });
  }

  public log(message: string) {
    this.connectionLog = [...this.connectionLog, { at: Date.now(), message }].slice(-MAX_LOG_ENTRIES);
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getErrorMessage(): string | null {
    return this.errorMessage;
  }

  /** Called by the transport (WebView engine or native DataChannel). */
  public setStatus(status: ConnectionStatus, latency?: number) {
    if (latency !== undefined) {
      this.latencyMs = latency;
    }
    const prev = this.status;
    // The engine reports "disconnected" while it resets for a new attempt; keep
    // showing "connecting" until the attempt actually succeeds or fails.
    if (status === 'disconnected' && prev === 'connecting' && (this.pendingConnect || this.reconnecting)) {
      this.notify();
      return;
    }
    this.status = status;
    if (status !== prev) this.log(`Status: ${prev} → ${status}`);

    if (status === 'connected') {
      this.errorMessage = null;
      this.reconnecting = false;
      this.reconnectAttempt = 0;
      this.clearConnectTimer();
      if (prev !== 'connected') {
        this.pendingConnect?.resolve();
        this.pendingConnect = null;
        // Make sure we have the latest desktop state even if the initial sync raced us.
        if (this.focusedPaneId) this.requestTerminalSync(this.focusedPaneId);
      }
    } else if (status === 'disconnected' || status === 'error') {
      if (prev === 'connected' && this.wantConnected) {
        this.scheduleReconnect();
      } else if (this.pendingConnect && prev === 'connecting' && status === 'error') {
        this.failPendingConnect(this.errorMessage || 'Connection failed');
      }
    }
    this.notify();
  }

  public setErrorMessage(err: string) {
    this.log(`Error: ${err}`);
    this.errorMessage = err;
    if (this.pendingConnect) {
      this.failPendingConnect(err);
    } else if (this.reconnecting) {
      this.scheduleReconnect();
    }
    this.notify();
  }

  /**
   * Pair with the desktop. Resolves once the DataChannel is open; rejects on
   * signaling errors or after a timeout.
   */
  public connectP2P({ signalingUrl, pairingCode }: { signalingUrl: string; pairingCode: string }): Promise<void> {
    const code = normalizePairingCode(pairingCode);
    const url = normalizeSignalingUrl(signalingUrl) || DEFAULT_SIGNALING_URL;
    if (!code) return Promise.reject(new Error('Please enter the pairing code shown on your desktop.'));

    this.disconnect();
    this.wantConnected = true;
    this.currentServerUrl = url;
    this.pairingCode = code;
    this.busyRetriesLeft = BUSY_RETRIES;
    return this.startAttempt();
  }

  private startAttempt(): Promise<void> {
    this.log(`Connecting to ${this.pairingCode} via ${this.currentServerUrl}`);
    this.status = 'connecting';
    this.errorMessage = null;
    this.notify();

    // A retry within the same user-initiated connect keeps the original promise.
    if (!this.pendingConnect) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pendingConnect = { resolve, reject, promise };
    }
    const promise = this.pendingConnect.promise;

    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.failPendingConnect(
        'Timed out waiting for the desktop. Make sure Turbine is open with pairing started, then try again.'
      );
    }, CONNECT_TIMEOUT_MS);

    const bridge = getWebRTCBridge();
    if (bridge) {
      bridge.connect(this.currentServerUrl, this.pairingCode);
    } else {
      this.connectNative().catch((e) => this.failPendingConnect(e instanceof Error ? e.message : String(e)));
    }
    return promise;
  }

  private failPendingConnect(message: string) {
    this.clearConnectTimer();
    this.teardownTransport();

    // The code is still marked as answered by our previous session while the
    // desktop re-arms it; give it a moment instead of failing right away.
    if (!this.reconnecting && this.wantConnected && this.busyRetriesLeft > 0 && BUSY_PATTERN.test(message)) {
      this.busyRetriesLeft--;
      this.log(`Desktop busy, retrying in ${BUSY_RETRY_DELAY_MS / 1000}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wantConnected && this.pendingConnect) this.startAttempt();
      }, BUSY_RETRY_DELAY_MS);
      return;
    }

    this.errorMessage = message;
    const pending = this.pendingConnect;
    this.pendingConnect = null;

    if (this.reconnecting) {
      pending?.reject(new Error(message));
      this.scheduleReconnect();
    } else {
      this.status = 'error';
      this.wantConnected = false;
      pending?.reject(new Error(message));
    }
    this.notify();
  }

  private scheduleReconnect() {
    if (!this.wantConnected) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.reconnecting = false;
      this.wantConnected = false;
      this.status = 'error';
      this.errorMessage = 'Lost connection to the desktop. Reconnect with the pairing code shown in Turbine.';
      this.log('Gave up reconnecting');
      this.notify();
      return;
    }
    this.teardownTransport();
    this.reconnecting = true;
    this.status = 'connecting';
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++];
    this.log(`Reconnect attempt ${this.reconnectAttempt} in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnected) return;
      this.startAttempt().catch(() => {});
    }, delay);
    this.notify();
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Native RTCPeerConnection path (dev clients with react-native-webrtc or similar). */
  private async connectNative(): Promise<void> {
    const g = globalThis as any;
    const RTCPC = g.RTCPeerConnection;
    const RTCSD = g.RTCSessionDescription;
    if (!RTCPC || !RTCSD) {
      throw new Error('WebRTC engine is still starting. Please tap Connect again.');
    }

    const code = this.pairingCode;
    const resp = await fetch(`${this.currentServerUrl}/api/pair/${encodeURIComponent(code)}`);
    if (!resp.ok) {
      throw new Error(resp.status === 404 ? 'Pairing code not found or expired' : `Signaling error (${resp.status})`);
    }
    const data = await resp.json();
    if (!data.offer) throw new Error('No offer found for code ' + code);
    if (data.answer) throw new Error('This code is already connected to another device.');

    const pc = new RTCPC({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    this.pc = pc;

    const localCandidates: any[] = [];
    const icePromise = new Promise<void>((resolve) => {
      pc.onicecandidate = (event: any) => {
        if (event.candidate) {
          localCandidates.push(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
        } else {
          resolve();
        }
      };
      setTimeout(resolve, 2000);
    });

    pc.ondatachannel = (event: any) => {
      const dc = event.channel;
      this.dc = dc;
      dc.onopen = () => {
        this.startPing();
        this.setStatus('connected');
      };
      dc.onmessage = (msgEvent: any) => this.handleMessage(msgEvent.data);
      dc.onclose = () => {
        this.stopPing();
        this.setStatus('disconnected');
      };
    };

    await pc.setRemoteDescription(new RTCSD(data.offer));
    for (const cand of Array.isArray(data.offerCandidates) ? data.offerCandidates : []) {
      try { await pc.addIceCandidate(cand); } catch {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await icePromise;

    const post = await fetch(`${this.currentServerUrl}/api/pair/${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: pc.localDescription, candidates: localCandidates }),
    });
    if (!post.ok) {
      throw new Error(post.status === 409 ? 'This code is already connected to another device.' : 'Failed to submit answer');
    }
  }

  private teardownTransport() {
    this.stopPing();
    getWebRTCBridge()?.disconnect();
    if (this.dc) {
      try { this.dc.close(); } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
  }

  /** User-initiated disconnect: stops any reconnect attempts. */
  public disconnect() {
    if (this.wantConnected) this.log('Disconnected by user');
    this.wantConnected = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectTimer();
    if (this.pendingConnect) {
      this.pendingConnect.reject(new Error('Disconnected'));
      this.pendingConnect = null;
    }
    this.teardownTransport();
    this.status = 'disconnected';
    this.latencyMs = null;
    this.notify();
  }

  private startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.send('ping', { clientTime: Date.now() });
    }, 4000);
    this.send('ping', { clientTime: Date.now() });
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public send(type: string, payload: unknown) {
    const serialized = JSON.stringify({ type, payload, timestamp: Date.now() });
    const bridge = getWebRTCBridge();
    if (bridge) {
      bridge.send(serialized);
    } else if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(serialized);
    }
  }

  // --- Commands ---

  public sendTerminalInput(paneId: string, data: string) {
    this.send('terminal:input', { paneId, data });
  }

  public sendTerminalResize(paneId: string, cols: number, rows: number) {
    this.send('terminal:resize', { paneId, cols, rows });
  }

  public switchWorkspace(workspaceId: string) {
    this.activeWorkspaceId = workspaceId;
    this.send('workspace:switch', { workspaceId });
    this.notify();
  }

  public triggerSwarm(prompt: string, presetId?: string) {
    this.send('swarm:start', { prompt, presetId });
  }

  /** Type a follow-up message into a running agent's terminal. */
  public sendAgentFollowUp(agent: SwarmAgent, text: string) {
    if (text.includes('\n')) {
      this.sendPromptToPane(agent.pane_id, text);
    } else {
      this.sendTerminalInput(agent.pane_id, text.endsWith('\r') ? text : `${text}\r`);
    }
  }

  /** Sends a (possibly multi-line) prompt to an agent terminal as a single pasted message. */
  public sendPromptToPane(paneId: string, prompt: string) {
    this.sendTerminalInput(paneId, bracketedPaste(prompt));
  }

  public requestDirectory(path: string, refresh = false) {
    const existing = this.directories[path];
    this.directories = { ...this.directories, [path]: { entries: existing?.entries ?? [], loading: true } };
    this.send('files:list', { path, refresh });
    this.notify();
  }

  public refreshFiles() {
    // Drop everything below the root so expanded folders reload too.
    const expanded = Object.keys(this.directories);
    this.directories = {};
    this.requestDirectory('', true);
    expanded.filter((p) => p).forEach((p) => this.requestDirectory(p));
  }

  public readFile(path: string) {
    this.filePreview = { path, content: '', loading: true };
    this.send('files:read', { path });
    this.notify();
  }

  public closeFilePreview() {
    this.filePreview = null;
    this.notify();
  }

  public requestHistory() {
    this.historyLoading = true;
    this.historyError = null;
    this.send('history:request', {});
    this.notify();
  }

  public killAgent(agentId: string) {
    this.send('swarm:kill_agent', { agentId });
  }

  public updateTaskStatus(id: string, status: string) {
    this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, status } : t));
    this.send('task:update_status', { id, status });
    this.notify();
  }

  public createTask(title: string, projectPath?: string) {
    this.send('task:create', { title, projectPath: projectPath || '.' });
  }

  public requestDiff(projectPath: string = '.') {
    this.send('diff:request', { projectPath });
  }

  public setFocusedPane(paneId: string | null) {
    this.focusedPaneId = paneId;
    if (paneId) {
      this.send('terminal:switch_pane', { paneId });
    }
    this.notify();
  }

  public getPaneOutput(paneId: string): string {
    return this.paneOutputs.get(paneId) || '';
  }

  public getPaneDimensions(paneId: string): { cols: number; rows: number } | undefined {
    return this.paneDimensions.get(paneId);
  }

  public requestTerminalSync(paneId: string) {
    this.send('terminal:request_sync', { paneId });
  }

  public clearPaneOutput(paneId: string) {
    this.paneOutputs.set(paneId, '');
    this.notify();
  }

  // --- Message Ingestion ---

  public handleMessage(rawData: string) {
    let msg: any;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      console.warn('[SocketService] Parse error:', e);
      return;
    }
    const payload = msg?.payload || {};

    switch (msg?.type) {
      case 'ping': {
        // Desktop measures latency too; echo its timestamp back.
        this.send('pong', { clientTime: payload.clientTime });
        break;
      }

      case 'pong': {
        if (payload.clientTime) {
          this.latencyMs = Math.max(1, Date.now() - payload.clientTime);
        }
        this.notify();
        break;
      }

      case 'state:sync': {
        if (Array.isArray(payload.workspaces)) this.workspaces = payload.workspaces;
        if (payload.activeWorkspaceId) this.activeWorkspaceId = payload.activeWorkspaceId;
        if (Array.isArray(payload.tasks)) this.tasks = payload.tasks;
        if (Array.isArray(payload.swarmRuns)) this.swarmRuns = payload.swarmRuns;
        if (Array.isArray(payload.swarmAgents)) this.swarmAgents = payload.swarmAgents;
        if (Array.isArray(payload.presets)) this.presets = payload.presets;
        if (payload.activePaneId && !this.focusedPaneId) this.focusedPaneId = payload.activePaneId;
        this.notify();
        break;
      }

      case 'terminal:output': {
        const { paneId, data } = payload;
        if (paneId && typeof data === 'string' && data) {
          const current = this.paneOutputs.get(paneId) || '';
          let updated: string;
          const clearIdx = Math.max(data.lastIndexOf('\x1b[2J'), data.lastIndexOf('\x1b[3J'), data.lastIndexOf('\x1bc'));
          if (clearIdx >= 0) {
            updated = data.substring(clearIdx);
          } else {
            updated = (current + data).slice(-MAX_PANE_BUFFER);
          }
          this.paneOutputs.set(paneId, updated);
          this.outputListeners.forEach((fn) => {
            try { fn(paneId, data); } catch {}
          });
          this.notify();
        }
        break;
      }

      case 'terminal:resize': {
        const { paneId, cols, rows } = payload;
        if (paneId && cols && rows) {
          this.paneDimensions.set(paneId, { cols, rows });
          this.resizeListeners.forEach((fn) => {
            try { fn(paneId, cols, rows); } catch {}
          });
          this.notify();
        }
        break;
      }

      case 'terminal:sync': {
        const { paneId, cols, rows, buffer } = payload;
        if (paneId) {
          if (cols && rows) {
            this.paneDimensions.set(paneId, { cols, rows });
          }
          if (typeof buffer === 'string') {
            this.paneOutputs.set(paneId, buffer.slice(-MAX_PANE_BUFFER));
          }
          this.syncListeners.forEach((fn) => {
            try { fn(paneId, cols || 80, rows || 24, buffer || ''); } catch {}
          });
          this.notify();
        }
        break;
      }

      case 'workspace:changed': {
        if (payload.activeWorkspaceId) {
          this.activeWorkspaceId = payload.activeWorkspaceId;
          this.notify();
        }
        break;
      }

      case 'task:updated': {
        if (Array.isArray(payload.tasks)) {
          this.tasks = payload.tasks;
          this.notify();
        }
        break;
      }

      case 'swarm:updated': {
        if (Array.isArray(payload.runs)) this.swarmRuns = payload.runs;
        if (Array.isArray(payload.agents)) this.swarmAgents = payload.agents;
        this.notify();
        break;
      }

      case 'diff:data': {
        this.gitDiff = typeof payload.diff === 'string' ? payload.diff : '';
        this.gitDiffError = typeof payload.error === 'string' ? payload.error : null;
        this.gitDiffVersion++;
        this.notify();
        break;
      }

      case 'files:listing': {
        const path = typeof payload.path === 'string' ? payload.path : '';
        if (typeof payload.root === 'string' && payload.root !== this.projectRoot) {
          // Focused project changed on the desktop: the old tree no longer applies.
          if (this.projectRoot) this.directories = {};
          this.projectRoot = payload.root;
        }
        const entries: FileEntry[] = Array.isArray(payload.entries) ? payload.entries : [];
        this.directories = {
          ...this.directories,
          [path]: { entries, loading: false, error: typeof payload.error === 'string' ? payload.error : undefined },
        };
        this.notify();
        break;
      }

      case 'files:content': {
        if (this.filePreview && this.filePreview.path === payload.path) {
          this.filePreview = {
            path: payload.path,
            content: typeof payload.content === 'string' ? payload.content : '',
            loading: false,
            error: typeof payload.error === 'string' ? payload.error : undefined,
            truncated: !!payload.truncated,
            binary: !!payload.binary,
            totalSize: typeof payload.totalSize === 'number' ? payload.totalSize : undefined,
          };
          this.notify();
        }
        break;
      }

      case 'history:data': {
        this.history = Array.isArray(payload.runs)
          ? payload.runs.map((r: any) => ({ ...r, agents: Array.isArray(r.agents) ? r.agents : [] }))
          : [];
        this.historyError = typeof payload.error === 'string' ? payload.error : null;
        this.historyLoading = false;
        this.notify();
        break;
      }

      case 'error': {
        this.lastCommandError = typeof payload.message === 'string' ? payload.message : 'Desktop command failed';
        this.notify();
        break;
      }
    }
  }
}

export const socketService = new SocketService();
