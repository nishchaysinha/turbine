import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketService } from './socketService';
import { setWebRTCBridge } from './bridgeRegistry';

function fakeBridge() {
  const bridge = {
    connect: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    sent: () => bridge.send.mock.calls.map((c) => JSON.parse(c[0])),
  };
  setWebRTCBridge(bridge);
  return bridge;
}

describe('SocketService connection lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setWebRTCBridge(null);
  });

  it('resolves only when the DataChannel opens', async () => {
    const bridge = fakeBridge();
    const svc = new SocketService();
    let done = false;
    const p = svc.connectP2P({ signalingUrl: 'sig.example/', pairingCode: 'ab12cd' }).then(() => (done = true));

    expect(bridge.connect).toHaveBeenCalledWith('https://sig.example', 'TRB-AB12CD');
    expect(svc.getStatus()).toBe('connecting');

    // The engine resets itself before connecting; that must not end the attempt.
    svc.setStatus('disconnected');
    expect(svc.getStatus()).toBe('connecting');
    await Promise.resolve();
    expect(done).toBe(false);

    svc.setStatus('connected');
    await p;
    expect(done).toBe(true);
    expect(svc.getStatus()).toBe('connected');
  });

  it('rejects with the engine error message', async () => {
    fakeBridge();
    const svc = new SocketService();
    const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' });
    svc.setErrorMessage('Pairing code not found or expired');
    await expect(p).rejects.toThrow('Pairing code not found or expired');
    expect(svc.getStatus()).toBe('error');
  });

  it('retries briefly when the code is still marked as answered', async () => {
    const bridge = fakeBridge();
    const svc = new SocketService();
    let done = false;
    const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' }).then(() => (done = true));
    svc.setErrorMessage('This code is already connected to another device.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(bridge.connect).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    svc.setStatus('connected');
    await p;
    expect(done).toBe(true);
  });

  it('gives up on a busy code after a few retries', async () => {
    fakeBridge();
    const svc = new SocketService();
    const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' });
    const assertion = expect(p).rejects.toThrow(/already connected/);
    for (let i = 0; i < 5; i++) {
      svc.setErrorMessage('This code is already connected to another device.');
      await vi.advanceTimersByTimeAsync(2000);
    }
    await assertion;
    expect(svc.getStatus()).toBe('error');
  });

  it('times out if the desktop never answers', async () => {
    fakeBridge();
    const svc = new SocketService();
    const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' });
    const assertion = expect(p).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(20001);
    await assertion;
  });

  it('rejects an empty code without touching the bridge', async () => {
    const bridge = fakeBridge();
    const svc = new SocketService();
    await expect(svc.connectP2P({ signalingUrl: '', pairingCode: '  ' })).rejects.toThrow();
    expect(bridge.connect).not.toHaveBeenCalled();
  });

  it('reconnects with the same code after the link drops', async () => {
    const bridge = fakeBridge();
    const svc = new SocketService();
    const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' });
    svc.setStatus('connected');
    await p;

    svc.setStatus('disconnected');
    expect(svc.reconnecting).toBe(true);
    expect(svc.getStatus()).toBe('connecting');

    await vi.advanceTimersByTimeAsync(2000);
    expect(bridge.connect).toHaveBeenCalledTimes(2);
    expect(bridge.connect).toHaveBeenLastCalledWith('https://s', 'TRB-AB12CD');

    svc.setStatus('connected');
    expect(svc.reconnecting).toBe(false);
    expect(svc.getStatus()).toBe('connected');
  });

  it('gives up reconnecting eventually and stops on manual disconnect', async () => {
    const bridge = fakeBridge();
    const svc = new SocketService();
    const p = svc.connectP2P({ signalingUrl: 'https://s', pairingCode: 'TRB-AB12CD' });
    svc.setStatus('connected');
    await p;
    svc.setStatus('disconnected');

    // Every attempt fails with an engine error until we run out of retries.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30000);
      if (svc.reconnecting) svc.setErrorMessage('Pairing code not found or expired');
    }
    expect(svc.reconnecting).toBe(false);
    expect(svc.getStatus()).toBe('error');

    const calls = bridge.connect.mock.calls.length;
    svc.disconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(bridge.connect.mock.calls.length).toBe(calls);
    expect(svc.getStatus()).toBe('disconnected');
  });
});

describe('SocketService message handling', () => {
  afterEach(() => setWebRTCBridge(null));

  it('answers desktop pings with a pong', () => {
    const bridge = fakeBridge();
    const svc = new SocketService();
    svc.handleMessage(JSON.stringify({ type: 'ping', payload: { clientTime: 123 } }));
    expect(bridge.sent()).toEqual([expect.objectContaining({ type: 'pong', payload: { clientTime: 123 } })]);
  });

  it('ignores non-array swarm agents instead of crashing screens', () => {
    const svc = new SocketService();
    svc.handleMessage(JSON.stringify({ type: 'state:sync', payload: { swarmAgents: {}, workspaces: [] } }));
    expect(svc.swarmAgents).toEqual([]);
    svc.handleMessage(JSON.stringify({ type: 'swarm:updated', payload: { runs: [{ id: 'r' }], agents: [{ id: 'a' }] } }));
    expect(svc.swarmRuns).toHaveLength(1);
    expect(svc.swarmAgents).toHaveLength(1);
  });

  it('keeps terminal buffers and resets them on clear-screen', () => {
    const svc = new SocketService();
    const seen: string[] = [];
    svc.onTerminalOutput((_, d) => seen.push(d));
    svc.handleMessage(JSON.stringify({ type: 'terminal:output', payload: { paneId: 'p', data: 'abc' } }));
    svc.handleMessage(JSON.stringify({ type: 'terminal:output', payload: { paneId: 'p', data: 'def' } }));
    expect(svc.getPaneOutput('p')).toBe('abcdef');
    svc.handleMessage(JSON.stringify({ type: 'terminal:output', payload: { paneId: 'p', data: 'x\x1b[2Jnew' } }));
    expect(svc.getPaneOutput('p')).toBe('\x1b[2Jnew');
    expect(seen).toHaveLength(3);
  });

  it('records diff errors and bumps the diff version', () => {
    const svc = new SocketService();
    svc.handleMessage(JSON.stringify({ type: 'diff:data', payload: { diff: '', error: 'not a git repo' } }));
    expect(svc.gitDiffError).toBe('not a git repo');
    expect(svc.gitDiffVersion).toBe(1);
  });

  it('surfaces desktop command errors and survives garbage', () => {
    const svc = new SocketService();
    svc.handleMessage('not json');
    svc.handleMessage(JSON.stringify({ type: 'error', payload: { message: 'No agent presets' } }));
    expect(svc.lastCommandError).toBe('No agent presets');
  });
});
