/**
 * Review notes left on diff lines from the phone. The text format matches
 * Orca's review-note contract so agents get a stable, quote-safe prompt.
 */
export interface ReviewNote {
  id: string;
  filePath: string;
  /** New-file line number (old-file number for deleted lines); 0 = whole file. */
  lineNumber: number;
  side: 'new' | 'old';
  /** The code on that line, for context in the prompt. */
  lineText: string;
  body: string;
  createdAt: number;
}

export function formatReviewNote(note: ReviewNote): string {
  const escaped = note.body
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  const location =
    note.lineNumber === 0 ? 'Scope: file' : `Line: ${note.lineNumber}${note.side === 'old' ? ' (removed line)' : ''}`;
  const parts = [`File: ${note.filePath}`, location];
  if (note.lineText.trim()) parts.push(`Code: ${note.lineText.trim()}`);
  parts.push(`User comment: "${escaped}"`);
  return parts.join('\n');
}

export function formatReviewPrompt(notes: readonly ReviewNote[]): string {
  const sorted = [...notes].sort((a, b) =>
    a.filePath === b.filePath ? a.lineNumber - b.lineNumber : a.filePath.localeCompare(b.filePath)
  );
  return [
    'You are reviewing the current working tree. Address the following review notes from my phone.',
    '',
    sorted.map(formatReviewNote).join('\n\n'),
    '',
    'After applying fixes:',
    '1. Summarize changed files.',
    '2. Run relevant tests.',
    '3. Tell me if anything remains risky.',
  ].join('\n');
}

/**
 * Wraps multi-line text in bracketed-paste markers so terminal agents (Claude
 * Code, Codex, …) receive it as one message instead of submitting each line.
 */
export function bracketedPaste(text: string, submit = true): string {
  return `\x1b[200~${text.replace(/\x1b\[20[01]~/g, '')}\x1b[201~${submit ? '\r' : ''}`;
}

export function notesForFile(notes: readonly ReviewNote[], filePath: string): ReviewNote[] {
  return notes.filter((n) => n.filePath === filePath);
}
