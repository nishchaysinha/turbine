import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const { P2PBridge, safeRelativePath, statusForEntry } = await import('./p2pBridge');
const { useWorkspaceStore } = await import('../state/workspaceStore');
const { useTaskStore } = await import('../state/taskStore');
const { useSwarmStore } = await import('../state/swarmStore');
const { useAgentStore } = await import('../state/agentStore');

type Sent = { type: string; payload: any };
const last = (sent: Sent[]): Sent | undefined => sent[sent.length - 1];

function connectedBridge() {
  const bridge = new P2PBridge();
  const sent: Sent[] = [];
  const dc = { readyState: 'open', send: (raw: string) => sent.push(JSON.parse(raw)) };
  Object.assign(bridge as any, { dc, status: 'connected' });
  const receive = (type: string, payload?: unknown) =>
    (bridge as any).handleMessage(JSON.stringify({ type, payload }));
  return { bridge, sent, receive };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    activeWorkspaceId: 'ws1',
    workspaces: [
      {
        id: 'ws1',
        name: 'Main',
        tabColor: null,
        tabOrder: 0,
        isActive: true,
        boardColumns: null,
        layout: { type: 'leaf', paneId: 'p1' },
        panes: [
          { id: 'p1', workspaceId: 'ws1', type: 'terminal', workingDirectory: '/repo', startupCommand: null, label: null, title: null, taskId: null } as any,
        ],
      },
    ] as any,
  });
  useTaskStore.setState({ tasks: [] });
  useSwarmStore.setState({ runs: [], agents: new Map() });
  useAgentStore.setState({ presets: [{ id: 'builder', name: 'Builder', role: 'builder', cli_command_template: 'x' }] });
});

describe('P2PBridge protocol', () => {
  it('writes mobile keystrokes to the PTY as bytes', async () => {
    const { receive } = connectedBridge();
    await receive('terminal:input', { paneId: 'p1', data: 'ls\r' });
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { paneId: 'p1', data: [108, 115, 13] });
  });

  it('requests git diff with the command argument name and resolved path', async () => {
    const { receive, sent } = connectedBridge();
    invokeMock.mockResolvedValueOnce({ diff: 'diff --git a b', branch: 'main', truncated: false });
    await receive('diff:request', { projectPath: '.' });
    expect(invokeMock).toHaveBeenCalledWith('get_git_review', { path: '/repo', scope: 'all' });
    expect(last(sent)).toMatchObject({ type: 'diff:data', payload: { projectPath: '/repo', diff: 'diff --git a b' } });
  });

  it('reports diff failures instead of pretending they are diffs', async () => {
    const { receive, sent } = connectedBridge();
    invokeMock.mockRejectedValueOnce('Git error: not a repo');
    await receive('diff:request', {});
    expect(last(sent)?.payload).toMatchObject({ diff: '', error: 'Git error: not a repo' });
  });

  it('flattens swarm agents (a Map) into an array for the phone', () => {
    const { bridge, sent } = connectedBridge();
    useSwarmStore.setState({ agents: new Map([['r1', [{ id: 'a1', swarm_run_id: 'r1' } as any]]]) });
    bridge.syncState();
    const sync = sent.find((m) => m.type === 'state:sync')!;
    expect(sync.payload.swarmAgents).toEqual([{ id: 'a1', swarm_run_id: 'r1' }]);
    expect(sync.payload.presets).toEqual([{ id: 'builder', name: 'Builder', role: 'builder' }]);
  });

  it('starts a swarm run and spawns an agent for it', async () => {
    const { receive, sent } = connectedBridge();
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === 'swarm_spawn_agent' ? { id: 'a1', swarm_run_id: 'r', pane_id: 'pp', role: 'builder' } : undefined,
    );
    await receive('swarm:start', { prompt: 'fix tests' });
    const spawn = invokeMock.mock.calls.find((c) => c[0] === 'swarm_spawn_agent');
    expect(spawn?.[1]).toMatchObject({ presetId: 'builder', prompt: 'fix tests', cwd: '/repo' });
    expect(last(sent)?.type).toBe('swarm:updated');
    expect(last(sent)?.payload.agents).toHaveLength(1);
  });

  it('creates tasks in the active project and pushes the task list back', async () => {
    const { receive, sent } = connectedBridge();
    await receive('task:create', { title: ' New thing ', projectPath: '.' });
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ title: 'New thing', project_path: '/repo' });
    expect(last(sent)?.type).toBe('task:updated');
  });

  it('replays the terminal buffer on pane switch and answers pings', async () => {
    const { bridge, receive, sent } = connectedBridge();
    bridge.setTerminalDimensions('p1', 100, 30);
    bridge.sendTerminalOutput('p1', 'hello');
    await receive('terminal:switch_pane', { paneId: 'p1' });
    expect(last(sent)).toMatchObject({ type: 'terminal:sync', payload: { paneId: 'p1', cols: 100, rows: 30, buffer: 'hello' } });
    await receive('ping', { clientTime: 42 });
    expect(last(sent)).toMatchObject({ type: 'pong', payload: { clientTime: 42 } });
  });

  it('does not resend identical terminal dimensions', () => {
    const { bridge, sent } = connectedBridge();
    bridge.setTerminalDimensions('p1', 80, 24);
    bridge.setTerminalDimensions('p1', 80, 24);
    expect(sent.filter((m) => m.type === 'terminal:resize')).toHaveLength(1);
  });

  it('stops an agent on request', async () => {
    const { receive, sent } = connectedBridge();
    useSwarmStore.setState({ agents: new Map([['r1', [{ id: 'a1', swarm_run_id: 'r1', status: 'running' } as any]]]) });
    await receive('swarm:kill_agent', { agentId: 'a1' });
    expect(invokeMock).toHaveBeenCalledWith('swarm_kill_agent', { agentId: 'a1' });
    expect(last(sent)?.payload.agents[0].status).toBe('cancelled');
  });

  it('ignores malformed messages', async () => {
    const { bridge } = connectedBridge();
    await expect((bridge as any).handleMessage('{oops')).resolves.toBeUndefined();
  });
});

describe('path safety', () => {
  it('keeps the phone inside the project root', () => {
    expect(safeRelativePath('')).toBe('');
    expect(safeRelativePath('src//lib/./x.ts')).toBe('src/lib/x.ts');
    expect(safeRelativePath('./src')).toBe('src');
    expect(safeRelativePath('../etc/passwd')).toBeNull();
    expect(safeRelativePath('src/../../x')).toBeNull();
    expect(safeRelativePath('/etc/passwd')).toBeNull();
    expect(safeRelativePath('C:/Windows')).toBeNull();
    expect(safeRelativePath(42)).toBeNull();
  });

  it('rolls git status up to directories', () => {
    const statuses = { 'src/a.ts': ' M', 'docs/new.md': '??' };
    expect(statusForEntry('src/a.ts', false, statuses)).toBe('M');
    expect(statusForEntry('src', true, statuses)).toBe('M');
    expect(statusForEntry('docs', true, statuses)).toBe('??');
    expect(statusForEntry('lib', true, statuses)).toBeUndefined();
  });
});

describe('P2PBridge files and history', () => {
  // Exactly what the Rust command returns (snake_case fields).
  const tree = [
    { path: '/repo/README.md', relative_path: 'README.md', is_dir: false },
    { path: '/repo/src', relative_path: 'src', is_dir: true },
    { path: '/repo/src/server.ts', relative_path: 'src/server.ts', is_dir: false },
    { path: '/repo/src/lib', relative_path: 'src/lib', is_dir: true },
    { path: '/repo/src/lib/db.ts', relative_path: 'src/lib/db.ts', is_dir: false },
  ];

  beforeEach(() => {
    invokeMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'list_workspace_files') return tree;
      if (cmd === 'git_status') return { 'src/server.ts': ' M' };
      if (cmd === 'read_file') return { content: `content of ${args.path}`, totalSize: 20, offset: 0, isComplete: true };
      if (cmd === 'load_swarm_runs')
        return [
          { id: 'old', prompt: 'old run', started_at: '2026-09-01T10:00:00Z' },
          { id: 'new', prompt: 'new run', started_at: '2026-10-01T10:00:00Z' },
        ];
      if (cmd === 'load_swarm_agents') return [{ id: `a-${args.swarmRunId}`, role: 'builder' }];
      return undefined;
    });
  });

  it('lists one directory level with git badges', async () => {
    const { receive, sent } = connectedBridge();
    await receive('files:list', { path: '' });
    expect(last(sent)).toMatchObject({ type: 'files:listing', payload: { root: '/repo', path: '' } });
    expect(last(sent)!.payload.entries.map((e: any) => `${e.name}:${e.isDir}:${e.status ?? ''}`)).toEqual([
      'README.md:false:',
      'src:true:M',
    ]);
    await receive('files:list', { path: 'src' });
    expect(last(sent)!.payload.entries.map((e: any) => e.path)).toEqual(['src/server.ts', 'src/lib']);
    // Second listing within the TTL reuses the cached tree.
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'list_workspace_files')).toHaveLength(1);
  });

  it('refuses to browse or read outside the project', async () => {
    const { receive, sent } = connectedBridge();
    await receive('files:list', { path: '../..' });
    expect(last(sent)!.payload.error).toMatch(/outside/);
    await receive('files:read', { path: '/etc/passwd' });
    expect(last(sent)!.payload.error).toMatch(/outside/);
    expect(invokeMock.mock.calls.some((c) => c[0] === 'read_file')).toBe(false);
  });

  it('reads a file relative to the project root', async () => {
    const { receive, sent } = connectedBridge();
    await receive('files:read', { path: 'src/server.ts' });
    expect(invokeMock).toHaveBeenCalledWith('read_file', { path: '/repo/src/server.ts', offset: 0, limit: 204800 });
    expect(last(sent)).toMatchObject({
      type: 'files:content',
      payload: { path: 'src/server.ts', content: 'content of /repo/src/server.ts', truncated: false },
    });
  });

  it('returns run history newest first with agents', async () => {
    const { receive, sent } = connectedBridge();
    await receive('history:request', {});
    const payload = last(sent)!.payload;
    expect(invokeMock).toHaveBeenCalledWith('load_swarm_runs', { projectPath: '/repo' });
    expect(payload.runs.map((r: any) => r.id)).toEqual(['new', 'old']);
    expect(payload.runs[0].agents).toEqual([{ id: 'a-new', role: 'builder' }]);
  });

  it('prefers live run status and agents over the stale DB copy', async () => {
    useSwarmStore.setState({
      runs: [{ id: 'new', status: 'Completed', prompt: 'new run' } as any],
      agents: new Map([['new', [{ id: 'live-agent', status: 'completed' } as any]]]),
    });
    const { receive, sent } = connectedBridge();
    await receive('history:request', {});
    const run = last(sent)!.payload.runs[0];
    expect(run.status).toBe('Completed');
    expect(run.agents).toEqual([{ id: 'live-agent', status: 'completed' }]);
  });
});

describe('P2PBridge protocol v2 (rpc)', () => {
  const rpc = async (receive: (t: string, p?: unknown) => Promise<void>, sent: Sent[], method: string, params?: unknown) => {
    const id = `r${Math.random()}`;
    await receive('rpc', { id, method, params });
    return sent.find((m) => m.type === 'rpc:result' && m.payload.id === id)!.payload;
  };

  it('negotiates capabilities in hello', async () => {
    const { receive, sent } = connectedBridge();
    const res = await rpc(receive, sent, 'hello', { protocol: 2, capabilities: ['rpc', 'terminal.subscribe'] });
    expect(res).toMatchObject({ ok: true, result: { protocol: 2, capabilities: expect.arrayContaining(['rpc', 'agents', 'terminal.subscribe']) } });
  });

  it('streams terminal output only for subscribed panes once negotiated', async () => {
    const { bridge, receive, sent } = connectedBridge();
    bridge.sendTerminalOutput('p1', 'legacy');
    expect(sent.filter((m) => m.type === 'terminal:output')).toHaveLength(1);

    await rpc(receive, sent, 'hello', { capabilities: ['rpc', 'terminal.subscribe'] });
    bridge.sendTerminalOutput('p1', 'hidden');
    expect(sent.filter((m) => m.type === 'terminal:output')).toHaveLength(1);

    await rpc(receive, sent, 'terminal.subscribe', { paneIds: ['p1'] });
    // Subscribing replays the buffer (including output produced while hidden).
    expect(last(sent.filter((m) => m.type === 'terminal:sync'))?.payload.buffer).toBe('legacyhidden');
    bridge.sendTerminalOutput('p1', 'live');
    expect(last(sent.filter((m) => m.type === 'terminal:output'))?.payload.data).toBe('live');
  });

  it('keeps streaming everything for legacy phones that never say hello', () => {
    const { bridge, sent } = connectedBridge();
    bridge.sendTerminalOutput('p9', 'x');
    expect(last(sent)?.type).toBe('terminal:output');
  });

  it('returns structured errors', async () => {
    const { receive, sent } = connectedBridge();
    expect(await rpc(receive, sent, 'nope')).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
    expect(await rpc(receive, sent, 'task.create', { title: '  ' })).toMatchObject({ ok: false, error: { code: 'bad_params' } });
    expect(await rpc(receive, sent, 'workspace.switch', { workspaceId: 'zzz' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await rpc(receive, sent, 'agents.action', { paneId: 'ghost', action: 'approve' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('runs agent actions against the pane PTY', async () => {
    const { receive, sent } = connectedBridge();
    expect(await rpc(receive, sent, 'agents.action', { paneId: 'p1', action: 'approve' })).toMatchObject({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith('pty_write', { paneId: 'p1', data: [13] });
    await rpc(receive, sent, 'agents.action', { paneId: 'p1', action: 'prompt', text: 'line one\nline two' });
    const writes = invokeMock.mock.calls.filter((c) => c[0] === 'pty_write');
    const data = writes[writes.length - 1][1].data as number[];
    expect(new TextDecoder().decode(new Uint8Array(data))).toBe('\x1b[200~line one\nline two\x1b[201~\r');
  });

  it('answers diff.get and state.get with results', async () => {
    const { receive, sent } = connectedBridge();
    invokeMock.mockResolvedValueOnce({ diff: 'diff --git a b', branch: 'main', truncated: false });
    expect(await rpc(receive, sent, 'diff.get', {})).toMatchObject({ ok: true, result: { projectPath: '/repo', diff: 'diff --git a b', branch: 'main' } });
    const state = await rpc(receive, sent, 'state.get');
    expect(state.result.workspaces).toHaveLength(1);
    expect(Array.isArray(state.result.agentStatus)).toBe(true);
  });

  it('mirrors agent status rows to the phone', async () => {
    const { useAgentStatusStore } = await import('../state/agentStatusStore');
    const { bridge, sent } = connectedBridge();
    (bridge as any).watchStores();
    const row = { paneId: 'p1', state: 'blocked', agent: 'claude', prompt: null, tool: null, toolInput: null, message: 'perm', exitCode: null, sessionId: null, startedAt: 1, updatedAt: 1, lastEvent: 'Notification' };
    useAgentStatusStore.setState({ rows: { p1: row as any } });
    expect(last(sent)).toMatchObject({ type: 'agents:status', payload: { row: { paneId: 'p1', state: 'blocked' } } });
    useAgentStatusStore.setState({ rows: {} });
    expect(last(sent)).toMatchObject({ type: 'agents:clear', payload: { paneId: 'p1' } });
    (bridge as any).unwatchStores();
  });
});
