import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => void store.set(k, v),
    },
  };
});

import { finishedAgents } from './agentActivity';
import { forgetHost, loadSavedHosts, rememberHost, upsertHost } from './savedHosts';
import type { SwarmAgent } from '../types';

const agent = (id: string, status: SwarmAgent['status']): SwarmAgent =>
  ({ id, status, role: 'builder', swarm_run_id: 'r', pane_id: 'p', command: '', output_summary: null }) as SwarmAgent;

describe('finishedAgents', () => {
  it('reports transitions into completed/failed only', () => {
    const prev = [agent('a', 'running'), agent('b', 'running'), agent('c', 'completed')];
    const next = [agent('a', 'completed'), agent('b', 'failed'), agent('c', 'completed'), agent('d', 'completed')];
    expect(finishedAgents(prev, next).map((e) => `${e.agent.id}:${e.kind}`)).toEqual(['a:completed', 'b:failed']);
  });

  it('ignores agents seen for the first time', () => {
    expect(finishedAgents([], [agent('a', 'completed')])).toEqual([]);
  });
});

describe('saved hosts', () => {
  it('dedupes, orders by recency and caps the list', () => {
    let hosts = [] as ReturnType<typeof upsertHost>;
    for (let i = 0; i < 12; i++) {
      hosts = upsertHost(hosts, { pairingCode: `TRB-${i}`, signalingUrl: 'u', label: 'x', lastConnectedAt: i });
    }
    hosts = upsertHost(hosts, { pairingCode: 'TRB-5', signalingUrl: 'u', label: 'x', lastConnectedAt: 100 });
    expect(hosts).toHaveLength(8);
    expect(hosts[0].pairingCode).toBe('TRB-5');
    expect(hosts.filter((h) => h.pairingCode === 'TRB-5')).toHaveLength(1);
  });

  it('persists and forgets hosts', async () => {
    await rememberHost({ pairingCode: 'TRB-AAAAAA', signalingUrl: 'https://s', label: 'Mac', lastConnectedAt: 1 });
    expect((await loadSavedHosts())[0].pairingCode).toBe('TRB-AAAAAA');
    expect(await forgetHost('TRB-AAAAAA', 'https://s')).toEqual([]);
  });
});
