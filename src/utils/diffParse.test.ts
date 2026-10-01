import { describe, expect, it } from 'vitest';
import { changeBlockStarts, nextIndex, parseUnifiedDiff } from './diffParse';
import { bracketedPaste, formatReviewPrompt } from './reviewNotes';

const DIFF = [
  'diff --git a/src/server.ts b/src/server.ts',
  '--- a/src/server.ts',
  '+++ b/src/server.ts',
  '@@ -12,3 +12,4 @@',
  '   const app = express();',
  '-  app.use(cors());',
  "+  app.use(cors({ origin: '*' }));",
  '+  app.use(rateLimit());',
  'diff --git a/src/new.txt b/src/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n');

describe('diffParse', () => {
  it('parses files, statuses and line numbers', () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/server.ts', 'modified', 2, 1],
      ['src/new.txt', 'added', 1, 0],
    ]);
    expect(files[0].lines.map((l) => `${l.kind}:${l.oldNo ?? '-'}:${l.newNo ?? '-'}`)).toEqual([
      'hunk:-:-',
      'ctx:12:12',
      'del:13:-',
      'add:-:13',
      'add:-:14',
    ]);
    expect(changeBlockStarts(files[0].lines)).toEqual([2]);
    expect(nextIndex([2, 7], 2, 1)).toBe(7);
  });

  it('formats a review prompt and wraps it as a single paste', () => {
    const prompt = formatReviewPrompt([
      { id: '1', filePath: 'src/server.ts', lineNumber: 14, side: 'new', lineText: 'app.use(rateLimit());', body: 'make it "configurable"', createdAt: 0 },
    ]);
    expect(prompt).toContain('File: src/server.ts\nLine: 14\nCode: app.use(rateLimit());\nUser comment: "make it \\"configurable\\""');
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~\r');
  });
});
