import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { artifactUploads } from '../src/artifacts.js';
import { MissingMessageError, MissingThreadError } from '../src/chat.js';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';
import type { Binding, ChatPort, CodexPort, Delivery, Packet, Thread, Turn } from '../src/types.js';
import { approvalDelivery, message, turnDelivery } from '../src/render.js';
import type { AccountRateLimits } from '../src/types.js';

const config: Config = { guildId: '1', channelId: 'index', allowedUserIds: ['alice', 'bob'], approverUserIds: ['alice'],
  autoDiscover: false, projectRoots: ['/work'], socketPath: '/codex.sock', stateDir: '/unused' };
const binding: Binding = { threadId: 't1', channelId: 'c1', parentThreadId: null, label: 'Project', cwd: '/work/project',
  since: 0, initialTurnId: null, checkpoint: null };

class FakeCodex extends EventEmitter implements CodexPort {
  connected = true; epoch = 'connection-1';
  calls: { method: string; params: any }[] = [];
  responses: { id: string | number; result: any }[] = [];
  thread: Thread = { id: 't1', cwd: '/work/project', status: { type: 'idle' }, canAcceptDirectInput: true };
  turns: Turn[] = [];
  queue: { id: string; clientUserMessageId: string }[] = [];
  failAdd = false;
  rateLimits: AccountRateLimits = { rateLimits: { limitId: 'codex', primary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: null } } };
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: any;
    if (method === 'thread/read') result = { thread: structuredClone(this.thread) };
    else if (method === 'thread/goal/get') result = { goal: null };
    else if (method === 'account/rateLimits/read') result = this.rateLimits;
    else if (method === 'thread/resume') result = { thread: this.thread };
    else if (method === 'thread/loaded/list') result = { data: [this.thread.id] };
    else if (method === 'thread/turns/list') result = { data: [...this.turns].reverse() };
    else if (method === 'thread/queue/list') result = { data: [...this.queue] };
    else if (method === 'thread/queue/add') {
      const queuedSubmission = { id: `q${this.queue.length}`, clientUserMessageId: params.clientUserMessageId };
      this.queue.push(queuedSubmission);
      if (this.failAdd) throw new Error('reply lost after commit');
      result = { queuedSubmission };
    } else if (method === 'thread/queue/start') {
      this.queue = this.queue.filter(q => q.id !== params.queuedSubmissionId);
      this.thread.status = { type: 'active' }; result = { turn: { id: 'new-turn' } };
    } else result = {};
    return result;
  }
  async respond(id: string | number, result: any): Promise<void> { this.responses.push({ id, result }); }
}
class FakeChat implements ChatPort {
  sent: { channel: string; delivery: Delivery; nonce: string; id: string }[] = [];
  edits: { channel: string; id: string; delivery: Delivery }[] = [];
  fail = false;
  missing = new Set<string>();
  created: { thread: Thread; replacing?: string }[] = [];
  async checkThread(channel: string): Promise<void> { if (this.missing.has(channel)) throw new MissingThreadError(channel); }
  async createThread(thread: Thread, replacing?: string): Promise<string> {
    this.created.push({ thread, replacing }); return `created-${this.created.length}`;
  }
  async send(channel: string, delivery: Delivery, nonce: string): Promise<string> {
    await this.checkThread(channel);
    if (this.fail) throw new Error('Discord disconnected');
    const id = `message-${this.sent.length}`; this.sent.push({ channel, delivery, nonce, id }); return id;
  }
  async edit(channel: string, id: string, delivery: Delivery): Promise<void> {
    await this.checkThread(channel); this.edits.push({ channel, id, delivery });
  }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(store = new Store(':memory:')) {
  store.saveBinding({ ...binding });
  const codex = new FakeCodex(); const chat = new FakeChat();
  const bridge = new Bridge(config, codex, store, chat, () => {});
  cleanup.push(() => store.close()); cleanup.push(() => bridge.stop());
  return { bridge, codex, chat, store };
}
function approval(id: string | number = 9): Packet {
  return { id, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'turn1', itemId: 'command1', command: 'git status', availableDecisions: ['accept', 'decline'] } };
}

test.each(['command', 'diff'])('late %s details repair the same pending prompt and enable it only after delivery', async kind => {
  const { bridge, codex, store } = fixture();
  const packet: Packet = kind === 'command' ? approval() : { id: 7, method: 'item/fileChange/requestApproval',
    params: { threadId: 't1', turnId: 'turn1', itemId: 'patch' } };
  if (kind === 'command') delete packet.params!.command;
  await bridge.serverRequest(structuredClone(packet));
  await Bun.sleep(0); await bridge.flush();
  const prompt = store.pendingApprovals()[0]!;
  expect(prompt.reviewDelivery).toBe('unavailable');
  expect(approvalDelivery(prompt).buttons).toEqual([]);
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('not offered');
  await bridge.notification({ method: 'item/started', params: { threadId: 't1', turnId: 'turn1', item: kind === 'command'
    ? { id: 'command1', type: 'commandExecution', command: 'git status', cwd: '/work/project' }
    : { id: 'patch', type: 'fileChange', changes: [{ path: '/work/file.txt', diff: '+actual diff' }] } } });
  expect(store.approval(prompt.token)!.reviewDelivery).toBe('pending');
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('not been delivered');
  await bridge.flush();
  expect(store.approval(prompt.token)!.reviewDelivery).toBe('ready');
  const repaired = store.approval(prompt.token)!.packet;
  await bridge.serverRequest(structuredClone(packet));
  expect(store.approval(prompt.token)!.packet).toBe(repaired);
  await bridge.decide(prompt.token, 'accept', 'c1', 'alice');
  expect(codex.responses).toHaveLength(1);
  await bridge.serverRequest(structuredClone(packet));
  expect(store.approval(prompt.token)!.state).toBe('submitted');
});

test('same-ID daemon replay can supply missing details without creating a second approval', async () => {
  const { bridge, store } = fixture();
  const packet = approval(); delete packet.params!.command;
  await bridge.serverRequest(packet);
  const token = store.pendingApprovals()[0]!.token;
  await bridge.serverRequest(approval());
  await Bun.sleep(0); await bridge.flush();
  expect(store.pendingApprovals()).toHaveLength(1);
  expect(store.approval(token)!.reviewDelivery).toBe('ready');
  expect(JSON.parse(store.approval(token)!.packet).params.command).toBe('git status');
});

test('terminal completion survives history failure and later hydration repairs final text', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1', status: 'inProgress' } } });
  await bridge.serverRequest(approval());
  const prompt = store.pendingApprovals()[0]!;
  const request = codex.request.bind(codex);
  codex.request = async (method, params) => { if (method === 'thread/turns/list') throw new Error('History unavailable'); return request(method, params); };
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } } });
  expect(store.turnState('t1', 'turn1')!.turn.status).toBe('completed');
  expect(store.approval(prompt.token)!.state).toBe('resolved');
  expect(store.binding('t1')!.checkpoint).toBeNull();
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('no longer active');
  codex.request = request;
  codex.turns = [{ id: 'turn1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Recovered answer.' }] }];
  await bridge.sync();
  expect(store.turnState('t1', 'turn1')!.turn.items![0]!.text).toBe('Recovered answer.');
  expect(store.binding('t1')!.checkpoint).toBe('turn1');
});

test('an uncertain decision is not retried without fresh daemon evidence, and terminal prompts never reopen', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.serverRequest(approval());
  await Bun.sleep(0); await bridge.flush();
  const prompt = store.pendingApprovals()[0]!;
  const respond = codex.respond.bind(codex);
  codex.respond = async () => { throw new Error('Write outcome unknown'); };
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('Write outcome unknown');
  expect(store.approval(prompt.token)!.state).toBe('uncertain');
  codex.respond = respond;
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('no longer active');
  await bridge.sync();
  expect(codex.responses).toHaveLength(0);
  await bridge.serverRequest(approval());
  await Bun.sleep(0); await bridge.flush();
  expect(store.approval(prompt.token)!.state).toBe('pending');
  await bridge.decide(prompt.token, 'decline', 'c1', 'alice');
  expect(codex.responses).toEqual([{ id: 9, result: { decision: 'decline' } }]);
  await bridge.notification({ method: 'serverRequest/resolved', params: { requestId: 9 } });
  await bridge.serverRequest(approval());
  expect(store.approval(prompt.token)!.state).toBe('resolved');
});

test('invalid output is quarantined without blocking approvals and resumes when its content changes', async () => {
  const { bridge, chat, store } = fixture();
  let attempts = 0;
  const send = chat.send.bind(chat);
  chat.send = async (channel, delivery, nonce) => {
    if (delivery.content === 'Invalid output') { attempts++; throw Object.assign(new Error('Invalid form body'), { code: 50035 }); }
    return send(channel, delivery, nonce);
  };
  store.enqueue('bad', 'c1', { content: 'Invalid output' });
  await bridge.serverRequest(approval());
  await Bun.sleep(0); await bridge.flush();
  expect(attempts).toBe(1);
  expect(store.blockedDeliveries('c1').map(r => r.key)).toEqual(['bad']);
  expect(store.pendingApprovals()[0]!.reviewDelivery).toBe('ready');
  expect(chat.sent.some(s => s.delivery.content.includes('rejected the message format'))).toBe(true);
  expect(chat.sent.some(s => s.delivery.content.includes('/codex retry'))).toBe(false);
  await bridge.flush(); expect(attempts).toBe(1);
  chat.send = send;
  store.revise('bad', { content: 'Corrected output' });
  await bridge.flush();
  expect(store.blockedDeliveries()).toHaveLength(0);
  expect(chat.sent.some(s => s.delivery.content === 'Corrected output')).toBe(true);
});

test('oversized reviews explain the limit without retry loops; daemon replay after a config change restores delivery', async () => {
  const { bridge, store, chat, codex } = fixture();
  // The fixture passes the same config object through the bridge. Restore it after this check.
  const previous = config.artifacts;
  config.artifacts = { enabled: true, roots: [], maxFiles: 4, maxFileBytes: 10, maxTotalBytes: 12, cacheBytes: 1000, retentionDays: 7 };
  try {
    const packet = approval(); packet.params!.reason = 'Review context. '.repeat(400);
    await bridge.serverRequest(packet);
    await Bun.sleep(0); await bridge.flush();
    const prompt = store.pendingApprovals()[0]!;
    expect(prompt.reviewDelivery).toBe('unavailable');
    expect(chat.sent.find(s => s.delivery.approvalReview)?.delivery.buttons).toBeUndefined();
    await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('not been delivered');
    const delivered = chat.sent.length;
    await bridge.flush(); await bridge.flush();
    expect(chat.sent).toHaveLength(delivered);
    expect(chat.sent.find(s => s.delivery.approvalReview)?.delivery.artifactNotes?.join()).toContain('exceed the attachment size limit');
    config.artifacts = previous;
    codex.epoch = 'connection-2';
    await bridge.serverRequest(packet);
    await Bun.sleep(0); await bridge.flush();
    const replay = store.pendingApprovals().find(a => a.epoch === codex.epoch)!;
    expect(replay.reviewDelivery).toBe('ready');
    await bridge.decide(replay.token, 'accept', 'c1', 'alice');
  } finally { config.artifacts = previous; }
});

test('a transient failure while retrying attachments does not hold up later messages', async () => {
  const { bridge, chat, store } = fixture();
  store.enqueue('reply', 'c1', { content: 'Reply with files', file: { name: 'response.md', content: 'Full answer' } });
  store.delivered(store.outgoing()[0]!, 'existing-message', undefined, true);
  store.db.query('UPDATE outbox SET nextAttempt = 0').run();
  store.enqueue('later', 'c1', { content: 'Later message' });
  chat.edit = async () => { throw Object.assign(new Error('Temporary network failure'), { code: 'ECONNRESET' }); };
  await bridge.flush();
  expect(chat.sent.map(s => s.delivery.content)).toEqual(['Later message']);
  expect(store.messageId('reply')).toBe('existing-message');
  expect(store.db.query<{ partial: number; pending: number }, []>("SELECT partial, pending FROM outbox WHERE key = 'reply'").get()).toEqual({ partial: 1, pending: 1 });
});

test('slow scheduled syncs coalesce so new user work does not wait behind duplicate polls', async () => {
  const { bridge, codex } = fixture();
  let release!: () => void;
  let calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  bridge.sync = async () => { calls++; await held; };
  bridge.start();
  try {
    await Bun.sleep(0);
    for (let i = 0; i < 20; i++) codex.emit('ready');
    const submitted = bridge.serial(async () => calls);
    release();
    expect(await submitted).toBe(1);
    codex.emit('ready');
    await bridge.serial(async () => {});
    expect(calls).toBe(2);
  } finally { release(); }
});

test('deleted threads move all agents, queued output and live controls without replaying delivered history or changing Codex', async () => {
  const { bridge, codex, chat, store } = fixture();
  store.saveBinding({ ...binding, checkpoint: 'completed' });
  const child = { ...binding, threadId: 'child', parentThreadId: 't1', label: 'Reviewer' };
  store.saveBinding(child);
  store.addInput('input', 't1', 'queued instruction');
  store.inputState('input', 'queued', 'queue-id');
  store.setMeta('inbox-cursor:c1', 'old-cursor');
  store.enqueue('attached:t1', 'c1', { content: 'Connected' });
  const done = { turn: { id: 'completed', status: 'completed' as const }, completedItemIds: [], lastItemId: null };
  store.publishTurn(binding, done, { content: 'Old delivered history' });
  const active = { turn: { id: 'active', status: 'inProgress' as const }, completedItemIds: [], lastItemId: null };
  store.publishTurn(child, active, { content: 'Reviewer working' });
  store.publishGoal(binding, { goal: null, version: 'goal-version', epoch: codex.epoch }, { content: 'Current goal controls' });
  const prompt = store.addApproval(codex.epoch, approval(), 'c1');
  store.enqueue(`approval:${prompt.token}`, 'c1', approvalDelivery(prompt, binding));
  for (const row of store.outgoing()) store.delivered(row, `old:${row.key}`);
  store.enqueue('pending-reply', 'c1', { content: 'Undelivered reply' });
  const stale = store.outgoing()[0]!;
  chat.missing.add('c1');
  await Promise.all([bridge.serial(() => bridge.recoverChannel('c1')), bridge.serial(() => bridge.recoverChannel('c1'))]);
  expect(chat.created).toHaveLength(1);
  expect(chat.created[0]!.replacing).toBe('c1');
  expect(store.byChannel('c1')).toBeUndefined();
  expect(store.binding('t1')!.channelId).toBe('created-1');
  expect(store.binding('child')!.channelId).toBe('created-1');
  expect(store.binding('t1')!.checkpoint).toBe('completed');
  expect(store.inputs()[0]).toMatchObject({ state: 'queued', queueId: 'queue-id' });
  expect(store.getMeta('inbox-cursor:c1')).toBeNull();
  expect(store.approval(prompt.token)).toMatchObject({ channel: 'created-1', state: 'pending' });
  expect(codex.calls).toHaveLength(0);
  expect(codex.responses).toHaveLength(0);
  store.delivered(stale, 'late-old-message'); store.retry(stale);
  expect(store.messageId('pending-reply')).toBeNull();
  await bridge.flush();
  expect(chat.sent.map(s => s.channel)).toEqual(Array(5).fill('created-1'));
  expect(chat.sent.some(s => s.delivery.content === 'Old delivered history')).toBe(false);
  expect(chat.sent.some(s => s.delivery.content === 'Reviewer working')).toBe(true);
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'alice')).rejects.toThrow('no longer active');
  await bridge.decide(prompt.token, 'accept', 'created-1', 'alice');
  expect(codex.responses).toEqual([{ id: 9, result: { decision: 'accept' } }]);
});

test('attach repairs a deleted thread again after replacement; access failures and excluded projects never recreate it', async () => {
  const { bridge, chat, store } = fixture();
  chat.missing.add('c1');
  expect((await bridge.attach('t1')).channelId).toBe('created-1');
  chat.missing.add('created-1');
  expect((await bridge.attach('t1')).channelId).toBe('created-2');
  expect(chat.created.map(c => c.replacing)).toEqual(['c1', 'created-1']);
  chat.checkThread = async () => { throw new Error('Missing Access'); };
  await expect(bridge.attach('t1')).rejects.toThrow('Missing Access');
  expect(chat.created).toHaveLength(2);
  store.saveBinding({ ...store.binding('t1')!, cwd: '/private' });
  await bridge.recoverChannel('created-2');
  expect(chat.created).toHaveLength(2);
});

test('delivery-triggered recovery cannot deadlock a serial flush and keeps retrying a failed creation', async () => {
  const { bridge, chat, store } = fixture();
  store.enqueue('reply', 'c1', { content: 'Pending reply' });
  chat.missing.add('c1');
  const create = chat.createThread.bind(chat);
  chat.createThread = async () => { throw new Error('Discord unavailable'); };
  await bridge.serial(() => bridge.flush());
  await bridge.serial(async () => {});
  expect(store.binding('t1')!.channelId).toBe('c1');
  expect(store.messageId('reply')).toBeNull();
  chat.createThread = create;
  store.db.query('UPDATE outbox SET nextAttempt = 0').run();
  await bridge.serial(() => bridge.flush());
  await bridge.serial(async () => {});
  await bridge.flush();
  expect(store.binding('t1')!.channelId).toBe('created-1');
  expect(chat.sent[0]!.delivery.content).toBe('Pending reply');
});

test('a send finishing during thread replacement cannot acknowledge the new delivery or use the stale batch', async () => {
  const { bridge, chat, store } = fixture();
  store.enqueue('first', 'c1', { content: 'First' }); store.enqueue('second', 'c1', { content: 'Second' });
  let release!: (id: string) => void;
  const destinations: string[] = [];
  const send = chat.send.bind(chat);
  chat.send = async channel => { destinations.push(channel); return new Promise(resolve => { release = resolve; }); };
  const flushing = bridge.flush(); await Bun.sleep(0);
  chat.missing.add('c1');
  await bridge.serial(() => bridge.recoverChannel('c1'));
  release('old-message'); await flushing;
  expect(destinations).toEqual(['c1']);
  expect(store.outgoing()).toHaveLength(2);
  expect(store.messageId('first')).toBeNull();
  chat.send = send; await bridge.flush();
  expect(chat.sent.map(s => s.channel)).toEqual(['created-1', 'created-1']);
});

test('deleted cards are resent with a new durable nonce, preserving the latest content across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-deleted-card-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const { bridge, chat, store } = fixture(new Store(path));
  store.enqueue('card', 'c1', { content: 'Original' }); await bridge.flush();
  const original = chat.sent[0]!;
  store.revise('card', { content: 'Latest' });
  chat.edit = async (channel, id) => { throw new MissingMessageError(channel, id); };
  await bridge.flush();
  expect(store.messageId('card')).toBeNull();
  const reopened = new Store(path);
  try {
    const retry = reopened.outgoing()[0]!;
    expect(retry.generation).toBe(1);
    expect(JSON.parse(retry.payload).content).toBe('Latest');
  } finally { reopened.close(); }
  await bridge.flush();
  expect(chat.sent[1]!.delivery.content).toBe('Latest');
  expect(chat.sent[1]!.nonce).not.toBe(original.nonce);
  expect(chat.created).toHaveLength(0);
});

test('a final referenced file is snapshotted before delivery and survives retry plus deleted-thread recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-file-delivery-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.sqlite')); const codex = new FakeCodex(); const chat = new FakeChat();
  const bridge = new Bridge({ ...config, projectRoots: [dir] }, codex, store, chat, () => {});
  cleanup.push(() => store.close()); cleanup.push(() => bridge.stop());
  store.saveBinding({ ...binding, cwd: dir }); codex.thread.cwd = dir;
  await Bun.write(join(dir, 'plan.md'), '# Original plan');
  await bridge.notification({ method: 'item/completed', params: { threadId: 't1', turnId: 'turn1', item: {
    id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'See [the plan](plan.md).',
  } } });
  await bridge.flush(); expect(chat.sent[0]!.delivery.artifactRequest).toBeUndefined();
  chat.edit = async () => { throw new Error('Disconnected'); };
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed' } } });
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  await Bun.write(join(dir, 'plan.md'), '# A later change');
  chat.missing.add('c1'); await bridge.serial(() => bridge.recoverChannel('c1')); await bridge.flush();
  const final = chat.sent.at(-1)!;
  expect(final.channel).toBe('created-1');
  expect(final.delivery.artifacts).toHaveLength(1);
  expect(artifactUploads(store, final.delivery).files[0]!.data.toString()).toBe('# Original plan');
  expect(codex.calls.some(c => ['turn/start', 'turn/interrupt', 'thread/goal/set', 'thread/queue/add'].includes(c.method))).toBe(false);
});

test('usage reads fresh account limits and remembers separate parent/subagent counters without posting messages', async () => {
  const { bridge, codex, store, chat } = fixture();
  store.saveBinding({ ...binding, threadId: 'child', parentThreadId: 't1' });
  const update = (threadId: string, totalTokens: number) => bridge.notification({ method: 'thread/tokenUsage/updated', params: {
    threadId, turnId: 'turn1', tokenUsage: { total: { totalTokens, inputTokens: totalTokens - 10, outputTokens: 10 } },
  } });
  await update('t1', 1000); await update('child', 2000); await update('untracked', 3000);
  const first = await bridge.usage('c1', 'alice');
  expect(first.content).toContain('65% left');
  expect(first.content).toContain('Session tokens · 1,000 used');
  expect(first.content).not.toContain('2,000');
  expect(store.tokenUsage('untracked')).toBeNull();
  expect(store.tokenUsage('child')?.total.totalTokens).toBe(2000);
  codex.rateLimits.rateLimits!.primary!.usedPercent = 40;
  const second = await bridge.usage('index', 'bob');
  expect(second.content).toContain('60% left');
  expect(second.content).not.toContain('Session tokens');
  expect(codex.calls.filter(c => c.method === 'account/rateLimits/read')).toHaveLength(2);
  expect(codex.calls.every(c => c.method === 'account/rateLimits/read')).toBe(true);
  await bridge.flush(); expect(chat.sent).toHaveLength(0);
});

test('usage preserves last reported session counters across restart and handles unavailable account limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-usage-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  first.saveTokenUsage('t1', { total: { totalTokens: 1000, inputTokens: 900, outputTokens: 100 }, reportedAt: 100 });
  first.close();
  const { bridge, codex } = fixture(new Store(path));
  codex.connected = false;
  const offline = await bridge.usage('c1', 'alice');
  expect(offline.content).toContain('reconnecting');
  expect(offline.content).toContain('1,000 used');
  expect(offline.content).toContain('Last reported <t:100:R>');
  expect(offline.content).not.toContain('% left');
  expect(codex.calls).toHaveLength(0);
  codex.connected = true;
  codex.request = async () => { throw new RpcError(-32601, 'Method not found'); };
  const unsupported = await bridge.usage('c1', 'alice');
  expect(unsupported.content).toContain('not available from this Codex daemon');
  expect(unsupported.content).toContain('1,000 used');
  expect(unsupported.card?.tone).toBe('warning');
});

test('usage rejects unauthorized users, unknown channels, and excluded projects before querying the account', async () => {
  const { bridge, codex, store } = fixture();
  await expect(bridge.usage('c1', 'outsider')).rejects.toThrow('not configured');
  await expect(bridge.usage('other', 'alice')).rejects.toThrow('configured Codex channel');
  store.saveBinding({ ...binding, cwd: '/private' });
  await expect(bridge.usage('c1', 'alice')).rejects.toThrow('outside');
  await bridge.notification({ method: 'thread/tokenUsage/updated', params: { threadId: 't1', tokenUsage: {
    total: { totalTokens: 100, inputTokens: 90, outputTokens: 10 },
  } } });
  expect(store.tokenUsage('t1')).toBeNull();
  expect(codex.calls).toHaveLength(0);
});

test('reconnect recovers one final card and ignores replayed completed items', async () => {
  const { bridge, codex, chat, store } = fixture();
  codex.thread.model = 'new-session-model'; // Must not be attributed to older history.
  codex.turns = [{ id: 'turn1', status: 'completed', completedAt: 10, items: [
    { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Working' },
    { id: 'private', type: 'reasoning', text: 'internal reasoning' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Fixed the bug.' },
  ] }];
  await bridge.sync(); await bridge.flush();
  await bridge.sync(); await bridge.flush();
  await bridge.notification({ method: 'item/completed', params: { threadId: 't1', turnId: 'turn1', item: codex.turns[0]!.items![2] } });
  await bridge.flush();
  expect(chat.sent).toHaveLength(1);
  expect(chat.sent[0]!.delivery.content).toContain('Fixed the bug.');
  expect(chat.sent[0]!.delivery.card?.footer).toBe('Codex · Complete');
  expect(chat.edits).toHaveLength(0);
  expect(store.binding('t1')!.checkpoint).toBe('turn1');
});

test('history before first attachment is not exported, but an already-active turn is', async () => {
  const { bridge, codex, chat, store } = fixture();
  store.saveBinding({ ...binding, since: 100, initialTurnId: 'active' });
  codex.turns = [
    { id: 'old', status: 'completed', completedAt: 50, items: [{ id: 'a', type: 'agentMessage', text: 'old' }] },
    { id: 'active', status: 'completed', completedAt: 90, items: [{ id: 'b', type: 'agentMessage', text: 'current' }] },
  ];
  await bridge.sync(); await bridge.flush();
  expect(chat.sent).toHaveLength(1);
  expect(chat.sent[0]!.delivery.content).toContain('current');
});

test('concurrent friends are queued in order with attribution and duplicate Discord IDs are ignored', async () => {
  const { bridge, codex } = fixture();
  await Promise.all([
    bridge.serial(() => bridge.submit('c1', 'm1', 'alice', 'Alice', 'Fix the bug')),
    bridge.serial(() => bridge.submit('c1', 'm2', 'bob', 'Bob', 'Add coverage')),
    bridge.serial(() => bridge.submit('c1', 'm1', 'alice', 'Alice', 'Fix the bug')),
  ]);
  const adds = codex.calls.filter(c => c.method === 'thread/queue/add');
  expect(adds.map(c => c.params.clientUserMessageId)).toEqual(['m1', 'm2']);
  expect(adds[1]!.params.input[0].text).toContain('Bob; user ID: bob');
  expect(codex.calls.filter(c => c.method === 'thread/queue/start')).toHaveLength(1);
  expect(codex.calls.some(c => c.method === 'turn/steer')).toBe(false);
});

test('uncertain submission is reconciled by client ID instead of duplicated', async () => {
  const { bridge, codex, store } = fixture();
  codex.thread.status = { type: 'active' }; codex.failAdd = true;
  expect(await bridge.submit('c1', 'm1', 'alice', 'Alice', 'Hello')).toContain('uncertain');
  codex.failAdd = false;
  await bridge.sync();
  expect(store.inputs()[0]!.state).toBe('queued');
  expect(codex.calls.filter(c => c.method === 'thread/queue/add')).toHaveLength(1);
});

test('uncertain input already consumed by Codex is recovered from history', async () => {
  const { bridge, codex, store } = fixture();
  store.addInput('m1', 't1', 'hello'); store.inputState('m1', 'unknown');
  codex.thread.status = { type: 'active' };
  codex.turns = [{ id: 'turn1', status: 'inProgress', items: [{ type: 'userMessage', id: 'u1', clientId: 'm1' }] }];
  await bridge.sync();
  expect(store.inputs()[0]!.state).toBe('delivered');
  expect(codex.calls.some(c => c.method === 'thread/queue/add')).toBe(false);
});

test('an accepted message leaving the queue before history arrives is not a delivery failure', async () => {
  const { bridge, codex, store, chat } = fixture();
  codex.thread.status = { type: 'active' };
  await bridge.submit('c1', 'm1', 'alice', 'Alice', 'Hello');
  codex.queue = []; // Another client consumed it; the user item has not been persisted yet.
  await bridge.sync(); await bridge.flush();
  expect(store.inputs()[0]!.state).toBe('queued');
  expect(chat.sent).toHaveLength(0);
  expect(codex.calls.filter(c => c.method === 'thread/queue/add')).toHaveLength(1);
  expect(codex.calls.some(c => c.method === 'thread/queue/start')).toBe(false);
  await bridge.notification({ method: 'item/started', params: { threadId: 't1', turnId: 'turn1', item: { id: 'u1', type: 'userMessage', clientId: 'm1' } } });
  expect(store.inputs()[0]!.state).toBe('delivered');
});

test('automatic consumption on queue/add does not trigger a second start', async () => {
  const { bridge, codex, store } = fixture();
  const request = codex.request.bind(codex);
  codex.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/queue/add') { codex.queue = []; codex.thread.status = { type: 'active' }; }
    return result;
  };
  await bridge.submit('c1', 'm1', 'alice', 'Alice', 'Hello');
  expect(codex.calls.filter(c => c.method === 'thread/queue/start')).toHaveLength(0);
  expect(store.inputs()[0]!.state).toBe('queued');
});

test('another client winning the final queue/start race is reconciled without an error', async () => {
  const { codex, store, chat } = fixture();
  const logs: string[] = [];
  const bridge = new Bridge(config, codex, store, chat, text => logs.push(text));
  cleanup.push(() => bridge.stop());
  const request = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method === 'thread/queue/start') {
      codex.queue = []; codex.thread.status = { type: 'active' };
      codex.turns = [{ id: 'turn1', status: 'inProgress', items: [{ id: 'u1', type: 'userMessage', clientId: 'm1' }] }];
      throw new RpcError(-32600, 'queued submission not found: q0');
    }
    return request(method, params);
  };
  await bridge.submit('c1', 'm1', 'alice', 'Alice', 'Hello');
  expect(logs).toEqual([]);
  expect(store.inputs()[0]!.state).toBe('delivered');
});

test('a genuinely uncertain submission warning is corrected when delivery is later confirmed', async () => {
  const { bridge, codex, store, chat } = fixture();
  store.addInput('m1', 't1', 'hello'); store.inputState('m1', 'unknown');
  codex.thread.status = { type: 'active' };
  await bridge.sync(); await bridge.flush();
  expect(chat.sent[0]!.delivery.content).toContain('Could not confirm');
  codex.turns = [{ id: 'turn1', status: 'inProgress', items: [{ id: 'u1', type: 'userMessage', clientId: 'm1' }] }];
  await bridge.sync(); await bridge.flush();
  expect(chat.edits.at(-1)!.delivery.content).toContain('Delivery confirmed');
  expect(store.inputs()[0]!.state).toBe('delivered');
  await bridge.sync(); await bridge.flush();
  expect(chat.edits).toHaveLength(1);
});

test('unauthorized users and projects cannot submit or approve', async () => {
  const { bridge, codex, store } = fixture();
  await expect(bridge.submit('c1', 'm1', 'outsider', 'Eve', 'run it')).rejects.toThrow('not configured');
  await bridge.serverRequest(approval());
  const a = store.pendingApprovals()[0]!;
  await expect(bridge.decide(a.token, 'accept', 'c1', 'bob')).rejects.toThrow('approver');
  store.saveBinding({ ...binding, cwd: '/work-other/private' });
  await expect(bridge.submit('c1', 'm2', 'alice', 'Alice', 'run it')).rejects.toThrow('outside');
  expect(codex.responses).toHaveLength(0);
});

test('one approval decision is sent, only offered decisions are accepted, and local resolution disables buttons', async () => {
  const { bridge, codex, store, chat } = fixture();
  await bridge.serverRequest(approval()); await bridge.flush();
  const a = store.pendingApprovals()[0]!;
  await expect(bridge.decide(a.token, 'acceptForSession', 'c1', 'alice')).rejects.toThrow('not offered');
  await bridge.decide(a.token, 'accept', 'c1', 'alice');
  await expect(bridge.decide(a.token, 'accept', 'c1', 'alice')).rejects.toThrow('no longer active');
  expect(codex.responses).toEqual([{ id: 9, result: { decision: 'accept' } }]);
  await bridge.notification({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 9 } });
  await bridge.flush();
  expect(chat.edits.find(e => e.delivery.buttons)?.delivery.buttons).toEqual([]);
  expect(store.approval(a.token)!.state).toBe('resolved');
});

test('authorized approvers can decide requests containing machine paths from Discord', async () => {
  const { bridge, codex, store } = fixture();
  const packet = approval(); packet.params!.command = 'rm /home/alice/private/report.md';
  await bridge.serverRequest(packet);
  const prompt = store.pendingApprovals()[0]!;
  await expect(bridge.decide(prompt.token, 'accept', 'c1', 'bob')).rejects.toThrow('approver');
  await bridge.decide(prompt.token, 'accept', 'c1', 'alice');
  expect(store.approval(prompt.token)!.state).toBe('submitted');
  expect(codex.responses).toEqual([{ id: 9, result: { decision: 'accept' } }]);
});

test('reconnect invalidates old prompts even when a new connection reuses the same RPC ID', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.serverRequest(approval('9'));
  const old = store.pendingApprovals()[0]!;
  codex.epoch = 'connection-2';
  await expect(bridge.decide(old.token, 'accept', 'c1', 'alice')).rejects.toThrow('no longer active');
  await bridge.serverRequest(approval('9'));
  const fresh = store.pendingApprovals().find(a => a.epoch === 'connection-2')!;
  expect(fresh.token).not.toBe(old.token);
  await Bun.sleep(0); await bridge.flush();
  await bridge.decide(fresh.token, 'decline', 'c1', 'alice');
  expect(codex.responses).toEqual([{ id: '9', result: { decision: 'decline' } }]);
});

test('permission approval grants exactly the requested scope for one turn', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.serverRequest({ id: 7, method: 'item/permissions/requestApproval', params: {
    threadId: 't1', turnId: 'turn1', permissions: { network: { enabled: true }, fileSystem: null },
  } });
  await Bun.sleep(0); await bridge.flush();
  await bridge.decide(store.pendingApprovals()[0]!.token, 'accept', 'c1', 'alice');
  expect(codex.responses[0]!.result).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('multi-question responses keep question IDs, and secret questions stay local', async () => {
  const { bridge, codex, store } = fixture();
  const packet = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 't1', turnId: 'turn1', questions: [
    { id: 'a', question: 'Which?', header: 'Choice' }, { id: 'b', question: 'Why?', header: 'Reason' },
  ] } };
  await bridge.serverRequest(packet);
  await Bun.sleep(0); await bridge.flush();
  await bridge.decide(store.pendingApprovals()[0]!.token, 'answer', 'c1', 'alice', { a: 'First', b: 'Simpler' });
  expect(codex.responses[0]!.result).toEqual({ answers: { a: { answers: ['First'] }, b: { answers: ['Simpler'] } } });
  await bridge.serverRequest({ ...packet, id: 8, params: { ...packet.params, questions: [{ id: 's', question: 'Secret', isSecret: true }] } });
  const secret = store.pendingApprovals().find(a => a.rpcId === '8')!;
  expect(approvalDelivery(secret).buttons).toEqual([]);
  await expect(bridge.decide(secret.token, 'answer', 'c1', 'alice', { s: 'secret' })).rejects.toThrow('not offered');
  expect(codex.responses).toHaveLength(1);
});

test('file approvals require the actual proposed diff', async () => {
  const { bridge, codex, store } = fixture();
  const packet = { id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'turn1', itemId: 'patch' } };
  await bridge.serverRequest(packet);
  expect(approvalDelivery(store.pendingApprovals()[0]!).buttons).toEqual([]);
  await expect(bridge.decide(store.pendingApprovals()[0]!.token, 'accept', 'c1', 'alice')).rejects.toThrow('not offered');
  expect(codex.responses).toHaveLength(0);
  store.saveItem('t1', { id: 'patch', type: 'fileChange', changes: [{ path: '/work/a', diff: '+hello' }] });
  await bridge.serverRequest({ ...packet, id: 8 });
  const a = store.pendingApprovals().find(a => a.rpcId === '8')!;
  expect(approvalDelivery(a).content).toContain('+hello');
  expect(approvalDelivery(a).buttons).toHaveLength(3);
});

test('command approval controls and authorization honor restricted and structured daemon choices', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.serverRequest({ ...approval(10), params: { ...approval().params, availableDecisions: ['decline', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } }] } });
  const restricted = store.pendingApprovals()[0]!;
  expect(approvalDelivery(restricted).buttons?.map(b => b.label)).toEqual(['Decline']);
  await expect(bridge.decide(restricted.token, 'accept', 'c1', 'alice')).rejects.toThrow('not offered');
  await expect(bridge.decide(restricted.token, 'cancel', 'c1', 'alice')).rejects.toThrow('not offered');
  await bridge.decide(restricted.token, 'decline', 'c1', 'alice');
  expect(codex.responses).toEqual([{ id: 10, result: { decision: 'decline' } }]);
});

test('persisted outbox survives restart and a failed send does not reorder a channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path); first.saveBinding({ ...binding });
  first.enqueue('one', 'c1', message('First')); first.enqueue('two', 'c1', message('Second')); first.close();
  const { bridge, chat, store } = fixture(new Store(path));
  chat.fail = true; await bridge.flush();
  chat.fail = false; await bridge.flush();
  expect(chat.sent).toHaveLength(0); // Earlier failed delivery is still backing off.
  store.db.query('UPDATE outbox SET nextAttempt = 0').run();
  await bridge.flush();
  expect(chat.sent.map(s => s.delivery.content)).toEqual(['First', 'Second']);
  await bridge.flush(); expect(chat.sent).toHaveLength(2);
});

test('approval resolution while Discord is sending schedules an edit', async () => {
  const { bridge, chat, store } = fixture();
  let release!: () => void;
  const original = chat.send.bind(chat);
  let first = true;
  chat.send = async (...args) => { if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } return original(...args); };
  await bridge.serverRequest(approval());
  await Bun.sleep(0);
  await bridge.notification({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 9 } });
  release(); await Bun.sleep(0); await bridge.flush();
  expect(chat.edits.find(e => e.delivery.buttons)?.delivery.buttons).toEqual([]);
  expect(store.pendingApprovals()).toHaveLength(0);
});

test('long output is preserved as an attachment and moderated/reasoning output is omitted', () => {
  const text = 'A'.repeat(20_000);
  const rendered = message(text);
  expect(rendered.content.length).toBeLessThanOrEqual(2000);
  expect(rendered.file!.content).toBe(text);
  const delivery = turnDelivery(binding, { turn: { id: 't', status: 'completed', items: [
    { id: 'x', type: 'agentMessage', text: 'blocked', moderation: { moderated: true } },
    { id: 'y', type: 'reasoning', text: 'hidden' },
  ] }, completedItemIds: ['x', 'y'], lastItemId: 'y' });
  expect(delivery.content).not.toContain('blocked');
  expect(delivery.content).not.toContain('hidden');
});

test('one turn card changes from working to command and commentary to the final answer', async () => {
  const { bridge, chat, store } = fixture();
  const event = async (method: string, item: any) => bridge.notification({ method, params: { threadId: 't1', turnId: 'live', item } });
  const tick = async () => { store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush(); };
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'live', status: 'inProgress' } } });
  await bridge.flush();
  expect(chat.sent).toHaveLength(1);
  expect(chat.sent[0]!.delivery.content).toBe('Working…');
  await event('item/started', { id: 'cmd', type: 'commandExecution', command: 'bun test', status: 'inProgress' });
  await bridge.flush();
  expect(chat.edits).toHaveLength(0); // Successful sends impose a one-second cooldown.
  await tick();
  expect(chat.edits.at(-1)!.delivery.content).toBe('Running `bun test`');
  await event('item/completed', { id: 'cmd', type: 'commandExecution', command: 'bun test', status: 'completed' });
  await event('item/completed', { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Tests passed; checking the result.' });
  await tick();
  expect(chat.edits.at(-1)!.delivery.content).toBe('Tests passed; checking the result.');
  await event('item/completed', { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Fixed and tested.' });
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'live', status: 'completed', items: [] } } });
  await event('item/started', { id: 'late', type: 'commandExecution', command: 'stale command' });
  await tick();
  expect(chat.sent).toHaveLength(1);
  expect(new Set(chat.edits.map(e => e.id))).toEqual(new Set([chat.sent[0]!.id]));
  expect(chat.edits.at(-1)!.delivery.content).toBe('Fixed and tested.');
  expect(chat.edits.at(-1)!.delivery.card?.footer).toBe('Codex · Complete');
});

test('a restart recovers active progress then edits the original message with all final answer parts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-turn-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path); first.saveBinding({ ...binding });
  const oldCodex = new FakeCodex();
  oldCodex.thread.model = 'original-model'; oldCodex.thread.reasoningEffort = 'high';
  const oldBridge = new Bridge(config, oldCodex, first, new FakeChat(), () => {});
  await oldBridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'live', status: 'inProgress' } } });
  await oldBridge.flush(); await oldBridge.stop(); first.close();
  const { bridge, codex, chat, store } = fixture(new Store(path));
  codex.thread.model = 'future-model'; codex.thread.reasoningEffort = 'low';
  codex.turns = [{ id: 'live', status: 'inProgress', items: [{ id: 'cmd', type: 'commandExecution', command: 'bun test', status: 'inProgress' }] }];
  await bridge.sync(); store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.sent).toHaveLength(0);
  expect(chat.edits.at(-1)!.id).toBe('message-0');
  expect(chat.edits.at(-1)!.delivery.content).toBe('Running `bun test`');
  expect(chat.edits.at(-1)!.delivery.card?.footer).toBe('Codex · original-model · high · Working');
  codex.turns = [{ id: 'live', status: 'completed', completedAt: 20, items: [
    { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Checking…' },
    { id: 'part', type: 'agentMessage', phase: 'partial_answer', text: 'First result.' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Second result.' },
  ] }];
  await bridge.sync(); store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.sent).toHaveLength(0);
  expect(chat.edits.at(-1)!.delivery.content).toBe('First result.\n\nSecond result.');
  expect(chat.edits.at(-1)!.delivery.card?.footer).toBe('Codex · original-model · high · Complete');
});

test('model settings are captured per turn and reported reroutes override that turn only', async () => {
  const { bridge, codex, store } = fixture();
  const footer = (id: string) => JSON.parse(store.db.query<{ payload: string }, [string]>('SELECT payload FROM outbox WHERE key = ?').get(`turn:t1:${id}`)!.payload).card.footer;
  codex.thread.model = 'model-a'; codex.thread.reasoningEffort = 'high';
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'first', status: 'inProgress' } } });
  expect(footer('first')).toBe('Codex · model-a · high · Working');
  codex.thread.model = 'model-b'; codex.thread.reasoningEffort = 'low';
  await bridge.notification({ method: 'thread/settings/updated', params: { threadId: 't1', threadSettings: { model: 'model-b', effort: 'low' } } });
  await bridge.notification({ method: 'item/started', params: { threadId: 't1', turnId: 'first', item: { id: 'c', type: 'commandExecution', command: 'bun test' } } });
  expect(footer('first')).toBe('Codex · model-a · high · Working');
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'second', status: 'inProgress' } } });
  expect(footer('second')).toBe('Codex · model-b · low · Working');
  await bridge.notification({ method: 'model/rerouted', params: { threadId: 't1', turnId: 'first', fromModel: 'model-a', toModel: 'model-c' } });
  expect(footer('first')).toBe('Codex · model-c · Working');
  expect(footer('second')).toBe('Codex · model-b · low · Working');
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'first', status: 'completed' } } });
  expect(footer('first')).toBe('Codex · model-c · Complete');
  expect(store.turnState('t1', 'first')!.model).toEqual({ name: 'model-c', source: 'rerouted', effort: null });
});

test('unfinished and moderated text never leaks from active snapshots or empty completion notifications', async () => {
  const { bridge, codex, chat, store } = fixture();
  codex.turns = [{ id: 'live', status: 'inProgress', items: [
    { id: 'raw', type: 'reasoning', text: 'private reasoning' },
    { id: 'answer', type: 'agentMessage', text: 'unfinished text' },
  ] }];
  await bridge.sync(); await bridge.flush();
  expect(chat.sent[0]!.delivery.content).toBe('Working…');
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'live', status: 'completed' } } });
  await bridge.notification({ method: 'item/completed', params: { threadId: 't1', turnId: 'live', item: {
    id: 'answer', type: 'agentMessage', text: 'blocked text', moderation: { moderated: true },
  } } });
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.edits.at(-1)!.delivery.content).toBe('Turn complete.');
  // A late authoritative answer repairs an empty final card without reopening it.
  await bridge.notification({ method: 'item/completed', params: { threadId: 't1', turnId: 'live', item: {
    id: 'late', type: 'agentMessage', text: 'Final safe answer.', phase: null,
  } } });
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.edits.at(-1)!.delivery.content).toBe('Final safe answer.');
  expect(chat.edits.at(-1)!.delivery.card?.footer).toBe('Codex · Complete');
  expect(chat.sent).toHaveLength(1);
});

test('progress updates preserve delivery backoff and coalesce before the retry', async () => {
  const { bridge, chat, store } = fixture();
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'live', status: 'inProgress' } } });
  chat.fail = true; await bridge.flush();
  const before = store.db.query<{ nextAttempt: number }, []>('SELECT nextAttempt FROM outbox').get()!.nextAttempt;
  for (const command of ['first', 'second', 'latest']) await bridge.notification({ method: 'item/started', params: {
    threadId: 't1', turnId: 'live', item: { id: command, type: 'commandExecution', command },
  } });
  expect(store.db.query<{ nextAttempt: number }, []>('SELECT nextAttempt FROM outbox').get()!.nextAttempt).toBe(before);
  chat.fail = false; await bridge.flush();
  expect(chat.sent).toHaveLength(0);
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.sent).toHaveLength(1);
  expect(chat.sent[0]!.delivery.content).toBe('Running `latest`');
});

test('a final answer arriving while the progress card is being sent schedules an edit', async () => {
  const { bridge, chat, store } = fixture();
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'live', status: 'inProgress' } } });
  let release!: () => void;
  const send = chat.send.bind(chat);
  chat.send = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return send(...args); };
  const sending = bridge.flush();
  await bridge.notification({ method: 'item/completed', params: { threadId: 't1', turnId: 'live', item: { id: 'a', type: 'agentMessage', text: 'Done.' } } });
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'live', status: 'completed' } } });
  release(); await sending;
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.sent).toHaveLength(1);
  expect(chat.edits).toHaveLength(1);
  expect(chat.edits[0]!.id).toBe(chat.sent[0]!.id);
  expect(chat.edits[0]!.delivery.content).toBe('Done.');
});

test('progress edits leave pending approval controls on their separate card', async () => {
  const { bridge, chat, store } = fixture();
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn1', status: 'inProgress' } } });
  await bridge.flush();
  await bridge.serverRequest(approval());
  await Bun.sleep(0);
  await bridge.notification({ method: 'item/started', params: { threadId: 't1', turnId: 'turn1', item: { id: 'cmd', type: 'commandExecution', command: 'git status' } } });
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  const prompt = chat.sent.find(m => m.delivery.buttons?.length)!;
  expect(prompt.delivery.buttons).toHaveLength(2);
  expect(chat.edits.find(e => e.id === prompt.id)).toBeUndefined();
  expect(chat.edits.at(-1)!.delivery.content).toBe('Waiting for your response…');
  await bridge.decide(store.pendingApprovals()[0]!.token, 'accept', 'c1', 'alice');
  await bridge.notification({ method: 'serverRequest/resolved', params: { requestId: 9 } });
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.edits.find(e => e.id === prompt.id)?.delivery.buttons).toEqual([]);
  expect(chat.edits.filter(e => e.id !== prompt.id).at(-1)!.delivery.content).toBe('Running `git status`');
});

test('subagents have independent turn cards and terminal failure states survive late events', async () => {
  const { bridge, chat, store } = fixture();
  store.saveBinding({ ...binding, threadId: 'child', parentThreadId: 't1', label: 'Reviewer' });
  for (const threadId of ['t1', 'child']) await bridge.notification({ method: 'turn/started', params: {
    threadId, turn: { id: 'same-id', status: 'inProgress' },
  } });
  await bridge.flush();
  expect(chat.sent).toHaveLength(2);
  await bridge.notification({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'same-id', status: 'failed', error: { message: 'Connection lost' } } } });
  await bridge.notification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'same-id', status: 'interrupted' } } });
  await bridge.notification({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'same-id', status: 'inProgress' } } });
  store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush();
  expect(chat.edits.find(e => e.delivery.card?.footer === 'Reviewer · Failed')?.delivery.content).toContain('Connection lost');
  expect(chat.edits.find(e => e.delivery.card?.footer === 'Codex · Interrupted')).toBeDefined();
  expect(chat.sent).toHaveLength(2);
});
