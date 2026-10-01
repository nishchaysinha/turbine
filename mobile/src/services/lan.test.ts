import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketService } from './socketService';
import { setWebRTCBridge } from './bridgeRegistry';
import { normalizeLanUrl, parseLanPayload } from '../utils/pairing';

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('LAN pairing helpers', () => {
  it('parses the desktop LAN QR and normalizes typed addresses', () => {
    expect(parseLanPayload(JSON.stringify({ type: 'turbine-lan', url: 'ws://192.168.1.5:6970', token: 'abc' }))).toEqual({
      url: 'ws://192.168.1.5:6970',
      token: 'abc',
    });
    expect(parseLanPayload('{"type":"turbine-p2p"}')).toBeNull();
    expect(normalizeLanUrl('192.168.1.5')).toBe('ws://192.168.1.5:6970');
    expect(normalizeLanUrl('http://10.0.0.2:7000/')).toBe('ws://10.0.0.2:7000');
  });
});

describe('LAN transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS);
    setWebRTCBridge(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects with the token, speaks the protocol and reconnects after a drop', async () => {
    const svc = new SocketService();
    const p = svc.connectLan({ url: '192.168.1.5', token: 'tok en' });
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe('ws://192.168.1.5:6970/?token=tok%20en');
    ws.open();
    await p;
    expect(svc.getStatus()).toBe('connected');
    // hello goes out over the socket
    expect(ws.sent.some((m) => JSON.parse(m).payload?.method === 'hello')).toBe(true);
    svc.handleMessage(JSON.stringify({ type: 'state:sync', payload: { workspaces: [{ id: 'w', name: 'W', panes: [] }] } }));
    expect(svc.workspaces).toHaveLength(1);

    ws.close();
    expect(svc.reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1].open();
    expect(svc.getStatus()).toBe('connected');
  });

  it('fails clearly when the desktop is unreachable', async () => {
    const svc = new SocketService();
    const p = svc.connectLan({ url: '10.0.0.9:6970', token: 'x' });
    FakeWS.instances[0].onerror?.();
    await expect(p).rejects.toThrow(/Could not reach the desktop at ws:\/\/10\.0\.0\.9:6970/);
  });

  it('requires an address and token', async () => {
    await expect(new SocketService().connectLan({ url: '', token: '' })).rejects.toThrow(/address and token/);
  });
});
