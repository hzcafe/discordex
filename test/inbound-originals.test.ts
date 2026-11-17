import { expect, test } from 'bun:test';
import { Embed, EmbedType, type APIEmbed } from 'discord.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from '../src/store.js';
import { defaultInbound, type InboundConfig } from '../src/config.js';
import { InboundMediaCache } from '../src/inbound-cache.js';
import { MediaRetryError, prepareIncomingMedia, type MediaMessage, type MediaFetch } from '../src/inbound-media.js';

const embed = (data: APIEmbed): Embed => Reflect.construct(Embed, [data]);
const imageURL = 'https://cdn.discordapp.com/attachments/c/i/animation.gif';
const videoURL = 'https://static.klipy.com/clip.mp4';
const previewURL = 'https://images-ext-1.discordapp.net/external/hash/https/static.klipy.com/preview.webp';
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const image = () => sharp({ create: { width: 12, height: 8, channels: 3, background: '#3399ff' } }).png().toBuffer();
const video = (thumbnail = true) => embed({ type: EmbedType.GIFV, video: { url: videoURL },
  ...(thumbnail ? { thumbnail: { url: 'https://static.klipy.com/preview.webp', proxy_url: previewURL } } : {}) });
const file = (name: string, url: string) => ({ name, url, size: 0 });
function fixture(limits: Partial<InboundConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-originals-'));
  const store = new Store(':memory:');
  const cache = new InboundMediaCache(store, dir, { ...defaultInbound, ...limits });
  return { store, cache, prepare: (message: MediaMessage, fetcher: MediaFetch, inputId = 'm1') => prepareIncomingMedia(message, fetcher, { cache, inputId }),
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('animated GIF original remains byte-for-byte intact and usable for frame extraction alongside its still', async () => {
  const f = fixture();
  const gif = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 200], loop: 0 }).toBuffer();
  try {
    const media = await f.prepare({ attachments: new Map([['gif', file('animation.gif', imageURL)]]) }, async () => new Response(new Uint8Array(gif)));
    expect(media.images).toHaveLength(1); expect(media.originals).toHaveLength(1);
    const saved = media.originals![0]!;
    expect(saved.mimeType).toBe('image/gif'); expect(readFileSync(saved.path)).toEqual(Buffer.from(gif));
    expect((await sharp(saved.path).metadata()).pages).toBe(2);
    expect(media.notes.join('\n')).toContain(saved.path); expect(media.notes.join('\n')).toContain('2 frame(s), 300 ms');
    f.store.addInput('m1', 't1', 'Use the GIF'); f.store.inputState('m1', 'delivered');
    expect(readFileSync(saved.path)).toEqual(Buffer.from(gif));
  } finally { f.close(); }
});

test('GIFV originals can themselves be animated GIFs and are not replaced by the thumbnail', async () => {
  const f = fixture(); const gif = await sharp(await image()).gif().toBuffer(); const requested: string[] = [];
  try {
    const media = await f.prepare({ embeds: [video()] }, async url => { requested.push(url); return new Response(new Uint8Array(gif)); });
    expect(requested).toEqual([videoURL]); expect(media.originals![0]!.mimeType).toBe('image/gif');
    expect(readFileSync(media.originals![0]!.path)).toEqual(Buffer.from(gif)); expect(media.images).toHaveLength(1);
  } finally { f.close(); }
});

test('video original remains available when its optional preview fails or is absent', async () => {
  const f = fixture();
  try {
    const media = await f.prepare({ embeds: [video()] }, async url => url === videoURL ? new Response(mp4) : new Response('', { status: 503 }));
    expect(media.originals).toHaveLength(1); expect(media.images).toHaveLength(0);
    expect(readFileSync(media.originals![0]!.path)).toEqual(mp4);
    expect(media.warnings.join('\n')).toContain('original is available locally');
    const noPreview = await f.prepare({ attachments: new Map([['v', file('clip.mp4', videoURL)]]) }, async () => new Response(mp4), 'm2');
    expect(noPreview.originals![0]!.mimeType).toBe('video/mp4'); expect(noPreview.images).toHaveLength(0);
    expect(noPreview.notes.join('\n')).toContain('Use the original file for frame extraction');
  } finally { f.close(); }
});

test('a raster decode failure does not discard the saved original', async () => {
  const f = fixture(); const corrupt = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  try {
    const media = await f.prepare({ attachments: new Map([['i', file('broken.png', imageURL)]]) }, async () => new Response(corrupt));
    expect(readFileSync(media.originals![0]!.path)).toEqual(corrupt); expect(media.images).toHaveLength(0);
    expect(media.warnings.join('\n')).toContain('original is available locally');
  } finally { f.close(); }
});

test('preview download budgets cannot displace later originals', async () => {
  const png = await image(); const f = fixture({ maxFileBytes: png.length + mp4.length, maxTotalBytes: png.length + mp4.length });
  try {
    const second = embed({ type: EmbedType.Image, thumbnail: { url: 'https://cdn.discordapp.com/attachments/c/i/photo.png' } });
    const media = await f.prepare({ embeds: [video(), second] }, async url => new Response(new Uint8Array(url === videoURL ? mp4 : png)));
    expect(media.originals).toHaveLength(2); expect(media.images).toHaveLength(2); expect(media.warnings).toEqual([]);
  } finally { f.close(); }
});

test('a failed stream spends its bytes and cannot reset the remaining original budget', async () => {
  const f = fixture({ maxFileBytes: 10, maxTotalBytes: 10 }); const calls: string[] = [];
  try {
    const media = await f.prepare({ attachments: new Map([['one', file('one.png', imageURL)], ['two', file('two.png', `${imageURL}?different=1`)]]),
      embeds: [embed({ type: EmbedType.Image, image: { url: 'https://cdn.discordapp.com/attachments/c/i/two.png' } })] }, async url => {
      calls.push(url); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() {} }));
    });
    expect(calls).toHaveLength(1); expect(media.originals).toBeUndefined(); expect(media.warnings.join('\n')).toContain('byte limit');
  } finally { f.close(); }
});

test('retry reuses an earlier original when a later file failed and the earlier signed URL has expired', async () => {
  const f = fixture(); const png = await image(); const secondURL = 'https://cdn.discordapp.com/attachments/c/i/two.png';
  const message = { attachments: new Map([['one', file('one.png', imageURL)], ['two', file('two.png', secondURL)]]) };
  try {
    await expect(f.prepare(message, async url => url === imageURL ? new Response(new Uint8Array(png)) : new Response('', { status: 503 }))).rejects.toBeInstanceOf(MediaRetryError);
    const retryCalls: string[] = [];
    const retry = await f.prepare(message, async url => {
      retryCalls.push(url); return url === imageURL ? new Response('', { status: 404 }) : new Response(new Uint8Array(png));
    });
    expect(retryCalls).toEqual([secondURL]); expect(retry.originals).toHaveLength(2); expect(retry.images).toHaveLength(2);
  } finally { f.close(); }
});

test('cache rejection retains a useful preview and never advertises a nonexistent original file', async () => {
  const f = fixture({ cacheBytes: 1 }); const png = await image();
  try {
    const media = await f.prepare({ embeds: [video()] }, async url => new Response(new Uint8Array(url === videoURL ? mp4 : png)));
    expect(media.originals).toBeUndefined(); expect(media.images).toHaveLength(1);
    expect(media.warnings.join('\n')).toContain('cache is full');
    const withoutPreview = await f.prepare({ embeds: [video(false)] }, async () => new Response(mp4));
    expect(withoutPreview.notes.join('\n')).not.toContain('Use the original file');
  } finally { f.close(); }
});
