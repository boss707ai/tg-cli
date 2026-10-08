import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

// Fork feature: `media send` attaches a real waveform to voice notes, and passes
// the sender entity to serialization. After the merge the file is resolved
// against the request cwd (daemon requests carry their own cwd).

const mockOutputSuccess = vi.fn();
const mockOutputError = vi.fn();
vi.mock('../../src/lib/output.js', () => ({
  outputSuccess: (...args: any[]) => mockOutputSuccess(...args),
  outputError: (...args: any[]) => mockOutputError(...args),
  logStatus: vi.fn(),
}));

vi.mock('telegram', () => ({
  Api: {
    DocumentAttributeAudio: class DocumentAttributeAudio {
      constructor(args: Record<string, unknown>) { Object.assign(this, args); }
    },
  },
}));

const mockSendFile = vi.fn();
const mockClient = { sendFile: mockSendFile } as any;
vi.mock('../../src/lib/with-auth.js', () => ({
  withAuth: async (_opts: any, fn: any) => fn(mockClient),
}));

vi.mock('../../src/lib/peer.js', () => ({
  resolveEntity: vi.fn().mockResolvedValue({ id: BigInt(1), className: 'User' }),
  assertForum: vi.fn().mockResolvedValue(undefined),
}));

const mockSerializeMessage = vi.fn((msg: any, sender?: any) => ({ id: msg.id, senderName: sender?.firstName ?? null }));
vi.mock('../../src/lib/serialize.js', () => ({
  serializeMessage: (...args: any[]) => mockSerializeMessage(...(args as [any, any])),
}));

const mockGetAudioDuration = vi.fn();
const mockGenerateWaveform = vi.fn();
vi.mock('../../src/lib/media-utils.js', () => ({
  detectFileType: (ext: string) => (ext === '.ogg' ? 'voice' : 'photo'),
  getAudioDuration: (...args: any[]) => mockGetAudioDuration(...args),
  generateWaveform: (...args: any[]) => mockGenerateWaveform(...args),
}));

vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));

import { mediaSendAction } from '../../src/commands/media/send.js';
import { runWithDaemonContext } from '../../src/lib/daemon/execution-context.js';

const ctx = (args: string[]) => ({ args, optsWithGlobals: () => ({ profile: 'default', quiet: true }) }) as any;

describe('media send: voice waveform and sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAudioDuration.mockResolvedValue(7);
    mockGenerateWaveform.mockResolvedValue(Buffer.from([1, 2, 3]));
    mockSendFile.mockResolvedValue({ id: 100, _sender: { firstName: 'Me' } });
  });

  it('attaches DocumentAttributeAudio { voice, duration, waveform } to voice notes', async () => {
    await mediaSendAction.call(ctx(['@chat', 'voice.ogg']));
    const params = mockSendFile.mock.calls[0][1];
    expect(params.voiceNote).toBe(true);
    expect(mockGenerateWaveform).toHaveBeenCalledWith(resolve('voice.ogg'));
    expect(params.attributes).toHaveLength(1);
    expect(params.attributes[0]).toMatchObject({ voice: true, duration: 7, waveform: Buffer.from([1, 2, 3]) });
  });

  it('falls back to a plain voice note when no waveform could be generated', async () => {
    mockGenerateWaveform.mockResolvedValueOnce(Buffer.alloc(0));
    await mediaSendAction.call(ctx(['@chat', 'voice.ogg']));
    const params = mockSendFile.mock.calls[0][1];
    expect(params.voiceNote).toBe(true);
    expect(params.attributes).toBeUndefined();
  });

  it('does not run ffmpeg for non-voice files', async () => {
    await mediaSendAction.call(ctx(['@chat', 'photo.jpg']));
    expect(mockGenerateWaveform).not.toHaveBeenCalled();
    expect(mockGetAudioDuration).not.toHaveBeenCalled();
  });

  it('through the daemon reads the voice file relative to the request cwd', async () => {
    await runWithDaemonContext(
      { client: mockClient, profile: 'default', signal: new AbortController().signal, cwd: '/synthetic/caller', exitCode: 0 },
      () => mediaSendAction.call(ctx(['@chat', 'voice.ogg'])),
    );
    expect(mockGenerateWaveform).toHaveBeenCalledWith('/synthetic/caller/voice.ogg');
    expect(mockGetAudioDuration).toHaveBeenCalledWith('/synthetic/caller/voice.ogg');
    expect(mockSendFile.mock.calls[0][1].file).toBe('/synthetic/caller/voice.ogg');
  });

  it('passes the sender entity to serialization', async () => {
    await mediaSendAction.call(ctx(['@chat', 'photo.jpg']));
    expect(mockSerializeMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 100 }), { firstName: 'Me' });
    expect(mockOutputSuccess).toHaveBeenCalledWith({ id: 100, senderName: 'Me' });
  });
});
