import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, ComponentType, ContainerComponent, Events, MessageFlags } from 'discord.js';
import { DiscordAdapter } from '../src/discord.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { MissingMessageError, MissingThreadError } from '../src/chat.js';
import type { Config } from '../src/config.js';
import type { Binding, CodexPort, Delivery, ThreadGoal } from '../src/types.js';
import { defaultArtifacts } from '../src/config.js';
import { approvalDelivery } from '../src/render.js';

test('goal slash command, create modal, budget modal, and clear button operate one shared card with private acknowledgments', async () => {
  const store = new Store(':memory:');
  const config: Config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: [], socketPath: '/unused', stateDir: '/unused' };
  store.saveBinding({ threadId: 't1', channelId: 'thread', parentThreadId: null, cwd: '/work', label: 'Project', since: 0, initialTurnId: null, checkpoint: null });
  let goal: ThreadGoal | null = null;
  const mutations: any[] = [];
  const codex = Object.assign(new EventEmitter(), { connected: true, epoch: 'one', request: async (method: string, params: any) => {
    if (method === 'thread/goal/get') return { goal: structuredClone(goal) };
    mutations.push({ method, params });
    if (method === 'thread/goal/clear') { goal = null; return { cleared: true }; }
    if (method !== 'thread/goal/set') throw new Error(`Unexpected method ${method}`);
    goal = { threadId: 't1', objective: '', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
      ...(goal ?? {}), ...params };
    return { goal: structuredClone(goal) };
  }, respond: async () => {} }) as CodexPort;
  const adapter = new DiscordAdapter(config, store);
  const sent: Delivery[] = []; const edits: { id: string; delivery: Delivery }[] = [];
  const chat = { checkThread: async () => {}, createThread: async () => 'thread', send: async (_channel: string, delivery: Delivery) => { sent.push(delivery); return 'goal-message'; },
    edit: async (_channel: string, id: string, delivery: Delivery) => { edits.push({ id, delivery }); } };
  const bridge = new Bridge(config, codex, store, chat, () => {});
  (adapter as any).bridge = bridge;
  const interaction = (kind: 'command' | 'button' | 'modal', customId = '', values: Record<string, string> = {}) => {
    const responses: { deferred?: any; edited?: any; modal?: any; reply?: any } = {};
    const event = { isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
      commandName: 'codex', guildId: 'guild', channelId: 'thread', user: { id: 'alice' }, customId,
      options: { getSubcommand: () => 'goal' }, fields: { getTextInputValue: (key: string) => values[key] },
      deferred: false, replied: false,
      deferReply: async (payload: any) => { event.deferred = true; responses.deferred = payload; },
      editReply: async (payload: any) => { responses.edited = payload; },
      showModal: async (modal: any) => { event.replied = true; responses.modal = modal.toJSON(); },
      reply: async (payload: any) => { responses.reply = payload; },
    };
    return { event, responses };
  };
  const control = (action: string) => `dx:goal:t1:${store.goalCard('t1')!.version}:${action}`;
  try {
    const command = interaction('command'); await (adapter as any).interact(command.event);
    expect(command.responses.deferred.flags).toBe(MessageFlags.Ephemeral);
    expect(sent).toHaveLength(1); expect(mutations).toHaveLength(0);
    expect(JSON.stringify(command.responses.edited)).toContain('https://discord.com/channels/guild/thread/goal-message');
    const createId = control('create');
    const button = interaction('button', createId); await (adapter as any).interact(button.event);
    expect(button.responses.deferred).toBeUndefined();
    expect(button.responses.modal.custom_id).toBe(createId);
    expect(button.responses.modal.components).toHaveLength(2);
    expect(mutations).toHaveLength(0);
    const submit = interaction('modal', createId, { objective: 'Ship it', budget: '10000' });
    await (adapter as any).interact(submit.event);
    expect(submit.responses.deferred.flags).toBe(MessageFlags.Ephemeral);
    expect(mutations[0]).toEqual({ method: 'thread/goal/set', params: { threadId: 't1', origin: 'user', objective: 'Ship it', tokenBudget: 10000, status: 'active' } });
    const budgetId = control('budget');
    const edit = interaction('button', budgetId); await (adapter as any).interact(edit.event);
    expect(edit.responses.modal.components).toHaveLength(1);
    expect(edit.responses.modal.components[0].components[0].value).toBe('10000');
    const removeBudget = interaction('modal', budgetId, { budget: '' }); await (adapter as any).interact(removeBudget.event);
    expect(mutations.at(-1).params).toEqual({ threadId: 't1', origin: 'user', tokenBudget: null });
    const clear = interaction('button', control('clear')); await (adapter as any).interact(clear.event);
    expect(mutations.at(-1)).toEqual({ method: 'thread/goal/clear', params: { threadId: 't1', origin: 'user' } });
    store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
    expect(sent).toHaveLength(1);
    expect(edits.at(-1)!.id).toBe('goal-message');
    expect(edits.at(-1)!.delivery.content).toContain('No goal set');
  } finally { await adapter.close(); await bridge.stop(); store.close(); }
});

test('usage is an ephemeral Components V2 card and an account read never occupies the bridge work queue', async () => {
  const store = new Store(':memory:');
  const config: Config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: [], socketPath: '/unused', stateDir: '/unused' };
  let release!: (value: any) => void;
  const methods: string[] = [];
  const codex = Object.assign(new EventEmitter(), { connected: true, epoch: 'one', request: async (method: string) => {
    methods.push(method); return await new Promise(resolve => { release = resolve; });
  }, respond: async () => {} }) as CodexPort;
  const adapter = new DiscordAdapter(config, store);
  const bridge = new Bridge(config, codex, store, adapter, () => {});
  (adapter as any).bridge = bridge;
  let deferred: any; let edited: any;
  const interaction = {
    isChatInputCommand: () => true, isButton: () => false, commandName: 'codex',
    guildId: 'guild', channelId: 'parent', user: { id: 'alice' }, options: { getSubcommand: () => 'usage' },
    deferReply: async (payload: any) => { deferred = payload; },
    editReply: async (payload: any) => { edited = payload; },
  };
  try {
    const pending = (adapter as any).interact(interaction);
    await Bun.sleep(0);
    expect(deferred.flags).toBe(MessageFlags.Ephemeral);
    expect(await bridge.serial(async () => 'approval can proceed')).toBe('approval can proceed');
    release({ rateLimits: { primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: null } } });
    await pending;
    expect(methods).toEqual(['account/rateLimits/read']);
    expect(edited.flags).toBe(MessageFlags.IsComponentsV2);
    const container = edited.components[0].toJSON();
    expect(container.type).toBe(ComponentType.Container);
    expect(JSON.stringify(container)).toContain('65% left');
    expect(JSON.stringify(container)).toContain('🟦🟦🟦🟦🟦🟦⬛⬛⬛⬛');
    expect(edited.allowedMentions.parse).toEqual([]);
    expect(edited.files).toHaveLength(0);
  } finally { await adapter.close(); await bridge.stop(); store.close(); }
});

test('a disabled Message Content Intent fails startup with an actionable error instead of hanging', async () => {
  const store = new Store(':memory:');
  const adapter = new DiscordAdapter({} as Config, store);
  const disconnectListeners = adapter.client.listenerCount(Events.ShardDisconnect);
  const readyListeners = adapter.client.listenerCount(Events.ClientReady);
  adapter.client.login = () => {
    queueMicrotask(() => adapter.client.emit(Events.ShardDisconnect, { code: 4014 } as any, 0));
    return new Promise<string>(() => {});
  };
  try {
    await expect(adapter.login('test-token')).rejects.toThrow('Enable Message Content Intent');
    expect(adapter.client.listenerCount(Events.ShardDisconnect)).toBe(disconnectListeners);
    expect(adapter.client.listenerCount(Events.ClientReady)).toBe(readyListeners);
  } finally { await adapter.close(); store.close(); }
});

test('Discord history recovery paginates, filters bot/unauthorized messages, and deduplicates live echoes', async () => {
  const store = new Store(':memory:');
  const config: Config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: ['/work'], socketPath: '/unused', stateDir: '/unused' };
  const binding: Binding = { threadId: 't1', parentThreadId: null, channelId: '100', label: 'Project', cwd: '/work',
    since: 0, initialTurnId: null, checkpoint: null };
  store.saveBinding(binding);
  const codex = Object.assign(new EventEmitter(), { connected: false, epoch: 'offline', request: async () => ({}), respond: async () => {} }) as CodexPort;
  const adapter = new DiscordAdapter(config, store);
  const bridge = new Bridge(config, codex, store, adapter, () => {});
  const messages = Array.from({ length: 250 }, (_, n) => ({
    id: String(101 + n), guildId: 'guild', channelId: '100', content: `Message ${n}`,
    author: { id: n === 2 ? 'outsider' : 'alice', username: 'Alice', bot: n === 1 },
    webhookId: null, member: null, react: async () => {}, reply: async () => {},
  }));
  let pages = 0;
  const channel = { isThread: () => true, guildId: 'guild', parentId: 'parent', archived: false,
    messages: { fetch: async ({ after }: { after: string }) => {
      pages++; return new Map(messages.filter(m => BigInt(m.id) > BigInt(after)).slice(0, 100).reverse().map(m => [m.id, m]));
    } } };
  adapter.client.channels.fetch = (async () => channel) as any;
  try {
    adapter.connect(bridge);
    for (let i = 0; i < 100 && store.getMeta('inbox-cursor:100') !== '350'; i++) await Bun.sleep(5);
    expect(store.getMeta('inbox-cursor:100')).toBe('350');
    expect(pages).toBe(3);
    expect(store.inputs()).toHaveLength(248);
    expect(store.inputs()[0]!.id).toBe('101');
    adapter.client.emit(Events.MessageCreate, messages[0] as any);
    await bridge.serial(async () => {});
    expect(store.inputs()).toHaveLength(248);
    await adapter.catchUp();
    expect(store.inputs()).toHaveLength(248);
  } finally { await adapter.close(); await bridge.stop(); store.close(); }
});

test('non-text warnings deduplicate concurrent receipt, recovery, and restart while failed replies can retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-non-text-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  const config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'] } as Config;
  store.saveBinding({ threadId: 't1', parentThreadId: null, channelId: '100', label: 'Project', cwd: '/work',
    since: 0, initialTurnId: null, checkpoint: null });
  let replies = 0;
  let release!: () => void;
  let fail = true;
  const message = { id: '101', guildId: 'guild', channelId: '100', content: '', author: { id: 'alice', bot: false },
    webhookId: null, reply: async (payload: any) => {
      replies++;
      expect(payload.enforceNonce).toBe(true);
      if (fail) throw new Error('Reply failed');
      await new Promise<void>(resolve => { release = resolve; });
    } };
  const setup = () => {
    const adapter = new DiscordAdapter(config, store);
    (adapter as any).bridge = { eligible: () => true };
    adapter.client.channels.fetch = (async () => ({ isThread: () => true, guildId: 'guild', parentId: 'parent',
      messages: { fetch: async ({ after }: { after: string }) => new Map(after === '100' ? [['101', message]] : []) } })) as any;
    return adapter;
  };
  let adapter = setup();
  try {
    await expect((adapter as any).receive(message)).rejects.toThrow('Reply failed');
    expect(store.getMeta('non-text-reply:101')).toBeNull();
    fail = false;
    const live = (adapter as any).receive(message);
    const duplicate = (adapter as any).receive(message);
    const recovery = adapter.catchUp();
    await Promise.resolve();
    expect(replies).toBe(2);
    expect(store.getMeta('inbox-cursor:100')).toBeNull();
    release();
    await Promise.all([live, duplicate, recovery]);
    expect(store.getMeta('inbox-cursor:100')).toBe('101');
    expect(store.getMeta('non-text-reply:101')).toBe('sent');
    await adapter.close();
    store.close();
    store = new Store(path);
    adapter = setup();
    // Replay even if a crash left history behind the successfully sent warning.
    store.setMeta('inbox-cursor:100', '100');
    await adapter.catchUp();
    await (adapter as any).receive(message);
    expect(replies).toBe(2);
    expect(store.getMeta('inbox-cursor:100')).toBe('101');
  } finally { await adapter.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('shutdown waits for live non-text replies and ignores late inputs after the store closes', async () => {
  for (const fail of [false, true]) {
    const store = new Store(':memory:');
    store.saveBinding({ threadId: 't1', parentThreadId: null, channelId: '100', label: 'Project', cwd: '/work',
      since: 0, initialTurnId: null, checkpoint: null });
    const adapter = new DiscordAdapter({ guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'] } as Config, store);
    (adapter as any).bridge = {};
    let release!: () => void;
    let replies = 0;
    const message = { id: '101', guildId: 'guild', channelId: '100', content: '', author: { id: 'alice', bot: false },
      webhookId: null, reply: async () => {
        replies++;
        await new Promise<void>(resolve => { release = resolve; });
        if (fail) throw new Error('Reply failed');
      } };
    const received = (adapter as any).receive(message).catch((error: Error) => error);
    await Promise.resolve();
    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(store.getMeta('non-text-reply:101')).toBe(fail ? null : 'sent');
    expect((await received) instanceof Error).toBe(fail);
    store.close();
    await (adapter as any).receive(message);
    await (adapter as any).interact({});
    expect(replies).toBe(1);
  }
});

test('commands acknowledged during shutdown cannot start work after the store closes', async () => {
  for (const subcommand of ['status', 'goal']) {
    const store = new Store(':memory:');
    const config: Config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
      autoDiscover: false, projectRoots: [], socketPath: '/unused', stateDir: '/unused' };
    store.saveBinding({ threadId: 't1', channelId: 'thread', parentThreadId: null, cwd: '/work', label: 'Project', since: 0, initialTurnId: null, checkpoint: null });
    let requests = 0;
    const codex = Object.assign(new EventEmitter(), { connected: false, epoch: 'one',
      request: async () => { requests++; throw new Error('Unexpected request'); }, respond: async () => {} }) as CodexPort;
    const adapter = new DiscordAdapter(config, store);
    const bridge = new Bridge(config, codex, store, adapter, () => {});
    (adapter as any).bridge = bridge;
    let release!: () => void;
    const acknowledged = new Promise<void>(resolve => { release = resolve; });
    let edited: any;
    const interaction = { isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false,
      commandName: 'codex', guildId: 'guild', channelId: 'thread', user: { id: 'alice' },
      options: { getSubcommand: () => subcommand }, deferred: true, replied: false,
      deferReply: () => acknowledged, editReply: async (payload: any) => { edited = payload; } };
    const handling = (adapter as any).interact(interaction);
    await adapter.close(); await bridge.stop(); store.close();
    release(); await handling;
    expect(JSON.stringify(edited)).toContain('Discordex is shutting down');
    expect(JSON.stringify(edited)).not.toContain('closed database');
    expect(requests).toBe(0);
  }
});

test('shutdown does not advance recovery past fetched messages it has not received', async () => {
  const store = new Store(':memory:');
  store.saveBinding({ threadId: 't1', parentThreadId: null, channelId: '100', label: 'Project', cwd: '/work',
    since: 0, initialTurnId: null, checkpoint: null });
  const adapter = new DiscordAdapter({ guildId: 'guild', channelId: 'parent' } as Config, store);
  (adapter as any).bridge = { eligible: () => true };
  let fetched!: (messages: Map<string, any>) => void;
  const pending = new Promise<Map<string, any>>(resolve => { fetched = resolve; });
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  adapter.client.channels.fetch = (async () => ({ isThread: () => true, guildId: 'guild', parentId: 'parent',
    messages: { fetch: () => { fetchStarted(); return pending; } } })) as any;
  try {
    const recovery = adapter.catchUp();
    await started;
    const closing = adapter.close();
    fetched(new Map([['101', { id: '101' }]]));
    await Promise.all([recovery, closing]);
    expect(store.getMeta('inbox-cursor:100')).toBeNull();
  } finally { await adapter.close(); store.close(); }
});

test('restart reuses an existing Discord thread when its channel is not cached', async () => {
  const store = new Store(':memory:');
  const config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: [], socketPath: '/unused', stateDir: '/unused' } as Config;
  const adapter = new DiscordAdapter(config, store);
  let starts = 0;
  store.setMeta('starter:t1', 'saved-starter');
  adapter.client.channels.fetch = (async () => ({ isThread: () => true, guildId: 'guild', parentId: 'parent' })) as any;
  (adapter as any).parent = { messages: { fetch: async () => ({
    id: 'saved-starter', hasThread: true, thread: null, startThread: async () => { starts++; },
  }) } };
  try {
    expect(await adapter.createThread({ id: 't1', cwd: '/work', status: { type: 'idle' } })).toBe('saved-starter');
    expect(starts).toBe(0);
  } finally { await adapter.close(); store.close(); }
});

function recoveryFixture() {
  const store = new Store(':memory:');
  const config: Config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: ['/work'], socketPath: '/unused', stateDir: '/unused' };
  const adapter = new DiscordAdapter(config, store);
  const thread = { id: 't1', cwd: '/work', status: { type: 'idle' } };
  const messages = new Map<string, any>();
  const channels = new Map<string, any>();
  const sends: any[] = [];
  const reads: { id: string; force: boolean }[] = [];
  const missing = (code: number) => Object.assign(new Error('Not found'), { code, status: 404 });
  const fetchChannel = async (id: string, options: any) => {
    reads.push({ id, force: options?.force });
    if (!channels.has(id)) throw missing(10003);
    return channels.get(id);
  };
  adapter.client.channels.fetch = fetchChannel as any;
  const parent = {
    send: async (payload: any) => {
      sends.push(payload);
      const id = String(100 + sends.length);
      const message = { id, hasThread: false, startThread: async () => {
        message.hasThread = true;
        channels.set(id, { id, isThread: () => true, guildId: 'guild', parentId: 'parent',
          messages: { fetch: async () => new Map() } });
        return { id };
      } };
      messages.set(id, message); return message;
    },
    messages: { fetch: async ({ message }: { message: string }) => {
      if (!messages.has(message)) throw missing(10008);
      return messages.get(message);
    } },
  };
  (adapter as any).parent = parent;
  return { adapter, store, config, thread, messages, channels, sends, reads, parent, fetchChannel };
}

test('replacement creation survives a lost binding commit and rotates the nonce when its starter is deleted', async () => {
  const f = recoveryFixture();
  let restarted: DiscordAdapter | undefined;
  try {
    const replacement = await f.adapter.createThread(f.thread, 'deleted-channel');
    await f.adapter.close();
    restarted = new DiscordAdapter(f.config, f.store);
    (restarted as any).parent = f.parent;
    restarted.client.channels.fetch = f.fetchChannel as any;
    expect(await restarted.createThread(f.thread, 'deleted-channel')).toBe(replacement);
    expect(f.sends).toHaveLength(1);
    expect(f.reads).toContainEqual({ id: replacement, force: true });
    f.messages.delete(replacement);
    expect(await restarted.createThread(f.thread, 'deleted-channel')).toBe(replacement);
    expect(f.sends).toHaveLength(1);
    f.channels.delete(replacement);
    const next = await restarted.createThread(f.thread, 'deleted-channel');
    expect(next).not.toBe(replacement);
    expect(f.sends).toHaveLength(2);
    expect(f.store.getMeta('starter:t1:replacement:deleted-channel:generation')).toBe(
      `starter:t1:replacement:deleted-channel:after:${replacement}`);
    expect(f.sends[1].nonce).not.toBe(f.sends[0].nonce);
    expect(await restarted.createThread(f.thread, 'deleted-channel')).toBe(next);
    expect(f.sends).toHaveLength(2);
  } finally { await restarted?.close(); await f.adapter.close(); f.store.close(); }
});

test('saved starter flags cannot resurrect a deleted thread, and a lost create response reuses its surviving thread', async () => {
  const f = recoveryFixture();
  try {
    const original = await f.adapter.createThread(f.thread);
    f.channels.delete(original); // The starter still reports hasThread.
    const next = await f.adapter.createThread(f.thread);
    expect(next).not.toBe(original);
    expect(f.sends).toHaveLength(2);
    const send = f.parent.send;
    f.parent.send = async payload => {
      const starter = await send(payload);
      const start = starter.startThread;
      starter.startThread = async () => { await start(); throw new Error('Response lost'); };
      return starter;
    };
    await expect(f.adapter.createThread(f.thread, next)).rejects.toThrow('Response lost');
    expect(await f.adapter.createThread(f.thread, next)).toBe('103');
    expect(f.sends).toHaveLength(3);
  } finally { await f.adapter.close(); f.store.close(); }
});

test('startup polling and duplicate deletion events repair an idle thread even while Codex is offline', async () => {
  const f = recoveryFixture();
  f.store.saveBinding({ threadId: 't1', parentThreadId: null, channelId: 'deleted', label: 'Project', cwd: '/work',
    since: 0, initialTurnId: null, checkpoint: null });
  const codex = Object.assign(new EventEmitter(), { connected: false, epoch: 'offline',
    request: async () => { throw new Error('Recovery must not call Codex'); }, respond: async () => {} }) as CodexPort;
  const bridge = new Bridge(f.config, codex, f.store, f.adapter, () => {});
  try {
    f.adapter.connect(bridge);
    for (let i = 0; i < 100 && f.store.binding('t1')!.channelId === 'deleted'; i++) await Bun.sleep(1);
    expect(f.store.binding('t1')!.channelId).toBe('101');
    f.channels.delete('101');
    const event = { id: '101', guildId: 'guild', parentId: 'parent' } as any;
    f.adapter.client.emit(Events.ThreadDelete, event); f.adapter.client.emit(Events.ThreadDelete, event);
    await bridge.serial(async () => {});
    expect(f.store.binding('t1')!.channelId).toBe('102');
    expect(f.sends).toHaveLength(2);
    await f.adapter.catchUp();
    expect(f.sends).toHaveLength(2);
  } finally { await f.adapter.close(); await bridge.stop(); f.store.close(); }
});

test('only specific Discord 404s trigger replacement; archived threads stay reusable and access errors stay errors', async () => {
  const f = recoveryFixture();
  try {
    await expect(f.adapter.checkThread('missing')).rejects.toBeInstanceOf(MissingThreadError);
    for (const error of [Object.assign(new Error('Missing Access'), { code: 50001, status: 403 }),
      Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }),
      Object.assign(new Error('Forbidden'), { code: 10003, status: 403 }),
      Object.assign(new Error('Proxy error'), { status: 404 }), new Error('Network failed')]) {
      f.adapter.client.channels.fetch = (async () => { throw error; }) as any;
      await expect(f.adapter.checkThread('missing')).rejects.toBe(error);
    }
    f.adapter.client.channels.fetch = f.fetchChannel as any;
    let activations = 0;
    const channel = { isThread: () => true, guildId: 'guild', parentId: 'parent', archived: true, locked: false,
      setArchived: async () => { activations++; channel.archived = false; },
      send: async () => ({ id: 'sent' }), messages: { edit: async () => { throw Object.assign(new Error('Deleted card'), { code: 10008, status: 404 }); } } };
    f.channels.set('archived', channel);
    await f.adapter.checkThread('archived'); expect(activations).toBe(0);
    await f.adapter.send('archived', { content: 'hello' }, 'nonce'); expect(activations).toBe(1);
    await expect(f.adapter.edit('archived', 'deleted-card', { content: 'latest' })).rejects.toBeInstanceOf(MissingMessageError);
    channel.send = async () => { throw Object.assign(new Error('Thread removed after fetch'), { code: 10003, status: 404 }); };
    await expect(f.adapter.send('archived', { content: 'hello' }, 'nonce')).rejects.toBeInstanceOf(MissingThreadError);
    expect(f.sends).toHaveLength(0);
  } finally { await f.adapter.close(); f.store.close(); }
});

test('Discord attachment IDs survive adapter restart, text edits retain files, and missing attachments are reuploaded', async () => {
  const f = recoveryFixture();
  const data = Buffer.from('# Plan'); const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  f.store.saveArtifact('artifact', 'reply', '{}', hash, data, 1000);
  const delivery: Delivery = { content: '[Plan](/work/docs/plan.md)', artifacts: [{ hash, name: 'plan.md', kind: 'file', size: data.length,
    references: ['/work/docs/plan.md'] }] };
  let current = new Collection<string, any>();
  const sends: any[] = []; const edits: any[] = [];
  let nextId = 0;
  const record = (payload: any) => {
    current = new Collection((payload.attachments ?? []).map((a: any) => [a.id, { id: a.id, name: a.filename }]));
    for (const file of payload.files) { const id = String(++nextId); current.set(id, { id, name: file.name }); }
    return { id: 'reply', attachments: current };
  };
  const channel = { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => { sends.push(payload); return record(payload); },
    messages: { fetch: async () => ({ id: 'reply', attachments: current }),
      edit: async (_id: string, payload: any) => { edits.push(payload); return record(payload); } } };
  f.channels.set('thread', channel);
  let restarted: DiscordAdapter | undefined;
  try {
    await f.adapter.send('thread', delivery, 'nonce');
    expect(sends[0].files).toHaveLength(1);
    expect(JSON.stringify(sends[0].components)).toContain('Plan — `plan.md`');
    restarted = new DiscordAdapter(f.config, f.store); restarted.client.channels.fetch = f.fetchChannel as any;
    await restarted.edit('thread', 'reply', { ...delivery, content: 'Updated text' });
    expect(edits[0].files).toHaveLength(0);
    expect(edits[0].attachments).toEqual([{ id: '1', filename: 'plan.md' }]);
    current.clear();
    await restarted.edit('thread', 'reply', delivery);
    expect(edits[1].files).toHaveLength(1); expect(edits[1].attachments).toEqual([]);
    f.store.db.query('DELETE FROM artifact_blobs').run();
    await restarted.edit('thread', 'reply', delivery);
    expect(edits[2].files).toHaveLength(0);
    expect(edits[2].attachments).toEqual([{ id: '2', filename: 'plan.md' }]);
    expect(JSON.stringify(edits[2].components)).toContain('Plan — `plan.md`');
    current.clear();
    await restarted.edit('thread', 'reply', delivery);
    expect(edits[3].files).toHaveLength(0);
    expect(edits[3].attachments).toEqual([]);
    expect(JSON.stringify(edits[3].components)).toContain(delivery.content);
  } finally { await restarted?.close(); await f.adapter.close(); f.store.close(); }
});

test('a temporary edit failure preserves already uploaded files for the outbox retry', async () => {
  const f = recoveryFixture();
  const data = Buffer.from('existing attachment');
  const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  const attachment = { id: '123', name: 'plan.md' };
  f.store.setMeta('attachments:thread:reply', JSON.stringify([{ ...attachment, hash }]));
  const delivery: Delivery = { content: 'Updated', artifacts: [{ hash, name: attachment.name, kind: 'file', size: data.length }] };
  const error = Object.assign(new Error('Unavailable'), { status: 503 });
  const edits: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent', messages: {
    fetch: async () => ({ id: 'reply', attachments: new Collection([[attachment.id, attachment]]) }),
    edit: async (_id: string, payload: any) => { edits.push(payload); throw error; },
  } });
  try {
    await expect(f.adapter.edit('thread', 'reply', delivery)).rejects.toBe(error);
    expect(edits).toHaveLength(1);
    expect(edits[0].files).toHaveLength(0);
    expect(edits[0].attachments).toEqual([{ id: attachment.id, filename: attachment.name }]);
  } finally { await f.adapter.close(); f.store.close(); }
});

test.each(['file', 'image', 'video'] as const)('V2 %s attachments survive edits and cache expiry without reuploading', async kind => {
  const f = recoveryFixture();
  const name = kind === 'file' ? 'plan.md' : kind === 'image' ? 'shot.png' : 'demo.mp4';
  const data = Buffer.from('saved file');
  const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  f.store.saveArtifact('artifact', 'reply', '{}', hash, data, 1000);
  const delivery: Delivery = { content: 'Attached', artifacts: [{ hash, name, kind, size: data.length }] };
  const media = { attachment_id: '12345', url: 'https://cdn.discordapp.com/opaque-media?ex=expired' };
  const current = { id: 'reply', attachments: new Collection(), components: [new (ContainerComponent as any)({ type: 17,
    components: [kind === 'file' ? { type: 13, name, file: media } : { type: 12, items: [{ media, description: name }] }] })] };
  const edits: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent', send: async () => current,
    messages: { fetch: async () => current, edit: async (_id: string, payload: any) => { edits.push(payload); return current; } } });
  try {
    await f.adapter.send('thread', delivery, 'nonce');
    await f.adapter.edit('thread', 'reply', { ...delivery, content: 'Revised' });
    expect(edits[0].files).toHaveLength(0);
    expect(edits[0].attachments).toEqual([{ id: '12345', filename: name }]);
    f.store.db.query('DELETE FROM artifact_blobs').run();
    await f.adapter.edit('thread', 'reply', delivery);
    expect(edits[1].files).toHaveLength(0);
    expect(edits[1].attachments).toEqual([{ id: '12345', filename: name }]);
    expect(JSON.stringify(edits[1].components)).not.toContain('expired');
  } finally { await f.adapter.close(); f.store.close(); }
});

test('generated reply files obey configured byte limits even when automatic sharing is disabled', async () => {
  const f = recoveryFixture();
  f.config.artifacts = { ...defaultArtifacts, enabled: false, maxFileBytes: 10, maxTotalBytes: 12 };
  const sent: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => { sent.push(payload); return { id: 'reply', attachments: new Collection() }; } });
  try {
    await f.adapter.send('thread', { content: 'Summary\n\nFull text below.', file: { name: 'response.md', content: '🙂'.repeat(3) } }, 'nonce');
    expect(sent[0].files).toHaveLength(0);
    expect(JSON.stringify(sent[0].components)).toContain('size limit');
    expect(JSON.stringify(sent[0].components)).not.toContain('Full text below');
    expect(JSON.stringify(sent[0].components)).toContain('Summary');
  } finally { await f.adapter.close(); f.store.close(); }
});

test('generic invalid form errors propagate without resending or editing away files', async () => {
  const f = recoveryFixture();
  const error = Object.assign(new Error('Invalid Form Body'), { status: 400, code: 50035 });
  const calls: any[] = [];
  const reject = async (payload: any) => { calls.push(payload); throw error; };
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: reject, messages: { edit: (_id: string, payload: any) => reject(payload) } });
  const delivery = { content: 'Preview', file: { name: 'response.md', content: 'Full answer' } };
  try {
    await expect(f.adapter.send('thread', delivery, 'nonce')).rejects.toBe(error);
    await expect(f.adapter.edit('thread', 'message', delivery)).rejects.toBe(error);
    expect(calls.map(payload => payload.files.length)).toEqual([1, 1]);
  } finally { await f.adapter.close(); f.store.close(); }
});

test('Discord upload-limit failures deliver text with a notice instead of blocking the outbox', async () => {
  const f = recoveryFixture();
  const data = Buffer.from('# Plan'); const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  f.store.saveArtifact('artifact', 'reply', '{}', hash, data, 1000);
  const sent: any[] = []; const edited: any[] = [];
  const response = (payload: any) => {
    if (payload.files.length) throw Object.assign(new Error('Too large'), { status: 413 });
    return { id: 'message', attachments: new Collection() };
  };
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => { sent.push(payload); return response(payload); },
    messages: { edit: async (_id: string, payload: any) => { edited.push(payload); return response(payload); } } });
  try {
    const delivery: Delivery = { content: 'Here is the answer [Plan](/work/docs/plan.md)', file: { name: 'response.md', content: 'Long answer' },
      artifacts: [{ hash, name: 'plan.md', kind: 'file', size: data.length, references: ['/work/docs/plan.md'] }] };
    expect(await f.adapter.send('thread', delivery, 'nonce')).toBe('message');
    expect(sent).toHaveLength(2); expect(sent[1].files).toHaveLength(0);
    expect(JSON.stringify(sent[1].components)).toContain('rejected the file upload');
    expect(JSON.stringify(sent[1].components)).toContain('Here is the answer');
    expect(JSON.stringify(sent[0].components)).toContain('Plan — `plan.md`');
    expect(JSON.stringify(sent[1].components)).toContain(delivery.content);
    await f.adapter.edit('thread', 'message', delivery);
    expect(edited).toHaveLength(2); expect(edited[1].files).toHaveLength(0);
    expect(JSON.stringify(edited[0].components)).toContain('Plan — `plan.md`');
    expect(JSON.stringify(edited[1].components)).toContain(delivery.content);
  } finally { await f.adapter.close(); f.store.close(); }
});

test.each(['size limit', 'Discord rejection'])('approval controls disappear when full review details are lost to %s', async failure => {
  const f = recoveryFixture();
  if (failure === 'size limit') f.config.artifacts = { ...defaultArtifacts, maxFileBytes: 10, maxTotalBytes: 12 };
  const payloads: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => {
      payloads.push(payload);
      if (failure === 'Discord rejection' && payload.files.length) throw Object.assign(new Error('Too large'), { status: 413 });
      return { id: 'reply', attachments: new Collection() };
    } });
  try {
    const delivery = approvalDelivery({ token: 'prompt', epoch: 'one', rpcId: '1', threadId: 't', channel: 'thread', state: 'pending',
      packet: JSON.stringify({ id: 1, method: 'item/fileChange/requestApproval', params: { discordexDiff: '+change\n'.repeat(700) } }) });
    expect(delivery.buttons!.some(b => b.id.endsWith(':accept'))).toBe(true);
    const receipt = await f.adapter.send('thread', delivery, 'nonce');
    expect(receipt).toEqual({ id: 'reply', approvalReview: { token: 'prompt', state: 'unavailable' } });
    const sent = payloads.at(-1);
    expect(sent.files).toHaveLength(0);
    expect(JSON.stringify(sent.components)).not.toContain('dx:prompt:accept');
    expect(JSON.stringify(sent.components)).not.toContain('/codex retry');
    expect(JSON.stringify(sent.components)).toContain('Open this session in Codex on the host to review and respond');
    expect(JSON.stringify(sent.components)).toContain(failure === 'size limit' ? 'exceed the attachment size limit' : 'Discord rejected the file');
  } finally { await f.adapter.close(); f.store.close(); }
});

test.each(['service', 'network'])('temporary %s upload failure recovers approval controls automatically without blocking later messages', async failure => {
  const f = recoveryFixture();
  f.store.saveBinding({ threadId: 't1', channelId: 'thread', parentThreadId: null, label: 'Project', cwd: '/work', since: 0, initialTurnId: null, checkpoint: null });
  const responses: unknown[] = [];
  const codex = Object.assign(new EventEmitter(), { connected: true, epoch: 'epoch',
    request: async () => { throw new Error('Unexpected RPC'); }, respond: async (_id: unknown, value: unknown) => { responses.push(value); } }) as CodexPort;
  const bridge = new Bridge(f.config, codex, f.store, f.adapter, () => {});
  (f.adapter as any).bridge = bridge;
  let rejectReview = true;
  let attachments = new Collection<string, any>();
  const payloads: any[] = [];
  const receive = (payload: any) => {
    if (rejectReview && payload.files.some((file: any) => file.name === 'approval.txt')) throw Object.assign(new Error('Temporary upload failure'), failure === 'service' ? { status: 503 } : { code: 'ECONNRESET' });
    payloads.push(payload);
    attachments = new Collection(payload.files.map((file: any, i: number) => [String(i), { id: String(i), name: file.name }]));
    return { id: 'message', attachments };
  };
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => receive(payload), messages: {
      fetch: async () => ({ id: 'message', attachments }), edit: async (_id: string, payload: any) => receive(payload),
    } });
  try {
    await bridge.serverRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: {
      threadId: 't1', command: 'git status', reason: 'Review context. '.repeat(400), availableDecisions: ['accept', 'decline'],
    } });
    await Bun.sleep(0); await bridge.flush();
    const a = f.store.pendingApprovals()[0]!;
    expect(a.reviewDelivery).toBe('unavailable');
    expect(JSON.stringify(payloads.at(-1).components)).not.toContain(`dx:${a.token}:accept`);
    expect(JSON.stringify(payloads.at(-1).components)).toContain('retrying automatically');
    expect(JSON.stringify(payloads.at(-1).components)).not.toContain('/codex retry');
    await expect(bridge.decide(a.token, 'accept', 'thread', 'alice')).rejects.toThrow('not been delivered');
    const partial = f.store.db.query<{ pending: number; partial: number; attempts: number; nextAttempt: number }, []>('SELECT pending, partial, attempts, nextAttempt FROM outbox').get()!;
    expect(partial).toMatchObject({ pending: 1, partial: 1, attempts: 1 });
    expect(partial.nextAttempt).toBeGreaterThan(Date.now());
    const count = payloads.length;
    await bridge.flush();
    expect(payloads).toHaveLength(count);
    f.store.enqueue('later', 'thread', { content: 'Later message' });
    await bridge.flush();
    expect(JSON.stringify(payloads.at(-1).components)).toContain('Later message');
    expect(responses).toHaveLength(0);
    rejectReview = false;
    f.store.db.query('UPDATE outbox SET nextAttempt = 0').run();
    await bridge.flush();
    expect(f.store.approval(a.token)!.reviewDelivery).toBe('ready');
    expect(JSON.stringify(payloads.at(-1).components)).toContain(`dx:${a.token}:accept`);
    expect(f.store.db.query<{ partial: number; pending: number }, [string]>('SELECT partial, pending FROM outbox WHERE key = ?').get(`approval:${a.token}`)).toEqual({ partial: 0, pending: 0 });
    await bridge.decide(a.token, 'accept', 'thread', 'alice');
    expect(responses).toEqual([{ decision: 'accept' }]);
  } finally { await bridge.stop(); await f.adapter.close(); f.store.close(); }
});

test('ordinary attachments retry on the same message and replace file references only after recovery', async () => {
  const f = recoveryFixture();
  const data = Buffer.from('# Original plan'); const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  f.store.saveArtifact('artifact', 'reply', '{}', hash, data, 1000);
  const delivery: Delivery = { content: '[Plan](/work/docs/plan.md)', artifacts: [
    { hash, name: 'plan.md', kind: 'file', size: data.length, references: ['/work/docs/plan.md'] },
  ] };
  const codex = Object.assign(new EventEmitter(), { connected: false, epoch: 'e', request: async () => {}, respond: async () => {} }) as CodexPort;
  const bridge = new Bridge(f.config, codex, f.store, f.adapter, () => {});
  let fail = true;
  const sent: any[] = []; const edited: any[] = [];
  const receive = (payload: any) => {
    if (fail && payload.files.length) throw Object.assign(new Error('Upload unavailable'), { status: 503 });
    return { id: 'reply-message', attachments: new Collection(payload.files.map((file: any, i: number) => [String(i), { id: String(i), name: file.name }])) };
  };
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => { const result = receive(payload); sent.push(payload); return result; },
    messages: { edit: async (id: string, payload: any) => { expect(id).toBe('reply-message'); const result = receive(payload); edited.push(payload); return result; } } });
  try {
    f.store.enqueue('reply', 'thread', delivery);
    await bridge.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].files).toHaveLength(0);
    expect(JSON.stringify(sent[0].components)).toContain(delivery.content);
    expect(JSON.stringify(sent[0].components)).toContain('retrying automatically');
    expect(f.store.messageId('reply')).toBe('reply-message');
    fail = false;
    f.store.db.query('UPDATE outbox SET nextAttempt = 0').run();
    await bridge.flush();
    expect(sent).toHaveLength(1);
    expect(edited).toHaveLength(1);
    expect(JSON.stringify(edited[0].components)).toContain('Plan — `plan.md`');
    expect(Buffer.from(edited[0].files[0].attachment).toString()).toBe('# Original plan');
    expect(f.store.outgoing()).toHaveLength(0);
  } finally { await bridge.stop(); await f.adapter.close(); f.store.close(); }
});

test.each(['full', 'fallback'])('an accepted %s send with a lost response reconciles the nonce receipt on the same message', async accepted => {
  const f = recoveryFixture();
  const delivery = approvalDelivery({ token: 'prompt', epoch: 'one', rpcId: '1', threadId: 't', channel: 'thread', state: 'pending',
    packet: JSON.stringify({ id: 1, method: 'item/fileChange/requestApproval', params: { discordexDiff: '+change\n'.repeat(700) } }) });
  const lostResponse = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
  const response = (payload: any) => ({ id: 'reply', attachments: new Collection<string, any>(
    payload.files.map((file: any, i: number) => [String(i), { id: String(i), name: file.name }])) });
  let current: ReturnType<typeof response> | undefined;
  const edits: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => {
      expect(payload.nonce).toBe('nonce');
      expect(payload.enforceNonce).toBe(true);
      if (current) return current;
      if (accepted === 'full' || !payload.files.length) current = response(payload);
      throw lostResponse;
    }, messages: {
      edit: async (id: string, payload: any) => {
        expect(id).toBe(current!.id);
        edits.push(payload);
        return current = response(payload);
      },
    } });
  try {
    if (accepted === 'fallback') await expect(f.adapter.send('thread', delivery, 'nonce')).rejects.toBe(lostResponse);
    const receipt = await f.adapter.send('thread', delivery, 'nonce');
    expect(receipt).toEqual({ id: 'reply', retryAttachments: true, approvalReview: { token: 'prompt', state: 'unavailable' } });
    expect(await f.adapter.edit('thread', 'reply', delivery)).toEqual({ approvalReview: { token: 'prompt', state: 'ready' } });
    expect(edits).toHaveLength(1);
    expect(edits[0].files[0].name).toBe('approval.txt');
    expect(JSON.stringify(edits[0].components)).toContain('dx:prompt:accept');
  } finally { await f.adapter.close(); f.store.close(); }
});

test.each([true, false])('a revised send with a lost receipt edits the saved ID after restart, with files=%s', async withFile => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-revision-'));
  const path = join(dir, 'store.db');
  const f = recoveryFixture();
  const codex = Object.assign(new EventEmitter(), { connected: false, epoch: 'epoch',
    request: async () => {}, respond: async () => {} }) as CodexPort;
  let store = new Store(path);
  let adapter = new DiscordAdapter(f.config, store);
  let bridge = new Bridge(f.config, codex, store, adapter, () => {});
  const delivery = (text: string): Delivery => ({ content: text, ...(withFile ? { file: { name: 'report.txt', content: text } } : {}) });
  let accepted: { id: string; attachments: Collection<string, any> } | undefined;
  const sends: string[] = [];
  const edits: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => {
      sends.push(payload.nonce);
      expect(payload.enforceNonce).toBe(true);
      if (accepted) return accepted;
      accepted = { id: 'reply', attachments: new Collection(payload.files.map((file: any) => ['old', { id: 'old', name: file.name }])) };
      // Simulate loss after acceptance, before any message ID was persisted.
      throw new Error('Response lost');
    }, messages: {
      edit: async (id: string, payload: any) => {
        expect(id).toBe('reply');
        edits.push(payload);
        return { id, attachments: new Collection(payload.files.map((file: any) => ['new', { id: 'new', name: file.name }])) };
      },
    } });
  try {
    adapter.client.channels.fetch = f.fetchChannel as any;
    store.enqueue('reply', 'thread', delivery('Old content'));
    await bridge.flush();
    expect(store.messageId('reply')).toBeNull();
    store.revise('reply', delivery('Updated content'));
    await bridge.flush();
    expect(sends).toHaveLength(2);
    expect(sends[0]).toBe(sends[1]);
    expect(store.outgoing()[0]).toMatchObject({ message: 'reply', revision: 2 });
    await bridge.stop(); await adapter.close(); store.close();
    store = new Store(path);
    adapter = new DiscordAdapter(f.config, store);
    adapter.client.channels.fetch = f.fetchChannel as any;
    bridge = new Bridge(f.config, codex, store, adapter, () => {});
    await bridge.flush();
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0].components)).toContain('Updated content');
    expect(edits[0].attachments).toEqual([]);
    expect(edits[0].files).toHaveLength(withFile ? 1 : 0);
    if (withFile) expect(Buffer.from(edits[0].files[0].attachment).toString()).toBe('Updated content');
    expect(sends).toHaveLength(2);
    expect(store.outgoing()).toHaveLength(0);
  } finally {
    await bridge.stop(); await adapter.close(); store.close();
    await f.adapter.close(); f.store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('approval stays unavailable while the edit receipt lacks the required file', async () => {
  const f = recoveryFixture();
  const delivery = approvalDelivery({ token: 'prompt', epoch: 'one', rpcId: '1', threadId: 't', channel: 'thread', state: 'pending',
    packet: JSON.stringify({ id: 1, method: 'item/fileChange/requestApproval', params: { discordexDiff: '+change\n'.repeat(700) } }) });
  let attachments = new Collection<string, any>();
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    messages: { edit: async () => ({ id: 'reply', attachments }) } });
  try {
    expect(await f.adapter.edit('thread', 'reply', delivery)).toEqual({
      approvalReview: { token: 'prompt', state: 'unavailable' }, retryAttachments: true });
    attachments.set('123', { id: '123', name: 'approval.txt' });
    expect(await f.adapter.edit('thread', 'reply', delivery)).toEqual({ approvalReview: { token: 'prompt', state: 'ready' } });
  } finally { await f.adapter.close(); f.store.close(); }
});

test('a card coalesced before its first send completes in one request', async () => {
  const f = recoveryFixture();
  const codex = Object.assign(new EventEmitter(), { connected: false, epoch: 'epoch',
    request: async () => {}, respond: async () => {} }) as CodexPort;
  const bridge = new Bridge(f.config, codex, f.store, f.adapter, () => {});
  const payloads: any[] = [];
  f.channels.set('thread', { isThread: () => true, guildId: 'guild', parentId: 'parent',
    send: async (payload: any) => {
      payloads.push(payload);
      return { id: 'reply', attachments: new Collection() };
    } });
  try {
    f.store.enqueue('reply', 'thread', { content: 'Working' });
    f.store.revise('reply', { content: 'Complete' });
    await bridge.flush();
    expect(f.store.outgoing()).toHaveLength(0);
    expect(f.store.messageId('reply')).toBe('reply');
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads[0].components)).toContain('Complete');
  } finally { await bridge.stop(); await f.adapter.close(); f.store.close(); }
});
