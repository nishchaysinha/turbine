const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/**
 * Quote one argument so the pane's shell passes it through literally.
 * POSIX: single quotes (nothing expands inside them). cmd.exe: double quotes, one line.
 */
export function shellQuote(value: string, windows = isWindows): string {
  if (windows) return `"${value.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
