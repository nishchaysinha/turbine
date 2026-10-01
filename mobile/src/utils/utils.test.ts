import { describe, expect, it } from 'vitest';
import { normalizePairingCode, normalizeSignalingUrl, parsePairingPayload } from './pairing';
import { ctrlChord } from './keys';
import { toPreviewText } from './terminalText';

describe('pairing helpers', () => {
  it('normalizes codes typed in any shape', () => {
    expect(normalizePairingCode('trb-ab12cd')).toBe('TRB-AB12CD');
    expect(normalizePairingCode('ab12cd')).toBe('TRB-AB12CD');
    expect(normalizePairingCode(' TRB AB 12 CD ')).toBe('TRB-AB12CD');
    expect(normalizePairingCode('')).toBe('');
  });

  it('normalizes signaling URLs', () => {
    expect(normalizeSignalingUrl('example.vercel.app/')).toBe('https://example.vercel.app');
    expect(normalizeSignalingUrl('http://192.168.1.2:3000//')).toBe('http://192.168.1.2:3000');
  });

  it('parses the desktop QR payload', () => {
    expect(
      parsePairingPayload(JSON.stringify({ type: 'turbine-p2p', signalingUrl: 'https://s.app/', pairingCode: 'trb-abcdef' }))
    ).toEqual({ signalingUrl: 'https://s.app', pairingCode: 'TRB-ABCDEF' });
    expect(parsePairingPayload('TRB-ABCDEF')).toBeNull();
  });
});

describe('ctrlChord', () => {
  it('maps letters and symbols to control bytes', () => {
    expect(ctrlChord('c')).toBe('\x03');
    expect(ctrlChord('C')).toBe('\x03');
    expect(ctrlChord('a')).toBe('\x01');
    expect(ctrlChord('z')).toBe('\x1a');
    expect(ctrlChord('[')).toBe('\x1b');
    expect(ctrlChord(' ')).toBe('\x00');
    expect(ctrlChord('1')).toBeNull();
    expect(ctrlChord('\x1b[A')).toBeNull();
  });
});

describe('toPreviewText', () => {
  it('keeps colours but drops cursor/OSC/mode sequences', () => {
    const raw = '\x1b]0;title\x07\x1b[?25l\x1b[2K\x1b[32mok\x1b[0m done\x1b[?25h';
    expect(toPreviewText(raw)).toBe('\x1b[32mok\x1b[0m done');
  });

  it('applies carriage returns and backspaces like a terminal would', () => {
    expect(toPreviewText('progress 10%\rprogress 100%\n')).toBe('progress 100%');
    expect(toPreviewText('abc\b\bX')).toBe('aX');
    expect(toPreviewText('line\r\n')).toBe('line');
  });

  it('returns only the last N non-blank lines', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n\n';
    expect(toPreviewText(raw, 3)).toBe('l27\nl28\nl29');
  });
});
