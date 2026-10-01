import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: Uint8Array[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => (queue.shift() ?? new Uint8Array()).buffer),
}));

const { claimPaneOutput, drainPtyOutput, isPaneOutputClaimed, onPtyOutput } = await import('./ptyData');

beforeEach(() => {
  queue.length = 0;
});

describe('ptyData', () => {
  it('delivers each chunk to taps exactly once and decodes split UTF-8', async () => {
    const seen: string[] = [];
    const off = onPtyOutput((paneId, _b, text) => seen.push(`${paneId}:${text}`));
    const bytes = new TextEncoder().encode('héllo ✓');
    queue.push(bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9));
    const texts: string[] = [];
    await drainPtyOutput('p1', (_b, text) => void texts.push(text), 0);
    off();
    expect(texts.join('')).toBe('héllo ✓');
    expect(seen.map((s) => s.slice(3)).join('')).toBe('héllo ✓');
    expect(seen).toHaveLength(3);
  });

  it('tracks claimed panes with ref-counting', () => {
    const a = claimPaneOutput('p2');
    const b = claimPaneOutput('p2');
    a();
    a();
    expect(isPaneOutputClaimed('p2')).toBe(true);
    b();
    expect(isPaneOutputClaimed('p2')).toBe(false);
  });
});
