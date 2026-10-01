/** Maps a key to its Ctrl-chord control byte (Ctrl+A → \x01 … Ctrl+Z → \x1a, plus @[\]^_). */
export function ctrlChord(data: string): string | null {
  if (data.length !== 1) return null;
  const upper = data.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64); // @ A-Z [ \ ] ^ _
  if (data === ' ') return '\x00';
  if (data === '?') return '\x7f';
  return null;
}
