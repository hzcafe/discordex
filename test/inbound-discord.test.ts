import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Embed, EmbedType, Events, Message } from 'discord.js';
import type { APIEmbed } from 'discord.js';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { DiscordAdapter } from '../src/discord.js';
import { InputCapacityError, Store } from '../src/store.js';
import type { Config } from '../src/config.js';
import type { CodexPort } from '../src/types.js';

// discord.js marks this constructor private in types; use the actual runtime class for wire fixtures.
const libraryEmbed = (data: APIEmbed): Embed => Reflect.construct(Embed, [data]);

const mockDownload = (handler: (...args: Parameters<typeof fetch>) => Promise<Response>) => spyOn(globalThis, 'fetch').mockImplementation(Object.assign(handler, { preconnect: fetch.preconnect }));

function fixture(connected = false) {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-input-'));
  const store = new Store(':memory:');
  const config: Config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: ['/work'], socketPath: '/unused', stateDir: dir };
  store.saveBinding({ threadId: 't1', channelId: '100', parentThreadId: null, cwd: '/work', label: 'Project', since: 0, initialTurnId: null, checkpoint: null });
  const codex = Object.assign(new EventEmitter(), { connected, epoch: 'one', request: async () => ({}), respond: async () => {} }) as CodexPort;
  const adapter = new DiscordAdapter(config, store);
  const bridge = new Bridge(config, codex, store, adapter, () => {});
  (adapter as any).bridge = bridge;
  const replies: any[] = []; const reactions: string[] = [];
  const attachment = { name: 'image.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/channel/id/image.png', size: 100 };
  const msg = { id: '101', channelId: '100', guildId: 'guild', content: '', author: { id: 'alice', username: 'Alice', bot: false },
    webhookId: null, member: null, attachments: new Map([['image', attachment]]), embeds: [] as Embed[],
    reply: async (payload: any) => { replies.push(payload); }, react: async (reaction: string) => { reactions.push(reaction); } };
  adapter.client.channels.fetch = (async () => ({ isThread: () => true, guildId: 'guild', parentId: 'parent', archived: false,
    messages: { fetch: async ({ after }: { after: string }) => new Map(after === '100' ? [['101', msg]] : []) } })) as any;
  const receive = (value = msg) => (adapter as any).receive(value) as Promise<void>;
  return { store, adapter, bridge, codex, msg, replies, reactions, receive, close: async () => { await adapter.close(); await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const mp4Bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const imageBytes = () => sharp({ create: { width: 10, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();

test('image-only messages preserve ordering, deduplicate downloads, and never hold the approval queue', async () => {
  const f = fixture(); const bytes = await imageBytes();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const download = mockDownload(async () => { await ready; return new Response(new Uint8Array(bytes)); });
  try {
    await f.receive({ ...f.msg, author: { ...f.msg.author, id: 'outsider' } });
    await f.receive({ ...f.msg, channelId: 'unbound' });
    expect(download).not.toHaveBeenCalled();
    const first = f.receive(); const duplicate = f.receive(); const recovery = f.adapter.catchUp();
    const text = f.receive({ ...f.msg, id: '102', content: 'Look at that image', attachments: new Map() });
    expect(await f.bridge.serial(async () => 'approval can proceed')).toBe('approval can proceed');
    expect(f.store.inputs()).toHaveLength(0);
    release(); await Promise.all([first, duplicate, recovery, text]);
    expect(download).toHaveBeenCalledTimes(1); expect(f.replies).toHaveLength(0);
    expect(f.store.inputs().map(i => i.id)).toEqual(['101', '102']);
    expect(JSON.parse(f.store.inputs()[0]!.images)[0].url).toStartWith('data:image/png;base64,');
    expect(f.store.inputs()[0]!.text).toContain('Image 1: "image.png"');
    expect(f.reactions).toEqual(['📥', '📥']);
    // Simulate a crash after inbox insertion but before repairing the status.
    f.store.enqueue('input-media-retry:101', '100', { content: 'Waiting for images' });
    await f.receive(); expect(download).toHaveBeenCalledTimes(1);
    expect(f.store.outgoing()[0]!.payload).toContain('message is saved for Codex');
  } finally { release(); await f.close(); download.mockRestore(); }
});

test('temporary media failure keeps the history cursor retryable and repairs one status notice after recovery', async () => {
  const f = fixture(); const bytes = await imageBytes(); let unavailable = true;
  const download = mockDownload(async () => new Response(unavailable ? '' : new Uint8Array(bytes), { status: unavailable ? 503 : 200 }));
  try {
    await f.adapter.catchUp(); await f.adapter.catchUp();
    expect(f.store.getMeta('inbox-cursor:100')).toBeNull(); expect(f.store.inputs()).toEqual([]);
    expect(f.store.outgoing()).toHaveLength(1);
    expect(f.store.outgoing()[0]!.payload).toContain('retry automatically'); expect(f.replies).toHaveLength(0);
    unavailable = false; await f.adapter.catchUp();
    expect(f.store.getMeta('inbox-cursor:100')).toBe('101'); expect(f.store.inputs()).toHaveLength(1);
    expect(f.store.outgoing()).toHaveLength(1); expect(f.store.outgoing()[0]!.payload).toContain('message is saved for Codex');
  } finally { await f.close(); download.mockRestore(); }
});

test('a real discord.js Message forwards an existing GIF embed to the native Codex queue', async () => {
  const f = fixture(true); const bytes = await imageBytes();
  const link = 'https://klipy.com/gifs/firefly-hsr-10';
  const proxy = 'https://images-ext-1.discordapp.net/external/hash/https/static.klipy.com/preview.webp';
  const msg = Reflect.construct(Message, [f.adapter.client, {
    id: '101', channel_id: '100', guild_id: 'guild', type: 0, content: link,
    author: { id: 'alice', username: 'Alice', discriminator: '0', avatar: null, bot: false },
    timestamp: '2026-11-17T19:36:38.258000+00:00', mentions: [], attachments: [],
    embeds: [{ type: EmbedType.GIFV, url: link, title: 'Firefly HSR Happy Birthday Greeting',
      provider: { name: 'Klipy', url: 'https://klipy.com' },
      thumbnail: { url: 'https://static.klipy.com/preview.webp', proxy_url: proxy, width: 320, height: 220 },
      video: { url: 'https://static.klipy.com/clip.mp4', width: 320, height: 220 } }],
  }]) as Message;
  msg.react = async () => ({} as any);
  const submissions: any[] = [];
  f.codex.request = (async (method: string, params: any) => {
    if (method === 'thread/read') return { thread: { id: 't1', cwd: '/work', status: { type: 'active' } } };
    if (method === 'thread/queue/list') return { data: submissions.map(p => ({ id: 'q1', clientUserMessageId: p.clientUserMessageId })) };
    if (method === 'thread/queue/add') { submissions.push(params); return { queuedSubmission: { id: 'q1' } }; }
    throw new Error(`Unexpected method ${method}`);
  }) as CodexPort['request'];
  const download = mockDownload(async url => new Response(new Uint8Array(String(url).endsWith('.mp4') ? mp4Bytes : bytes)));
  try {
    expect(msg.embeds[0]).toBeInstanceOf(Embed);
    expect(msg.embeds[0]!.data.type).toBe(EmbedType.GIFV);
    await Promise.all([(f.adapter as any).receive(msg), (f.adapter as any).receive(msg)]);
    expect(download).toHaveBeenCalledTimes(2); expect(download.mock.calls[1]![0]).toBe(proxy);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].clientUserMessageId).toBe('101');
    expect(submissions[0].input[0].text).toContain('still preview only');
    expect(submissions[0].input[0].text).toContain('https://static.klipy.com/clip.mp4');
    expect(submissions[0].input[1].type).toBe('image');
    expect(submissions[0].input[1].url).toStartWith('data:image/png;base64,');
  } finally { await f.close(); download.mockRestore(); }
});

test('a provider link without media metadata forwards immediately without sleeping or refreshing', async () => {
  const f = fixture();
  f.msg.content = 'https://klipy.com/gifs/firefly-hsr-10'; f.msg.attachments.clear();
  (f.msg as any).fetch = async () => { throw new Error('Must not refresh'); };
  const sleep = spyOn(Bun, 'sleep').mockImplementation((() => { throw new Error('Must not sleep'); }) as typeof Bun.sleep);
  const download = mockDownload(async () => { throw new Error('Must not fetch the webpage'); });
  try {
    await f.receive();
    expect(f.store.inputs()[0]!.text).toContain(f.msg.content);
    expect(download).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
  } finally { sleep.mockRestore(); await f.close(); download.mockRestore(); }
});

test('a direct GIF uses the immediate signed original instead of a converted proxy or a message refresh', async () => {
  const f = fixture(); const bytes = await sharp(await imageBytes()).gif().toBuffer();
  const bare = 'https://cdn.discordapp.com/attachments/channel/id/animation.gif';
  const signed = `${bare}?ex=123&hm=renewed`;
  const proxy = signed.replace('cdn.discordapp.com', 'media.discordapp.net');
  f.msg.content = bare; f.msg.attachments.clear();
  f.msg.embeds = [libraryEmbed({ type: EmbedType.Image, url: bare, thumbnail: { url: signed, proxy_url: proxy } })];
  (f.msg as any).fetch = async () => { throw new Error('Must not refresh'); };
  const download = mockDownload(async () => new Response(new Uint8Array(bytes)));
  try {
    await Promise.all([f.receive(), f.receive()]);
    expect(download).toHaveBeenCalledTimes(1); expect(download.mock.calls[0]![0]).toBe(signed);
    const input = f.store.inputs()[0]!;
    expect(input.text).toContain(`Source: ${signed}`); expect(input.text).toContain('image/gif');
    expect(input.text).toContain('first frame only'); expect(JSON.parse(input.images)).toHaveLength(1);
    await f.receive(); expect(f.store.inputs()).toHaveLength(1);
  } finally { await f.close(); download.mockRestore(); }
});

test('unsupported attachments retain the text and link with a visible notice; custom emoji markup is unchanged', async () => {
  const f = fixture();
  f.msg.content = '<:emoji_3:1558710884912603166> Read this';
  f.msg.attachments.set('image', { ...f.msg.attachments.get('image')!, name: 'report.pdf', contentType: 'application/pdf' });
  const download = mockDownload(async () => { throw new Error('Do not download'); });
  try {
    await f.receive();
    expect(download).not.toHaveBeenCalled(); expect(f.store.inputs()[0]!.text).toContain(f.msg.content);
    expect(f.store.inputs()[0]!.text).toContain('Source: https://cdn.discordapp.com/');
    expect(f.store.outgoing()[0]!.payload).toContain('report.pdf'); expect(f.reactions).toEqual(['⚠️']);
  } finally { await f.close(); download.mockRestore(); }
});

test('shutdown waits for an in-flight image snapshot before the store can close', async () => {
  const f = fixture(); const bytes = await imageBytes(); let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const download = mockDownload(async () => { await ready; return new Response(new Uint8Array(bytes)); });
  try {
    const receipt = f.receive();
    const closing = f.adapter.close(); let closed = false; void closing.then(() => { closed = true; });
    await Bun.sleep(5); expect(closed).toBe(false);
    release(); await Promise.all([receipt, closing]);
    expect(f.store.inputs()).toHaveLength(1); expect(closed).toBe(true);
    await f.receive({ ...f.msg, id: '102' }); expect(download).toHaveBeenCalledTimes(1);
  } finally { release(); await f.close(); download.mockRestore(); }
});

test('a saved original still submits when the optional preview inbox is full', async () => {
  const f = fixture(); const bytes = await imageBytes();
  const add = f.store.addInput.bind(f.store);
  const admission = spyOn(f.store, 'addInput').mockImplementation((id, threadId, text, images = []) => {
    if (images.length) throw new InputCapacityError();
    return add(id, threadId, text, images);
  });
  const download = mockDownload(async () => new Response(new Uint8Array(bytes)));
  try {
    await f.receive();
    expect(f.store.inputs()).toHaveLength(1); expect(f.store.inputs()[0]!.images).toBe('[]');
    expect(f.store.inputs()[0]!.text).toContain('Original "image.png":');
    expect(f.store.inputs()[0]!.text).toContain('preview storage is full');
    expect(f.store.inputs()[0]!.text).not.toContain('Image 1:');
  } finally { admission.mockRestore(); await f.close(); download.mockRestore(); }
});

test('history recovery is isolated per channel and buffered arrivals keep order throughout the drain', async () => {
  const f = fixture();
  f.store.saveBinding({ ...f.store.binding('t1')!, threadId: 't2', channelId: '200' });
  let releaseHistory!: () => void; const history = new Promise<void>(resolve => { releaseHistory = resolve; });
  let startedFirst!: () => void; const first = new Promise<void>(resolve => { startedFirst = resolve; });
  let releaseFirst!: () => void; const blockedFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
  const submit = f.bridge.submit.bind(f.bridge);
  const submissions = spyOn(f.bridge, 'submit').mockImplementation(async (...args) => {
    if (args[1] === '101') { startedFirst(); await blockedFirst; }
    return submit(...args);
  });
  f.adapter.client.channels.fetch = (async (id: string) => ({ isThread: () => true, guildId: 'guild', parentId: 'parent', archived: false,
    messages: { fetch: async () => { if (id === '100') await history; return new Map(); } } })) as any;
  let fastReceived!: () => void; const fast = new Promise<void>(resolve => { fastReceived = resolve; });
  const msg = (id: string, channelId = '100') => ({ ...f.msg, id, channelId, content: `Message ${id}`, attachments: new Map(),
    react: async () => { if (channelId === '200') fastReceived(); } });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    f.adapter.connect(f.bridge);
    f.adapter.client.emit(Events.MessageCreate, msg('201', '200') as any);
    f.adapter.client.emit(Events.MessageCreate, msg('101') as any);
    f.adapter.client.emit(Events.MessageCreate, msg('102') as any);
    await Promise.race([fast, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Unrelated channel was blocked by history recovery')), 1000); })]);
    clearTimeout(deadline);
    expect(f.store.hasInput('201')).toBe(true); expect(f.store.hasInput('101')).toBe(false);
    releaseHistory(); await first;
    f.adapter.client.emit(Events.MessageCreate, msg('103') as any);
    releaseFirst(); await f.adapter.catchUp();
    expect(f.store.inputs('t1').map(input => input.id)).toEqual(['101', '102', '103']);
  } finally { clearTimeout(deadline); releaseHistory(); releaseFirst(); await f.close(); submissions.mockRestore(); }
});
