import sharp from 'sharp';
import type { Attachment } from 'discord.js';
import { defaultInbound } from './config.js';
import { InboundMediaCache, type OriginalMedia, type SavedMedia } from './inbound-cache.js';
import type { InputImage } from './types.js';

export type MessageAttachments = ReadonlyMap<string, Pick<Attachment, 'name' | 'url' | 'contentType' | 'size'>>;
export interface IncomingMedia {
  previews: { image: InputImage; caption: string }[];
  notes: string[];
  warnings: string[];
  originals?: SavedMedia[];
}
export type MediaFetch = (url: string, options: RequestInit) => Promise<Response>;
const MiB = 1024 * 1024;
// These are preview resource limits, separate from configurable original-file limits.
export const inboundLimits = { fileBytes: 8 * MiB, totalBytes: 16 * MiB, pixels: 40_000_000 };
const downloadTimeoutMs = 15_000;

export class MediaRetryError extends Error {
  constructor() { super('Media download temporarily unavailable'); }
}
class MediaRejected extends Error {}

// Downloads use exact trusted media hosts, no credentials, custom ports or redirects.
export function discordMediaURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) return;
    return url.href;
  } catch { return; }
}
const label = (value: string) => JSON.stringify(value.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160));
const sourceURL = (value: string) => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && value.length <= 4096 ? url.href : '';
  } catch { return ''; }
};
function format(bytes: Buffer): (OriginalMedia & { video: boolean }) | undefined {
  const image = (extension: string, mimeType: string) => ({ extension, mimeType, video: false });
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return image('png', 'image/png');
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return image('jpg', 'image/jpeg');
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return image('gif', 'image/gif');
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return image('webp', 'image/webp');
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 32);
    if (/avif|avis/.test(brand)) return image('avif', 'image/avif');
    if (/qt  /.test(brand)) return { extension: 'mov', mimeType: 'video/quicktime', video: true };
    return { extension: 'mp4', mimeType: 'video/mp4', video: true };
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 4096).includes(Buffer.from('webm'))) {
    return { extension: 'webm', mimeType: 'video/webm', video: true };
  }
}
async function download(url: string, maxBytes: number, fetcher: MediaFetch, spent: (bytes: number) => void): Promise<Buffer> {
  let response: Response;
  try { response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(downloadTimeoutMs) }); }
  catch { throw new MediaRetryError(); }
  const reject = async (error: Error): Promise<never> => { await response.body?.cancel().catch(() => {}); throw error; };
  if ([408, 429].includes(response.status) || response.status >= 500) return reject(new MediaRetryError());
  if (!response.ok) return reject(new MediaRejected(`download unavailable (HTTP ${response.status})`));
  const limit = `exceeds the remaining byte limit (${maxBytes} bytes)`;
  if (Number(response.headers.get('content-length')) > maxBytes) return reject(new MediaRejected(limit));
  if (!response.body) throw new MediaRejected('download was empty');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      spent(value.byteLength);
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new MediaRejected(limit);
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof MediaRejected) throw error;
    throw new MediaRetryError();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Save original media before deriving optional native-image previews. */
export async function prepareIncomingMedia(attachments: MessageAttachments, fetcher: MediaFetch = fetch,
  context?: { cache: InboundMediaCache; inputId: string }): Promise<IncomingMedia> {
  const limits = context?.cache.limits ?? { ...defaultInbound, maxFileBytes: inboundLimits.fileBytes, maxTotalBytes: inboundLimits.totalBytes };
  const previews: IncomingMedia['previews'] = [];
  const notes: string[] = []; const warnings: string[] = []; const originals: SavedMedia[] = [];
  let downloaded = 0, encoded = 0, attempted = 0;
  for (const [attachmentId, file] of attachments) {
    const key = `attachment:${attachmentId}`;
    const name = label(file.name);
    const link = sourceURL(file.url);
    const source = link ? ` Source: ${link}` : '';
    const warn = (reason: string) => { const text = `${name}: ${reason}.`; warnings.push(text); notes.push(`${text}${source}`); };
    const supported = /^(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|quicktime|webm))$/i.test(file.contentType?.split(';')[0] ?? '') ||
      /\.(png|jpe?g|webp|gif|avif|mp4|mov|webm)$/i.test(file.name);
    if (!supported) { warn('sent as a link only; this attachment format is not supported'); continue; }
    if (++attempted > limits.maxFiles) { warn(`only ${limits.maxFiles} media files per message are supported`); continue; }
    let original: Buffer | undefined; let originalFormat: ReturnType<typeof format>; let saved: SavedMedia | undefined;
    try {
      const url = discordMediaURL(file.url);
      if (!url) throw new MediaRejected('no supported Discord attachment URL was supplied');
      let retained: { saved: SavedMedia; bytes: Buffer } | undefined;
      try {
        // Older installations indexed staged uploads by CDN path. Only look up
        // that legacy key for a file in the current attachment collection.
        retained = await context?.cache.lookup(context.inputId, key, `discord:${new URL(url).pathname}`);
      }
      catch { warn('the previous local copy could not be read; trying the supplied media URL'); }
      if (retained) {
        const budget = Math.min(limits.maxFileBytes, limits.maxTotalBytes - downloaded);
        if (retained.bytes.length > budget) throw new MediaRejected(`saved original exceeds the remaining byte limit (${Math.max(0, budget)} bytes)`);
        original = retained.bytes; saved = retained.saved; downloaded += original.length;
      }
      else {
        const budget = Math.min(limits.maxFileBytes, limits.maxTotalBytes - downloaded);
        if (budget <= 0 || file.size > budget) throw new MediaRejected(`exceeds the remaining byte limit (${Math.max(0, budget)} bytes)`);
        original = await download(url, budget, fetcher, count => { downloaded += count; });
      }
      originalFormat = format(original);
      if (!originalFormat) {
        original = undefined; throw new MediaRejected('download was not the expected supported image or video');
      }
      if (context) {
        try {
          saved ??= await context.cache.save(context.inputId, key, original, originalFormat);
          originals.push(saved);
          notes.push(`Original ${name}: ${JSON.stringify(saved.path)} (${saved.mimeType}, ${saved.bytes} bytes; retained at least until ${new Date(saved.retainedUntil).toISOString()}).${source}`);
        } catch (error) { warn(error instanceof Error ? `original could not be saved: ${error.message}` : 'original could not be saved'); }
      }
    } catch (error) {
      if (error instanceof MediaRetryError) throw error;
      if (!(error instanceof MediaRejected)) throw error;
      warn(error.message);
    }
    if (!original || !originalFormat) continue;
    if (originalFormat.video) {
      notes.push(`${name}: video has not been viewed.${saved ? ' Use the original file for frame extraction.' : ''}`);
      continue;
    }
    try {
      const decoder = sharp(original, { limitInputPixels: inboundLimits.pixels, pages: 1, failOn: 'error' });
      const metadata = await decoder.metadata();
      const animated = (metadata.pages ?? 1) > 1 || metadata.format === 'gif';
      const resized = Math.max(metadata.width ?? 0, metadata.height ?? 0) > 2048;
      const output = await decoder.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      if (output.length > inboundLimits.fileBytes || encoded + output.length > inboundLimits.totalBytes) throw new Error('decoded preview exceeds the image byte limit');
      encoded += output.length;
      const kind = animated ? 'first frame only; animation has not been viewed' : 'image';
      previews.push({
        image: { type: 'image', url: `data:image/png;base64,${output.toString('base64')}` },
        caption: `Image ${previews.length + 1}: ${name} (${kind}${resized ? '; resized to fit 2048 pixels' : ''}).${source}`,
      });
      if (saved) notes.push(`${name}: ${metadata.width}×${metadata.height}, ${metadata.pages ?? 1} frame(s)${metadata.delay ? `, ${metadata.delay.reduce((sum, ms) => sum + ms, 0)} ms per animation cycle` : ''}.`);
    } catch (error) { warn(`preview unavailable${saved ? '; original is available locally' : ''}: ${error instanceof Error ? error.message : 'decoding failed'}`); }
  }
  return { previews, notes, warnings, ...(originals.length ? { originals } : {}) };
}
