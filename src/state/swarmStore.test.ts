import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<[string, any]> = [];
const db: Record<string, any> = {};
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    calls.push([cmd, args]);
    if (cmd === 'load_swarm_agents') return db.agents[args.swarmRunId] ?? [];
    return null;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ listen: vi.fn(async () => () => {}) }) }));

import { reconcileStaleRuns } from './swarmStore';
import type { SwarmRun } from '../types';

const run = (id: string, status: SwarmRun['status']): SwarmRun => ({
  id, task_id: null, project_path: '/p', status, current_role: 'coder', prompt: null,
  started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

describe('reconcileStaleRuns', () => {
  beforeEach(() => {
    calls.length = 0;
    db.agents = {
      r1: [
        { id: 'a1', swarm_run_id: 'r1', status: 'running', output_summary: null },
        { id: 'a2', swarm_run_id: 'r1', status: 'completed', output_summary: 'ok' },
      ],
    };
  });

  it('fails runs and agents left active by a previous session', async () => {
    const out = await reconcileStaleRuns([run('r1', 'Running'), run('r2', 'Completed')]);
    expect(out[0].status).toBe('Failed');
    expect(out[0].current_role).toBeNull();
    expect(out[1].status).toBe('Completed');
    const savedAgents = calls.filter(([c]) => c === 'save_swarm_agent').map(([, a]) => a.agent);
    expect(savedAgents).toHaveLength(1);
    expect(savedAgents[0]).toMatchObject({ id: 'a1', status: 'failed' });
    expect(savedAgents[0].output_summary).toMatch(/Interrupted/);
    expect(calls.some(([c, a]) => c === 'save_swarm_run' && a.run.id === 'r1')).toBe(true);
  });
});
