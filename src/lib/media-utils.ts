import { Api } from 'telegram';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Promisified execFile, resolved lazily: importing this module (it is pulled in
 * by every command, including the daemon entry) must not touch child_process.
 */
function execFileAsync(): typeof execFile.__promisify__ {
  return promisify(execFile);
}

/**
 * Map of user-facing filter names to factory functions that create
 * gramjs InputMessagesFilter instances for search filtering.
 *
 * Factory functions ensure a fresh instance per call (gramjs mutates filter objects).
 */
export const FILTER_MAP: Record<string, () => InstanceType<any>> = {
  photos: () => new Api.InputMessagesFilterPhotos(),
  videos: () => new Api.InputMessagesFilterVideo(),
  photo_video: () => new Api.InputMessagesFilterPhotoVideo(),
  documents: () => new Api.InputMessagesFilterDocument(),
  urls: () => new Api.InputMessagesFilterUrl(),
  gifs: () => new Api.InputMessagesFilterGif(),
  voice: () => new Api.InputMessagesFilterVoice(),
  music: () => new Api.InputMessagesFilterMusic(),
  round: () => new Api.InputMessagesFilterRoundVideo(),
  round_voice: () => new Api.InputMessagesFilterRoundVoice(),
  chat_photos: () => new Api.InputMessagesFilterChatPhotos(),
  phone_calls: () => new Api.InputMessagesFilterPhoneCalls({ missed: false }),
  mentions: () => new Api.InputMessagesFilterMyMentions(),
  geo: () => new Api.InputMessagesFilterGeo(),
  contacts: () => new Api.InputMessagesFilterContacts(),
  pinned: () => new Api.InputMessagesFilterPinned(),
};

/**
 * Array of valid filter names for validation and help text.
 */
export const VALID_FILTERS: string[] = Object.keys(FILTER_MAP);

/**
 * MIME type to file extension map for auto-naming downloaded files.
 */
const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/opus': '.opus',
};

/**
 * Generate an auto-name for a downloaded media file.
 *
 * Format: {mediaType}_{msgId}{ext}
 * Extension derived from MIME type; falls back to .bin.
 */
export function generateFilename(
  mediaType: string,
  msgId: number,
  mimeType: string | null,
): string {
  const ext = mimeType ? (MIME_EXT_MAP[mimeType] ?? '.bin') : '.bin';
  return `${mediaType}_${msgId}${ext}`;
}

/**
 * Extension sets for file type classification.
 */
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.ogg', '.opus']);

/**
 * Classify a file by its extension for upload type detection.
 */
export function detectFileType(
  ext: string,
): 'photo' | 'video' | 'voice' | 'document' {
  const lower = ext.toLowerCase();
  if (PHOTO_EXTS.has(lower)) return 'photo';
  if (VIDEO_EXTS.has(lower)) return 'video';
  if (VOICE_EXTS.has(lower)) return 'voice';
  return 'document';
}

/**
 * Get audio duration in seconds via ffprobe. Returns 0 on failure.
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync()('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ]);
    return Math.round(parseFloat(stdout.toString().trim()) || 0);
  } catch {
    return 0;
  }
}

/**
 * Generate a Telegram voice waveform from an audio file.
 *
 * Decodes audio to mono 16kHz PCM via ffmpeg, splits into `points` bins,
 * takes the peak amplitude per bin, normalizes to 5-bit (0-31), and packs
 * the values LSB-first into bytes — the format Telegram clients expect for
 * the `DocumentAttributeAudio.waveform` field (drives the voice equalizer).
 *
 * Returns an empty Buffer if ffmpeg is unavailable or the file has no audio.
 */
export async function generateWaveform(
  filePath: string,
  points = 100,
): Promise<Buffer> {
  let pcm: Buffer;
  try {
    const { stdout } = await execFileAsync()(
      'ffmpeg',
      ['-i', filePath, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 256 },
    );
    pcm = stdout as unknown as Buffer;
  } catch {
    return Buffer.alloc(0);
  }

  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return Buffer.alloc(0);

  const binSize = Math.max(1, Math.floor(sampleCount / points));
  const peaks: number[] = [];
  for (let i = 0; i < points; i++) {
    const start = i * binSize;
    let peak = 0;
    for (let j = 0; j < binSize; j++) {
      const idx = (start + j) * 2;
      if (idx + 1 >= pcm.length) break;
      const sample = Math.abs(pcm.readInt16LE(idx));
      if (sample > peak) peak = sample;
    }
    peaks.push(peak);
  }

  const maxPeak = Math.max(...peaks, 1);
  const values = peaks.map(p => Math.min(31, Math.round((p / maxPeak) * 31)));

  // Pack 5-bit values LSB-first into bytes
  const out: number[] = [];
  let bits = 0;
  let bitcount = 0;
  for (const v of values) {
    bits |= (v & 0x1f) << bitcount;
    bitcount += 5;
    while (bitcount >= 8) {
      out.push(bits & 0xff);
      bits >>= 8;
      bitcount -= 8;
    }
  }
  if (bitcount > 0) out.push(bits & 0xff);
  return Buffer.from(out);
}

/**
 * Format a byte count as a human-readable string.
 *
 * <1024 -> NB, <1MB -> NKB (rounded), <1GB -> N.NMB, else N.NGB
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
