import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketService } from './socketService';
import { setWebRTCBridge } from './bridgeRegistry';

/** Fake desktop: answers RPC requests synchronously through the bridge. */
function fakeHost(handler: ((method: string, params: any) => unknown) | null) {
  const sent: any[] = [];
  let svc: SocketService;
  const bridge = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn((raw: string) => {
      const msg = JSON.parse(raw);
      sent.push(msg);
      if (msg.type !== 'rpc' || !handler) return;
      const { id, method, params } = msg.payload;
      queueMicrotask(() => {
        try {
          const result = handler(method, params);
          svc.handleMessage(JSON.stringify({ type: 'rpc:result', payload: { id, ok: true, result } }));
        } catch (e: any) {
          svc.handleMessage(JSON.stringify({ type: 'rpc:result', payload: { id, ok: false, error: { code: e.code ?? 'failed', message: e.message } } }));
        }
      });
    }),
  };
  setWebRTCBridge(bridge);
  svc = new SocketService();
  return { svc, sent };
}

async function connect(svc: SocketService) {
  const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' });
  svc.setStatus('connected');
  await p;
  await vi.advanceTimersByTimeAsync(0);
}

describe('protocol v2 on the phone', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setWebRTCBridge(null);
  });

  it('negotiates capabilities with hello after connecting', async () => {
    const { svc, sent } = fakeHost((m) => (m === 'hello' ? { protocol: 2, capabilities: ['rpc', 'agents', 'terminal.subscribe'] } : null));
    await connect(svc);
    const hello = sent.find((m) => m.type === 'rpc' && m.payload.method === 'hello');
    expect(hello.payload.params.capabilities).toContain('terminal.subscribe');
    expect(svc.hostProtocol).toBe(2);
    expect(svc.supports('rpc')).toBe(true);
  });

  it('falls back to legacy messages when the desktop ignores hello', async () => {
    const { svc, sent } = fakeHost(null);
    await connect(svc);
    await vi.advanceTimersByTimeAsync(4100);
    expect(svc.hostProtocol).toBe(1);
    svc.requestDiff('.');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.some((m) => m.type === 'diff:request')).toBe(true);
    await svc.agentAction('p1', 'approve');
    expect(sent.at(-1)).toMatchObject({ type: 'terminal:input', payload: { paneId: 'p1', data: '\r' } });
  });

  it('uses RPC results and surfaces RPC errors', async () => {
    const { svc, sent } = fakeHost((m) => {
      if (m === 'hello') return { protocol: 2, capabilities: ['rpc'] };
      if (m === 'diff.get') return { projectPath: '/repo', diff: 'diff --git a b' };
      if (m === 'task.create') throw Object.assign(new Error('A title is required'), { code: 'bad_params' });
      return null;
    });
    await connect(svc);
    svc.requestDiff('.');
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.gitDiff).toBe('diff --git a b');
    expect(sent.some((m) => m.type === 'diff:request')).toBe(false);
    svc.createTask(' ');
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.lastCommandError).toBe('A title is required');
  });

  it('rejects pending requests on timeout and on disconnect', async () => {
    const { svc } = fakeHost((m) => (m === 'hello' ? { protocol: 2, capabilities: ['rpc'] } : undefined));
    await connect(svc);
    const never = new SocketService();
    setWebRTCBridge({ connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() });
    const p = never.request('x', {}, 1000);
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    const p2 = never.request('y');
    never.disconnect();
    await expect(p2).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('subscribes to visible panes only when the host supports it, and re-subscribes after reconnect', async () => {
    const calls: string[][] = [];
    const { svc } = fakeHost((m, p) => {
      if (m === 'hello') return { protocol: 2, capabilities: ['rpc', 'terminal.subscribe'] };
      if (m === 'terminal.subscribe') calls.push(p.paneIds);
      return null;
    });
    svc.subscribeTerminals(['b', 'a']);
    await connect(svc);
    expect(calls).toEqual([['a', 'b']]);
    svc.subscribeTerminals(['a', 'b']);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    svc.subscribeTerminals(['c']);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual(['c']);
  });

  it('mirrors agent status rows and degrades unknown states', () => {
    const svc = new SocketService();
    svc.handleMessage(JSON.stringify({ type: 'state:sync', payload: { agentStatus: [{ paneId: 'p1', state: 'working', agent: 'claude' }] } }));
    expect(svc.agentStatus.p1.state).toBe('working');
    svc.handleMessage(JSON.stringify({ type: 'agents:status', payload: { row: { paneId: 'p2', state: 'some-future-state' } } }));
    expect(svc.agentStatus.p2.state).toBe('waiting');
    svc.handleMessage(JSON.stringify({ type: 'agents:clear', payload: { paneId: 'p1' } }));
    expect(svc.agentStatus.p1).toBeUndefined();
  });
});
