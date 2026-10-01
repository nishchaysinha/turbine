import { describe, it, expect } from 'vitest';
import { toRustLogSource, fromRustLogSource, generateCommand } from './logStreamManager';
import type { LogSourceConfig } from '../types';

describe('generateCommand flood guards', () => {
  it('defaults docker logs to --tail 1000', () => {
    const cmd = generateCommand({
      id: 's',
      paneId: 'p',
      sourceType: 'docker_container',
      displayName: 'd',
      color: null,
      params: { containerNameOrId: 'web' },
      sortOrder: 0,
    });
    expect(cmd).toBe('docker logs -f --tail 1000 web');
  });

  it('defaults kubectl logs to --tail=1000', () => {
    const cmd = generateCommand({
      id: 's',
      paneId: 'p',
      sourceType: 'kubernetes_pod',
      displayName: 'k',
      color: null,
      params: { podName: 'pod-1' },
      sortOrder: 0,
    });
    expect(cmd).toBe('kubectl logs -f pod-1 --tail=1000');
  });
});

describe('log source wire mapping', () => {
  const source: LogSourceConfig = {
    id: 'src-1',
    paneId: 'pane-1',
    sourceType: 'local_file',
    displayName: 'App Log',
    color: '#00e5c8',
    params: { filePath: '/var/log/app.log' },
    sortOrder: 0,
  };

  it('maps to the Rust snake_case shape with params serialized', () => {
    const rust = toRustLogSource(source);
    expect(rust).toEqual({
      id: 'src-1',
      pane_id: 'pane-1',
      source_type: 'local_file',
      display_name: 'App Log',
      color: '#00e5c8',
      params_json: '{"filePath":"/var/log/app.log"}',
      sort_order: 0,
    });
  });

  it('round-trips back to the frontend shape', () => {
    expect(fromRustLogSource(toRustLogSource(source))).toEqual(source);
  });

  it('tolerates corrupt params_json', () => {
    const rust = { ...toRustLogSource(source), params_json: 'not json' };
    expect(fromRustLogSource(rust).params).toEqual({});
  });
});

describe('generateCommand quoting', () => {
  it('quotes paths with spaces and keeps plain ones bare', async () => {
    const { generateCommand } = await import('./logStreamManager');
    const src = (params: object, sourceType = 'local_file') =>
      ({ id: 'x', paneId: 'p', sourceType, displayName: 'x', color: null, params, sortOrder: 0 }) as never;
    expect(generateCommand(src({ filePath: '/var/log/app.log' }))).toBe('tail -f /var/log/app.log');
    expect(generateCommand(src({ filePath: '/tmp/my logs/a $(x).log' }))).toBe("tail -f '/tmp/my logs/a $(x).log'");
    expect(generateCommand(src({ host: 'box', remoteFilePath: '/srv/my app.log', user: 'me' }, 'ssh_remote'))).toBe(
      `ssh me@box 'tail -f '\\''/srv/my app.log'\\'''`,
    );
  });
});

describe('cleanLogLine', () => {
  it('drops escape codes, blank lines and the command echo', async () => {
    const { cleanLogLine } = await import('./logStreamManager');
    const cmd = "tail -f '/tmp/a b.log'";
    expect(cleanLogLine('\x1b[?2004h\x1b]0;root@vm: ~\x07\r', cmd)).toBeNull();
    expect(cleanLogLine(`\x1b[01;32mroot@vm\x1b[00m:~# exec ${cmd}\r`, cmd)).toBeNull();
    expect(cleanLogLine('\x1b[31mERROR\x1b[0m db timeout\r', cmd)).toBe('ERROR db timeout');
  });
});
