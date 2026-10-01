import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useTaskStore } from '../state/taskStore';
import { useSwarmStore } from '../state/swarmStore';
import { useAgentStore } from '../state/agentStore';
import type { RelayConnectionStatus, RelaySessionInfo, RelayPeerInfo } from '../types/relay';
import { onPtyOutput } from '../utils/ptyData';

type StatusListener = (status: RelayConnectionStatus) => void;
type PeerListener = (peers: RelayPeerInfo[]) => void;
type SessionListener = (session: RelaySessionInfo | null) => void;

export const DEFAULT_SIGNALING_URL = 'https://signaling-taupe.vercel.app';
const SIGNALING_URL_KEY = 'turbine_signaling_url';
const PAIRING_KEY = 'turbine_p2p_pairing';

const ICE_GATHER_TIMEOUT_MS = 1500;
const POLL_FAST_MS = 1500;
const POLL_SLOW_MS = 8000;
const POLL_FAST_WINDOW_MS = 3 * 60 * 1000;
const REARM_DELAY_MS = 1000;
const TERMINAL_BUFFER_BYTES = 256 * 1024;
const FILE_TREE_TTL_MS = 15000;
const FILE_PREVIEW_BYTES = 200 * 1024;
const HISTORY_RUN_LIMIT = 50;

interface FileTreeEntry {
  path: string;
  relativePath: string;
  isDir: boolean;
}

interface FileContent {
  content: string;
  totalSize: number;
  isComplete: boolean;
}

/**
 * Normalizes a phone-supplied path relative to the project root. Rejects
 * absolute paths and `..` so the phone can only browse inside the project.
 */
export function safeRelativePath(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const parts = cleaned.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** Folds `git status --porcelain` codes onto a directory listing (dirs get the "strongest" child status). */
export function statusForEntry(rel: string, isDir: boolean, statuses: Record<string, string>): string | undefined {
  if (!isDir) return statuses[rel]?.trim() || undefined;
  const prefix = `${rel}/`;
  for (const [path, code] of Object.entries(statuses)) {
    if (path.startsWith(prefix)) return code.trim() === '??' ? '??' : 'M';
  }
  return undefined;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

interface SavedPairing {
  code: string;
  token: string;
  signalingUrl: string;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function loadSavedPairing(): SavedPairing | null {
  try {
    const parsed = JSON.parse(readStorage(PAIRING_KEY) || 'null');
    if (parsed && typeof parsed.code === 'string' && typeof parsed.token === 'string') return parsed;
  } catch {}
  return null;
}

/**
 * Desktop side of the mobile companion link. Publishes a WebRTC offer to the
 * signaling service, waits for the phone's answer, then speaks the JSON
 * `{ type, payload }` protocol over a single ordered DataChannel.
 *
 * The pairing code + token are remembered, so after the phone drops (or
 * Turbine restarts) the same code is re-armed with a fresh offer and the
 * phone can simply reconnect with it.
 */
export class P2PBridge {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private status: RelayConnectionStatus = 'disconnected';
  private session: RelaySessionInfo | null = null;
  private peers: RelayPeerInfo[] = [];
  private signalingUrl: string = DEFAULT_SIGNALING_URL;
  private activePaneId: string | null = null;
  private pollTimer: number | null = null;
  private pingTimer: number | null = null;
  private rearmTimer: number | null = null;
  private latencyMs: number | null = null;
  private offerVersion: number | null = null;
  /** Incremented on every connect/disconnect so stale async work can bail out. */
  private generation = 0;
  private storeUnsubs: Array<() => void> = [];
  private fileTreeCache = new Map<string, { at: number; entries: FileTreeEntry[]; statuses: Record<string, string> }>();
  private terminalBuffers = new Map<string, string>();
  private terminalDimensions = new Map<string, { cols: number; rows: number }>();

  private statusListeners = new Set<StatusListener>();
  private peerListeners = new Set<PeerListener>();
  private sessionListeners = new Set<SessionListener>();

  constructor() {
    const saved = readStorage(SIGNALING_URL_KEY);
    if (saved) {
      this.signalingUrl = saved;
    }
  }

  public getStatus(): RelayConnectionStatus {
    return this.status;
  }

  public getSession(): RelaySessionInfo | null {
    return this.session;
  }

  public getLatency(): number | null {
    return this.latencyMs;
  }

  public getPeers(): RelayPeerInfo[] {
    return this.peers;
  }

  public getSignalingUrl(): string {
    return this.signalingUrl;
  }

  public isConnected(): boolean {
    return this.status === 'connected' && this.dc?.readyState === 'open';
  }

  public setSignalingUrl(url: string) {
    this.signalingUrl = url.trim().replace(/\/+$/, '') || DEFAULT_SIGNALING_URL;
    writeStorage(SIGNALING_URL_KEY, this.signalingUrl);
  }

  public setActivePaneId(paneId: string | null) {
    this.activePaneId = paneId;
  }

  public onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  public onPeersChange(listener: PeerListener): () => void {
    this.peerListeners.add(listener);
    listener(this.peers);
    return () => this.peerListeners.delete(listener);
  }

  public onSessionChange(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);
    listener(this.session);
    return () => this.sessionListeners.delete(listener);
  }

  private setStatus(status: RelayConnectionStatus) {
    this.status = status;
    this.statusListeners.forEach((fn) => fn(status));
  }

  private setSession(session: RelaySessionInfo | null) {
    this.session = session;
    this.sessionListeners.forEach((fn) => fn(session));
  }

  private setPeers(peers: RelayPeerInfo[]) {
    this.peers = peers;
    this.peerListeners.forEach((fn) => fn(peers));
  }

  /**
   * Create a fresh offer and register it with the signaling service.
   * Reuses the remembered pairing code unless `fresh` is set.
   */
  public async connect(customSignalingUrl?: string, options: { fresh?: boolean } = {}): Promise<RelaySessionInfo> {
    if (customSignalingUrl) {
      this.setSignalingUrl(customSignalingUrl);
    }
    if (options.fresh) {
      writeStorage(PAIRING_KEY, null);
    }
    this.teardownPeer();
    const gen = ++this.generation;
    this.setStatus('connecting');

    try {
      const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
      this.pc = pc;

      const dc = pc.createDataChannel('turbine-p2p', { ordered: true });
      this.dc = dc;
      this.setupDataChannel(dc, gen);

      pc.onconnectionstatechange = () => {
        if (gen !== this.generation) return;
        if (pc.connectionState === 'failed') {
          this.handlePeerLost(gen);
        }
      };

      const localCandidates: RTCIceCandidateInit[] = [];
      const iceDone = new Promise<void>((resolve) => {
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            localCandidates.push(event.candidate.toJSON());
          } else {
            resolve();
          }
        };
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await Promise.race([iceDone, new Promise((r) => setTimeout(r, ICE_GATHER_TIMEOUT_MS))]);
      if (gen !== this.generation) throw new Error('Pairing was cancelled');

      const result = await this.registerOffer(pc.localDescription, localCandidates);
      if (gen !== this.generation) throw new Error('Pairing was cancelled');

      this.offerVersion = typeof result.offerVersion === 'number' ? result.offerVersion : null;
      writeStorage(
        PAIRING_KEY,
        JSON.stringify({ code: result.code, token: result.token, signalingUrl: this.signalingUrl } satisfies SavedPairing),
      );

      const sessionInfo: RelaySessionInfo = {
        sessionId: result.code,
        pairingCode: result.code,
        token: result.token,
        relayUrl: this.signalingUrl,
        region: 'P2P (WebRTC)',
        expiresAt: result.expiresAt,
      };
      this.setSession(sessionInfo);
      this.startPollingAnswer(sessionInfo, gen);
      return sessionInfo;
    } catch (err) {
      if (gen === this.generation) {
        this.teardownPeer();
        this.setStatus('error');
      }
      throw err;
    }
  }

  /** POST the offer, re-using the saved code when possible and falling back to a new one. */
  private async registerOffer(
    offer: RTCSessionDescription | null,
    candidates: RTCIceCandidateInit[],
  ): Promise<{ code: string; token: string; expiresAt: number; offerVersion?: number }> {
    const saved = loadSavedPairing();
    const reuse = saved && saved.signalingUrl === this.signalingUrl ? saved : null;

    const post = (extra: Partial<SavedPairing>) =>
      fetch(`${this.signalingUrl}/api/pair/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer, candidates, ...extra }),
      });

    let resp = await post(reuse ? { code: reuse.code, token: reuse.token } : {});
    if (!resp.ok && reuse && resp.status >= 400 && resp.status < 500) {
      // Code expired or taken: start over with a new one.
      writeStorage(PAIRING_KEY, null);
      resp = await post({});
    }
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        detail = (await resp.json()).error || detail;
      } catch {}
      throw new Error(`Signaling error (${resp.status}): ${detail}`);
    }
    return resp.json();
  }

  private setupDataChannel(dc: RTCDataChannel, gen: number) {
    dc.onopen = () => {
      if (gen !== this.generation) return;
      this.stopPollingAnswer();
      this.setStatus('connected');
      this.setPeers([{ role: 'mobile', deviceName: 'Direct Phone (P2P)', timestamp: Date.now() }]);
      this.watchStores();
      this.syncFullState();

      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        this.send('ping', { clientTime: Date.now() });
      }, 4000);
      this.send('ping', { clientTime: Date.now() });
    };

    dc.onmessage = (event) => {
      if (gen !== this.generation) return;
      void this.handleMessage(event.data);
    };

    dc.onclose = () => this.handlePeerLost(gen);

    dc.onerror = () => {
      if (gen !== this.generation) return;
      console.warn('[P2PBridge] DataChannel error');
    };
  }

  /** The phone went away: re-arm the same pairing code so it can reconnect. */
  private handlePeerLost(gen: number) {
    if (gen !== this.generation) return;
    this.teardownPeer();
    this.setStatus('disconnected');
    if (!this.session) return;

    if (this.rearmTimer) clearTimeout(this.rearmTimer);
    this.rearmTimer = window.setTimeout(() => {
      this.rearmTimer = null;
      if (gen !== this.generation) return;
      this.connect().catch((e) => console.warn('[P2PBridge] Failed to re-arm pairing:', e));
    }, REARM_DELAY_MS);
  }

  private startPollingAnswer(session: RelaySessionInfo, gen: number) {
    this.stopPollingAnswer();
    const startedAt = Date.now();
    const url = `${this.signalingUrl}/api/pair/${encodeURIComponent(session.pairingCode)}?token=${encodeURIComponent(session.token)}`;

    const checkAnswer = async () => {
      if (gen !== this.generation || !this.pc || this.status === 'connected') return;
      try {
        const resp = await fetch(url);
        if (gen !== this.generation) return;
        if (resp.status === 404 || resp.status === 401) {
          // Session expired or was taken over: get a brand new code.
          this.connect(undefined, { fresh: true }).catch(() => {});
          return;
        }
        if (!resp.ok) return;
        const data = await resp.json();
        if (gen !== this.generation || !this.pc || this.pc.currentRemoteDescription || !data.answer) return;
        if (this.offerVersion !== null && data.offerVersion !== undefined && data.offerVersion !== this.offerVersion) {
          return;
        }
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        for (const cand of Array.isArray(data.answerCandidates) ? data.answerCandidates : []) {
          try {
            await this.pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {}
        }
      } catch {}
    };

    const schedule = () => {
      const delay = Date.now() - startedAt < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
      this.pollTimer = window.setTimeout(async () => {
        await checkAnswer();
        if (gen === this.generation && this.pollTimer !== null && this.status !== 'connected') schedule();
      }, delay);
    };
    void checkAnswer();
    schedule();
  }

  private stopPollingAnswer() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Close the peer connection but keep the session/pairing code. */
  private teardownPeer() {
    this.stopPollingAnswer();
    this.unwatchStores();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.dc) {
      const dc = this.dc;
      this.dc = null;
      dc.onopen = dc.onclose = dc.onmessage = dc.onerror = null;
      try { dc.close(); } catch {}
    }
    if (this.pc) {
      const pc = this.pc;
      this.pc = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
    if (this.peers.length > 0) this.setPeers([]);
    this.latencyMs = null;
  }

  /** Stop pairing entirely. The remembered code stays valid for the next Start. */
  public disconnect() {
    this.generation++;
    if (this.rearmTimer) {
      clearTimeout(this.rearmTimer);
      this.rearmTimer = null;
    }
    this.teardownPeer();
    this.offerVersion = null;
    this.setSession(null);
    this.setStatus('disconnected');
  }

  public send(type: string, payload: unknown) {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
    }
  }

  public setTerminalDimensions(paneId: string, cols: number, rows: number) {
    const prev = this.terminalDimensions.get(paneId);
    if (prev && prev.cols === cols && prev.rows === rows) return;
    this.terminalDimensions.set(paneId, { cols, rows });
    this.send('terminal:resize', { paneId, cols, rows });
  }

  public getTerminalDimensions(paneId: string): { cols: number; rows: number } | undefined {
    return this.terminalDimensions.get(paneId);
  }

  public getReplayBuffer(paneId: string): string {
    return this.terminalBuffers.get(paneId) || '';
  }

  public sendTerminalOutput(paneId: string, data: string) {
    const cur = this.terminalBuffers.get(paneId) || '';
    this.terminalBuffers.set(paneId, (cur + data).slice(-TERMINAL_BUFFER_BYTES));
    this.send('terminal:output', { paneId, data });
  }

  /** Forget buffered output for a pane that no longer exists. */
  public forgetPane(paneId: string) {
    this.terminalBuffers.delete(paneId);
    this.terminalDimensions.delete(paneId);
  }

  private sendTerminalSync(paneId: string) {
    const dims = this.terminalDimensions.get(paneId) || { cols: 80, rows: 24 };
    this.send('terminal:sync', {
      paneId,
      cols: dims.cols,
      rows: dims.rows,
      buffer: this.terminalBuffers.get(paneId) || '',
    });
  }

  private swarmSnapshot() {
    const swarm = useSwarmStore.getState();
    return {
      runs: swarm.runs,
      // `agents` is a Map keyed by run id; Maps serialise to `{}` so flatten it.
      agents: Array.from(swarm.agents.values()).flat(),
    };
  }

  /** Lightweight state push (no terminal buffers). Safe to call often. */
  public syncState() {
    if (!this.isConnected()) return;
    const wsState = useWorkspaceStore.getState();
    const { runs, agents } = this.swarmSnapshot();
    this.send('state:sync', {
      workspaces: wsState.workspaces,
      activeWorkspaceId: wsState.activeWorkspaceId,
      tasks: useTaskStore.getState().tasks,
      swarmRuns: runs,
      swarmAgents: agents,
      presets: useAgentStore.getState().presets.map((p) => ({ id: p.id, name: p.name, role: p.role })),
      activePaneId: this.activePaneId,
    });
  }

  /** Full state + every terminal's replay buffer. Sent once when the phone connects. */
  public syncFullState() {
    if (!this.isConnected()) return;
    this.syncState();
    for (const paneId of this.terminalDimensions.keys()) {
      this.sendTerminalSync(paneId);
    }
  }

  private watchStores() {
    this.unwatchStores();
    if (useAgentStore.getState().presets.length === 0) {
      void useAgentStore.getState().loadPresets();
    }

    let tasksQueued = false;
    let swarmQueued = false;
    this.storeUnsubs.push(
      useTaskStore.subscribe((s, prev) => {
        if (s.tasks === prev.tasks || tasksQueued) return;
        tasksQueued = true;
        setTimeout(() => {
          tasksQueued = false;
          this.send('task:updated', { tasks: useTaskStore.getState().tasks });
        }, 100);
      }),
      useSwarmStore.subscribe((s, prev) => {
        if ((s.runs === prev.runs && s.agents === prev.agents) || swarmQueued) return;
        swarmQueued = true;
        setTimeout(() => {
          swarmQueued = false;
          this.send('swarm:updated', this.swarmSnapshot());
        }, 100);
      }),
      useAgentStore.subscribe((s, prev) => {
        if (s.presets !== prev.presets) this.syncState();
      }),
    );
  }

  private unwatchStores() {
    this.storeUnsubs.forEach((fn) => fn());
    this.storeUnsubs = [];
  }

  /**
   * Resolve the directory a mobile command should act on. The phone only
   * knows "." so map that to the focused pane's (or workspace's) directory.
   */
  public resolveProjectPath(requested?: unknown): string {
    if (typeof requested === 'string' && requested && requested !== '.') return requested;
    const ws = useWorkspaceStore.getState();
    const active = ws.workspaces.find((w) => w.id === ws.activeWorkspaceId);
    const panes = active?.panes ?? [];
    const pane =
      panes.find((p) => p.id === this.activePaneId && p.workingDirectory) ??
      panes.find((p) => p.workingDirectory);
    return pane?.workingDirectory || '.';
  }

  private async handleMessage(raw: string) {
    let msg: { type?: string; payload?: any };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('[P2PBridge] Ignoring malformed message');
      return;
    }

    try {
      const payload = msg.payload || {};
      switch (msg.type) {
        case 'terminal:request_sync': {
          const targetPane = payload.paneId || this.activePaneId;
          if (targetPane) this.sendTerminalSync(targetPane);
          break;
        }

        case 'terminal:input': {
          const targetPane = payload.paneId || this.activePaneId;
          if (targetPane && typeof payload.data === 'string') {
            await invoke('pty_write', {
              paneId: targetPane,
              data: Array.from(new TextEncoder().encode(payload.data)),
            });
          }
          break;
        }

        case 'terminal:resize': {
          const targetPane = payload.paneId || this.activePaneId;
          const cols = Number(payload.cols);
          const rows = Number(payload.rows);
          if (targetPane && cols > 0 && rows > 0) {
            this.terminalDimensions.set(targetPane, { cols, rows });
            await invoke('pty_resize', { paneId: targetPane, cols, rows });
          }
          break;
        }

        case 'terminal:switch_pane': {
          if (payload.paneId) {
            this.activePaneId = payload.paneId;
            this.sendTerminalSync(payload.paneId);
          }
          break;
        }

        case 'workspace:switch': {
          if (payload.workspaceId) {
            useWorkspaceStore.getState().switchWorkspace(payload.workspaceId);
            this.send('workspace:changed', { activeWorkspaceId: useWorkspaceStore.getState().activeWorkspaceId });
          }
          break;
        }

        case 'task:update_status': {
          const { id, status } = payload;
          if (id && status) {
            const taskStore = useTaskStore.getState();
            const existing = taskStore.tasks.find((t) => t.id === id);
            if (existing) {
              await taskStore.updateTask({ ...existing, status });
            }
            this.send('task:updated', { tasks: useTaskStore.getState().tasks });
          }
          break;
        }

        case 'task:create': {
          if (typeof payload.title === 'string' && payload.title.trim()) {
            await useTaskStore.getState().createTask(this.resolveProjectPath(payload.projectPath), payload.title.trim());
            this.send('task:updated', { tasks: useTaskStore.getState().tasks });
          }
          break;
        }

        case 'diff:request': {
          const projectPath = this.resolveProjectPath(payload.projectPath);
          try {
            const diff = await invoke<string>('get_git_diff', { path: projectPath });
            this.send('diff:data', { projectPath, diff });
          } catch (e) {
            this.send('diff:data', { projectPath, diff: '', error: String(e) });
          }
          break;
        }

        case 'swarm:start': {
          await this.startSwarm(payload);
          break;
        }

        case 'files:list': {
          await this.sendDirectoryListing(payload.path, payload.refresh === true);
          break;
        }

        case 'files:read': {
          await this.sendFileContent(payload.path);
          break;
        }

        case 'history:request': {
          await this.sendRunHistory();
          break;
        }

        case 'swarm:kill_agent': {
          if (typeof payload.agentId === 'string') {
            await useSwarmStore.getState().killAgent(payload.agentId);
            this.send('swarm:updated', this.swarmSnapshot());
          }
          break;
        }

        case 'pong': {
          const clientTime = Number(payload.clientTime);
          if (clientTime) {
            this.latencyMs = Math.max(1, Date.now() - clientTime);
            this.statusListeners.forEach((fn) => fn(this.status));
          }
          break;
        }

        case 'ping': {
          this.send('pong', { clientTime: payload.clientTime ?? (msg as any).timestamp });
          break;
        }
      }
    } catch (e) {
      console.error('[P2PBridge] Failed to handle message:', msg.type, e);
      this.send('error', { type: msg.type, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async loadFileTree(root: string, refresh: boolean) {
    const cached = this.fileTreeCache.get(root);
    if (cached && !refresh && Date.now() - cached.at < FILE_TREE_TTL_MS) return cached;
    const entries = await invoke<FileTreeEntry[]>('list_workspace_files', { root });
    let statuses: Record<string, string> = {};
    try {
      statuses = await invoke<Record<string, string>>('git_status', { path: root });
    } catch {
      // Not a git repo: no badges.
    }
    const fresh = { at: Date.now(), entries, statuses };
    this.fileTreeCache.set(root, fresh);
    return fresh;
  }

  /** One directory level at a time, like Orca's lazy explorer: cheap to send, cheap to render. */
  private async sendDirectoryListing(requested: unknown, refresh: boolean) {
    const root = this.resolveProjectPath();
    const dir = safeRelativePath(requested);
    if (dir === null) {
      this.send('files:listing', { root, path: String(requested), entries: [], error: 'Path is outside the project' });
      return;
    }
    try {
      const tree = await this.loadFileTree(root, refresh);
      const prefix = dir ? `${dir}/` : '';
      const entries = tree.entries
        .filter((e) => e.relativePath.startsWith(prefix) && !e.relativePath.slice(prefix.length).includes('/'))
        .map((e) => ({
          name: e.relativePath.slice(prefix.length),
          path: e.relativePath,
          isDir: e.isDir,
          status: statusForEntry(e.relativePath, e.isDir, tree.statuses),
        }))
        .filter((e) => e.name);
      this.send('files:listing', { root, path: dir, entries });
    } catch (e) {
      this.send('files:listing', { root, path: dir, entries: [], error: String(e) });
    }
  }

  private async sendFileContent(requested: unknown) {
    const root = this.resolveProjectPath();
    const rel = safeRelativePath(requested);
    if (!rel) {
      this.send('files:content', { path: String(requested), content: '', error: 'Path is outside the project' });
      return;
    }
    try {
      const file = await invoke<FileContent>('read_file', {
        path: `${root.replace(/\/+$/, '')}/${rel}`,
        offset: 0,
        limit: FILE_PREVIEW_BYTES,
      });
      const binary = file.content.slice(0, 4096).includes('\u0000');
      this.send('files:content', {
        path: rel,
        content: binary ? '' : file.content,
        binary,
        truncated: !file.isComplete,
        totalSize: file.totalSize,
      });
    } catch (e) {
      this.send('files:content', { path: rel, content: '', error: String(e) });
    }
  }

  /** Past swarm runs for the active project, newest first, each with its agents. */
  private async sendRunHistory() {
    const projectPath = this.resolveProjectPath();
    try {
      const runs = (await invoke<Array<Record<string, any>>>('load_swarm_runs', { projectPath })) ?? [];
      const recent = [...runs]
        .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')))
        .slice(0, HISTORY_RUN_LIMIT);
      // The DB copy of a run lags behind the store (status/agents are updated in
      // memory as agents spawn and finish), so prefer live state when we have it.
      const live = useSwarmStore.getState();
      const withAgents = await Promise.all(
        recent.map(async (run) => {
          const liveRun = live.runs.find((r) => r.id === run.id);
          let agents: unknown[] | undefined = live.agents.get(run.id);
          if (!agents) {
            try {
              agents = (await invoke<unknown[]>('load_swarm_agents', { swarmRunId: run.id })) ?? [];
            } catch {
              agents = [];
            }
          }
          return { ...run, ...(liveRun ?? {}), agents };
        }),
      );
      this.send('history:data', { projectPath, runs: withAgents });
    } catch (e) {
      this.send('history:data', { projectPath, runs: [], error: String(e) });
    }
  }

  /** Create a run and actually spawn an agent for it (a bare run does nothing). */
  private async startSwarm(payload: { prompt?: unknown; presetId?: unknown; taskId?: unknown }) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) return;

    const agentStore = useAgentStore.getState();
    if (agentStore.presets.length === 0) await agentStore.loadPresets();
    const presets = useAgentStore.getState().presets;
    const preset =
      presets.find((p) => p.id === payload.presetId) ??
      presets.find((p) => /build/i.test(p.role) || /build/i.test(p.name)) ??
      presets[0];
    if (!preset) throw new Error('No agent presets configured on desktop');

    const projectPath = this.resolveProjectPath();
    const ws = useWorkspaceStore.getState();
    const swarm = useSwarmStore.getState();
    const run = await swarm.startAdHocRun(projectPath, prompt, ws.activeWorkspaceId ?? undefined, this.activePaneId);
    await swarm.spawnAgent(run.id, preset.id, prompt, projectPath);
    this.send('swarm:updated', this.swarmSnapshot());
  }
}

export const p2pBridge = new P2PBridge();

// Every pane's output (including swarm agents with no visible pane) reaches the
// phone through the shared tap rather than from individual views.
onPtyOutput((paneId, _bytes, text) => p2pBridge.sendTerminalOutput(paneId, text));
