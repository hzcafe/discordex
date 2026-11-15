import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ComponentType, Events, MessageFlags } from 'discord.js';
import { DiscordAdapter } from '../src/discord.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';
import type { Binding, CodexPort, Delivery, ThreadGoal } from '../src/types.js';

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
  const chat = { createThread: async () => 'thread', send: async (_channel: string, delivery: Delivery) => { sent.push(delivery); return 'goal-message'; },
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

test('restart reuses an existing Discord thread when its channel is not cached', async () => {
  const store = new Store(':memory:');
  const config = { guildId: 'guild', channelId: 'parent', allowedUserIds: ['alice'], approverUserIds: ['alice'],
    autoDiscover: false, projectRoots: [], socketPath: '/unused', stateDir: '/unused' } as Config;
  const adapter = new DiscordAdapter(config, store);
  let starts = 0;
  store.setMeta('starter:t1', 'saved-starter');
  (adapter as any).parent = { messages: { fetch: async () => ({
    id: 'saved-starter', hasThread: true, thread: null, startThread: async () => { starts++; },
  }) } };
  try {
    expect(await adapter.createThread({ id: 't1', cwd: '/work', status: { type: 'idle' } })).toBe('saved-starter');
    expect(starts).toBe(0);
  } finally { await adapter.close(); store.close(); }
});
