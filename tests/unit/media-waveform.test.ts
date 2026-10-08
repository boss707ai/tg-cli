import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fork feature: voice-note waveform (lib/media-utils.ts). ffmpeg/ffprobe are
// replaced by a synthetic execFile; no real binaries or audio files are used.

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

import { generateWaveform, getAudioDuration } from '../../src/lib/media-utils.js';

/** Make the mocked execFile answer like the promisified real one ({ stdout, stderr }). */
function execReturns(stdout: Buffer | string) {
  mockExecFile.mockImplementationOnce((...args: any[]) => {
    const cb = args[args.length - 1];
    cb(null, { stdout, stderr: '' });
  });
}
function execFails() {
  mockExecFile.mockImplementationOnce((...args: any[]) => {
    const cb = args[args.length - 1];
    cb(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
  });
}

/** Unpack Telegram's 5-bit LSB-first waveform. */
function unpack(buf: Buffer, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const bit = i * 5;
    const byte = bit >> 3;
    const shift = bit & 7;
    const word = buf[byte] | ((buf[byte + 1] ?? 0) << 8);
    out.push((word >> shift) & 0x1f);
  }
  return out;
}

describe('generateWaveform', () => {
  beforeEach(() => mockExecFile.mockReset());

  it('decodes mono 16 kHz PCM via ffmpeg and packs 100 peaks as 5-bit values', async () => {
    // 1000 samples -> 100 bins of 10; bin i peaks at i * 300 (bin 99 is the max).
    const pcm = Buffer.alloc(1000 * 2);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(i % 2 ? -(i * 300) : i * 300, (i * 10 + 3) * 2);
    execReturns(pcm);

    const waveform = await generateWaveform('/synthetic/voice.ogg');

    expect(mockExecFile).toHaveBeenCalledWith(
      'ffmpeg',
      ['-i', '/synthetic/voice.ogg', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
      expect.objectContaining({ encoding: 'buffer' }),
      expect.any(Function),
    );
    expect(waveform.length).toBe(63); // ceil(100 * 5 / 8)
    const values = unpack(waveform, 100);
    expect(values[0]).toBe(0);
    expect(values[99]).toBe(31);
    expect(values[50]).toBe(Math.round((50 * 300) / (99 * 300) * 31));
    expect(values.every((v, i) => i === 0 || v >= values[i - 1])).toBe(true);
  });

  it('returns an empty buffer when ffmpeg is unavailable or there is no audio', async () => {
    execFails();
    expect((await generateWaveform('/synthetic/voice.ogg')).length).toBe(0);
    execReturns(Buffer.alloc(0));
    expect((await generateWaveform('/synthetic/voice.ogg')).length).toBe(0);
  });
});

describe('getAudioDuration', () => {
  beforeEach(() => mockExecFile.mockReset());

  it('reads the rounded duration from ffprobe', async () => {
    execReturns('3.6\n');
    expect(await getAudioDuration('/synthetic/voice.ogg')).toBe(4);
    expect(mockExecFile.mock.calls[0][0]).toBe('ffprobe');
  });

  it('returns 0 when ffprobe fails', async () => {
    execFails();
    expect(await getAudioDuration('/synthetic/voice.ogg')).toBe(0);
  });
});
