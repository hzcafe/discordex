import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { discordMediaURL, inboundLimits, MediaRetryError, prepareIncomingMedia } from '../src/inbound-media.js';

const cdn = 'https://cdn.discordapp.com/attachments/channel/id/photo.png';
const imageBytes = () => sharp({ create: { width: 24, height: 12, channels: 3, background: '#cc3344' } }).png().toBuffer();
const attachment = (overrides = {}) => ({ name: 'photo.png', url: cdn, size: 50, contentType: 'image/png', ...overrides });
const files = (...items: ReturnType<typeof attachment>[]) => new Map(items.map((a, i) => [String(i), a]));
const respond = (body: BodyInit, init?: ResponseInit) => (async () => new Response(body, init));

test('uploaded images become native image inputs with metadata removed and stable labels', async () => {
  const bytes = await sharp(await imageBytes()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await prepareIncomingMedia(files(attachment({ name: 'photo.jpg', contentType: 'image/jpeg' })), respond(new Uint8Array(bytes)));
  expect(result.warnings).toEqual([]);
  expect(result.previews[0]!.caption).toContain('Image 1: "photo.jpg" (image).');
  expect(result.previews[0]!.caption).toContain(cdn);
  const native = result.previews[0]!.image;
  expect(native.type).toBe('image');
  expect(native.url).toStartWith('data:image/png;base64,');
  const decoded = await sharp(Buffer.from(native.url.split(',')[1]!, 'base64')).metadata();
  expect(decoded.width).toBe(12); expect(decoded.height).toBe(24);
  expect(decoded.exif).toBeUndefined(); expect(decoded.orientation).toBeUndefined();
});

test('uploaded GIFs are decoded as a labelled first frame, never passed through as animated inputs', async () => {
  const gif = await sharp(await imageBytes()).gif().toBuffer();
  const result = await prepareIncomingMedia(files(attachment({ name: 'animation.gif', contentType: 'image/gif' })), respond(new Uint8Array(gif)));
  expect(result.previews[0]!.image.url).toStartWith('data:image/png;base64,');
  expect(result.previews[0]!.caption).toContain('first frame only; animation has not been viewed');
});

test('untrusted hosts, redirects, unsupported attachments and disguised active content cannot be downloaded or decoded as images', async () => {
  for (const url of ['http://cdn.discordapp.com/a', 'https://cdn.discordapp.com.evil.test/a', 'https://127.0.0.1/a',
    'file:///etc/passwd', 'https://user:secret@cdn.discordapp.com/a', 'https://cdn.discordapp.com:444/a']) expect(discordMediaURL(url)).toBeUndefined();
  let calls = 0;
  const untrusted = await prepareIncomingMedia(files(attachment({ url: 'https://127.0.0.1/a' }), attachment({ name: 'report.pdf', contentType: 'application/pdf', url: `${cdn}/pdf` })),
    (async () => { calls++; throw new Error('Must not download'); }));
  expect(calls).toBe(0); expect(untrusted.warnings).toHaveLength(2);
  const redirect = await prepareIncomingMedia(files(attachment()), respond('', { status: 302, headers: { location: 'http://127.0.0.1' } }));
  expect(redirect.previews).toEqual([]); expect(redirect.warnings[0]).toContain('HTTP 302');
  const svg = await prepareIncomingMedia(files(attachment()), respond('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'));
  expect(svg.previews).toEqual([]); expect(svg.warnings[0]).toContain('not the expected supported image or video');
});

test('real streamed byte counts and declared sizes are bounded; rejected media keeps its source link', async () => {
  const oversized = await prepareIncomingMedia(files(attachment({ size: inboundLimits.fileBytes + 1 })),
    (async () => { throw new Error('Must not fetch'); }));
  expect(oversized.warnings[0]).toContain('byte limit'); expect(oversized.notes[0]).toContain(cdn);
  let cancelled = false;
  const streamed = await prepareIncomingMedia(files(attachment()), (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(inboundLimits.fileBytes + 1)); },
    cancel() { cancelled = true; },
  }))));
  expect(streamed.previews).toEqual([]); expect(cancelled).toBe(true);
  const header = await prepareIncomingMedia(files(attachment()), respond('', { headers: { 'content-length': String(inboundLimits.fileBytes + 1) } }));
  expect(header.warnings[0]).toContain('byte limit');
});

test('transient downloads stay retryable, while missing files are explicitly reported', async () => {
  for (const status of [408, 429, 503]) {
    await expect(prepareIncomingMedia(files(attachment()), respond('', { status }))).rejects.toBeInstanceOf(MediaRetryError);
  }
  await expect(prepareIncomingMedia(files(attachment()), (async () => { throw new TypeError('Connection lost'); }))).rejects.toBeInstanceOf(MediaRetryError);
  const missing = await prepareIncomingMedia(files(attachment()), respond('', { status: 404 }));
  expect(missing.warnings[0]).toContain('HTTP 404'); expect(missing.previews).toEqual([]);
});

test('at most four distinct attachments are downloaded under the default limit', async () => {
  let calls = 0; const bytes = await imageBytes();
  const attachments = files(...Array.from({ length: 5 }, (_, n) => attachment({ url: `${cdn}/${n}.png` })));
  const result = await prepareIncomingMedia(attachments, async () => { calls++; return new Response(new Uint8Array(bytes)); });
  expect(calls).toBe(4); expect(result.previews).toHaveLength(4); expect(result.warnings).toHaveLength(1);
});
