import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shellQuote } from './shellQuote';

describe('shellQuote', () => {
  it('passes hostile text through sh literally', () => {
    const value = `Fix "quotes" $(touch /tmp/x) \`id\` & it's $HOME!\nline 2`;
    const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value, false)}`]).toString();
    expect(out).toBe(value);
  });

  it('keeps cmd.exe arguments on one line with escaped quotes', () => {
    expect(shellQuote('say "hi"\nnow', true)).toBe('"say \\"hi\\" now"');
  });
});
