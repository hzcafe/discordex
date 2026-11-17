import { expect, test } from 'bun:test';
import { Embed, EmbedType } from 'discord.js';
import type { APIEmbed } from 'discord.js';
import sharp from 'sharp';
import { hasIncomingMedia, discordMediaURL, inboundLimits, MediaRetryError, prepareIncomingMedia } from '../src/inbound-media.js';

// discord.js marks this constructor private in types; use the actual runtime class for wire fixtures.
const libraryEmbed = (data: APIEmbed): Embed => Reflect.construct(Embed, [data]);

const mp4Bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const cdn = 'https://cdn.discordapp.com/attachments/channel/id/photo.png';
const imageBytes = () => sharp({ create: { width: 24, height: 12, channels: 3, background: '#cc3344' } }).png().toBuffer();
const attachment = (overrides = {}) => ({ name: 'photo.png', url: cdn, size: 50, contentType: 'image/png', ...overrides });
const message = (...files: ReturnType<typeof attachment>[]) => ({ attachments: new Map(files.map((a, i) => [String(i), a])) });
const respond = (body: BodyInit, init?: ResponseInit) => (async () => new Response(body, init));

test('uploaded images become native image inputs with metadata removed and stable labels', async () => {
  const bytes = await sharp(await imageBytes()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await prepareIncomingMedia(message(attachment({ name: 'photo.jpg', contentType: 'image/jpeg' })), respond(new Uint8Array(bytes)));
  expect(result.warnings).toEqual([]);
  expect(result.notes[0]).toContain('Image 1: "photo.jpg" (image).');
  expect(result.notes[0]).toContain(cdn);
  const native = result.images[0]!;
  expect(native.type).toBe('image');
  expect(native.url).toStartWith('data:image/png;base64,');
  const decoded = await sharp(Buffer.from(native.url.split(',')[1]!, 'base64')).metadata();
  expect(decoded.width).toBe(12); expect(decoded.height).toBe(24);
  expect(decoded.exif).toBeUndefined(); expect(decoded.orientation).toBeUndefined();
});

test.each([EmbedType.GIFV, EmbedType.Video])('%s library embeds use the Discord proxy and preserve the direct MP4 link without claiming motion', async type => {
  const bytes = await imageBytes();
  const urls: string[] = [];
  const proxy = 'https://images-ext-1.discordapp.net/external/hash/https/static.klipy.com/preview.webp';
  const mp4 = 'https://static.klipy.com/firefly.mp4';
  const result = await prepareIncomingMedia({ embeds: [libraryEmbed({ type, url: 'https://klipy.com/gifs/firefly-hsr-10',
    thumbnail: { url: 'https://static.klipy.com/preview.webp', proxy_url: proxy }, video: { url: mp4 } })] },
  (async (url: any, options: any) => {
    urls.push(String(url)); expect(options.redirect).toBe('manual'); return new Response(new Uint8Array(String(url) === mp4 ? mp4Bytes : bytes));
  }));
  expect(urls).toEqual([mp4, proxy]); expect(result.images).toHaveLength(1);
  expect(result.notes[0]).toContain('still preview only; animation/video has not been viewed');
  expect(result.notes[0]).toContain(mp4);
});

test('uploaded GIFs are decoded as a labelled first frame, never passed through as animated inputs', async () => {
  const gif = await sharp(await imageBytes()).gif().toBuffer();
  const result = await prepareIncomingMedia(message(attachment({ name: 'animation.gif', contentType: 'image/gif' })), respond(new Uint8Array(gif)));
  expect(result.images[0]!.url).toStartWith('data:image/png;base64,');
  expect(result.notes[0]).toContain('first frame only; animation has not been viewed');
});

test('untrusted hosts, redirects, unsupported attachments and disguised active content cannot be downloaded or decoded as images', async () => {
  for (const url of ['http://cdn.discordapp.com/a', 'https://cdn.discordapp.com.evil.test/a', 'https://127.0.0.1/a',
    'file:///etc/passwd', 'https://user:secret@cdn.discordapp.com/a', 'https://cdn.discordapp.com:444/a']) expect(discordMediaURL(url)).toBeUndefined();
  let calls = 0;
  const untrusted = await prepareIncomingMedia(message(attachment({ url: 'https://127.0.0.1/a' }), attachment({ name: 'report.pdf', contentType: 'application/pdf', url: `${cdn}/pdf` })),
    (async () => { calls++; throw new Error('Must not download'); }));
  expect(calls).toBe(0); expect(untrusted.warnings).toHaveLength(2);
  const redirect = await prepareIncomingMedia(message(attachment()), respond('', { status: 302, headers: { location: 'http://127.0.0.1' } }));
  expect(redirect.images).toEqual([]); expect(redirect.warnings[0]).toContain('HTTP 302');
  const svg = await prepareIncomingMedia(message(attachment()), respond('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'));
  expect(svg.images).toEqual([]); expect(svg.warnings[0]).toContain('not the expected supported image or video');
});

test('real streamed byte counts and declared sizes are bounded; rejected media keeps its source link', async () => {
  const oversized = await prepareIncomingMedia(message(attachment({ size: inboundLimits.fileBytes + 1 })),
    (async () => { throw new Error('Must not fetch'); }));
  expect(oversized.warnings[0]).toContain('byte limit'); expect(oversized.notes[0]).toContain(cdn);
  let cancelled = false;
  const streamed = await prepareIncomingMedia(message(attachment()), (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(inboundLimits.fileBytes + 1)); },
    cancel() { cancelled = true; },
  }))));
  expect(streamed.images).toEqual([]); expect(cancelled).toBe(true);
  const header = await prepareIncomingMedia(message(attachment()), respond('', { headers: { 'content-length': String(inboundLimits.fileBytes + 1) } }));
  expect(header.warnings[0]).toContain('byte limit');
});

test('transient downloads stay retryable, while missing files are explicitly reported', async () => {
  for (const status of [408, 429, 503]) {
    await expect(prepareIncomingMedia(message(attachment()), respond('', { status }))).rejects.toBeInstanceOf(MediaRetryError);
  }
  await expect(prepareIncomingMedia(message(attachment()), (async () => { throw new TypeError('Connection lost'); }))).rejects.toBeInstanceOf(MediaRetryError);
  const missing = await prepareIncomingMedia(message(attachment()), respond('', { status: 404 }));
  expect(missing.warnings[0]).toContain('HTTP 404'); expect(missing.images).toEqual([]);
});

test('image count and duplicates are bounded and plain links/custom emoji text need no download', async () => {
  let calls = 0; const bytes = await imageBytes();
  const result = await prepareIncomingMedia(message(attachment(), attachment(), ...Array.from({ length: 4 }, (_, n) => attachment({ url: `${cdn}/${n}.png` }))),
    (async () => { calls++; return new Response(new Uint8Array(bytes)); }));
  expect(calls).toBe(4); expect(result.images).toHaveLength(4); expect(result.warnings).toHaveLength(1);
  expect(await prepareIncomingMedia({})).toEqual({ images: [], notes: [], warnings: [] });
  expect(hasIncomingMedia({ content: 'https://klipy.com/gifs/firefly-hsr-10' })).toBe(false);
  expect(hasIncomingMedia({ content: '<:emoji_3:1558710884912603166>' })).toBe(false);
});

test('direct media URLs are discovered immediately while unrelated links and emoji are left as text', async () => {
  for (const extension of ['gif', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'mp4', 'mov', 'webm']) {
    expect(hasIncomingMedia({ content: `https://cdn.discordapp.com/attachments/channel/id/image.${extension}` })).toBe(true);
  }
  expect(hasIncomingMedia({ content: 'https://example.org/image.gif' })).toBe(false);
  expect(hasIncomingMedia({ content: 'https://cdn.discordapp.com.evil.test/a.gif' })).toBe(false);
  const unrelated = libraryEmbed({ type: EmbedType.Rich, url: 'https://example.org', thumbnail: { url: cdn } });
  expect(await prepareIncomingMedia({ embeds: [unrelated] })).toEqual({ images: [], notes: [], warnings: [] });
});
