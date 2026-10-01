/**
 * Turns a raw PTY stream into plain-ish text for the small tiled previews:
 * keeps SGR colour codes (rendered by AnsiRenderer) and drops everything
 * else (cursor movement, OSC titles, mode switches), applying \r and \b.
 */
export function toPreviewText(raw: string, maxLines = 12): string {
  // Only the tail matters; cut early so long buffers stay cheap.
  const tail = raw.length > 16000 ? raw.slice(-16000) : raw;
  const cleaned = tail
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL/ST
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, (m) => (m.endsWith('m') && !/[?<>=!]/.test(m) ? m : '')) // CSI except SGR
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '') // DCS/SOS/PM/APC
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '') // charset selection
    .replace(/\x1b[=>78DEHMNOZc]/g, '')
    .replace(/[\x00-\x07\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '');

  const lines = cleaned.split('\n').map((line) => {
    // Carriage return without newline overwrites the line; keep what's left visible.
    const segments = line.split('\r').filter((s) => s.length > 0);
    let text = segments.length ? segments[segments.length - 1] : '';
    // Backspace (\x08) erases the previous character.
    while (text.includes('\x08')) text = text.replace(/[^\x08]?\x08/, '');
    return text;
  });

  while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim() === '') {
    lines.pop();
  }
  return lines.slice(-maxLines).join('\n');
}
