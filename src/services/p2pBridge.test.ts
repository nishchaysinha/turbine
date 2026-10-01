import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const { P2PBridge } = await import('./p2pBridge');
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
    invokeMock.mockResolvedValueOnce('diff --git a b');
    await receive('diff:request', { projectPath: '.' });
    expect(invokeMock).toHaveBeenCalledWith('get_git_diff', { path: '/repo' });
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
