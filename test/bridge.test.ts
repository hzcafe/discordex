import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { Store } from '../src/store.js';
import type { Config } from '../src/config.js';
import type { Binding, ChatPort, CodexPort, Delivery, Packet, Thread, Turn } from '../src/types.js';
import { approvalDelivery, message, turnDelivery } from '../src/render.js';

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
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: any;
    if (method === 'thread/read') result = { thread: structuredClone(this.thread) };
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
  async createThread(): Promise<string> { return 'created'; }
  async send(channel: string, delivery: Delivery, nonce: string): Promise<string> {
    if (this.fail) throw new Error('Discord disconnected');
    const id = `message-${this.sent.length}`; this.sent.push({ channel, delivery, nonce, id }); return id;
  }
  async edit(channel: string, id: string, delivery: Delivery): Promise<void> { this.edits.push({ channel, id, delivery }); }
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

test('reconnect invalidates old prompts even when a new connection reuses the same RPC ID', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.serverRequest(approval('9'));
  const old = store.pendingApprovals()[0]!;
  codex.epoch = 'connection-2';
  await expect(bridge.decide(old.token, 'accept', 'c1', 'alice')).rejects.toThrow('no longer active');
  await bridge.serverRequest(approval('9'));
  const fresh = store.pendingApprovals().find(a => a.epoch === 'connection-2')!;
  expect(fresh.token).not.toBe(old.token);
  await bridge.decide(fresh.token, 'decline', 'c1', 'alice');
  expect(codex.responses).toEqual([{ id: '9', result: { decision: 'decline' } }]);
});

test('permission approval grants exactly the requested scope for one turn', async () => {
  const { bridge, codex, store } = fixture();
  await bridge.serverRequest({ id: 7, method: 'item/permissions/requestApproval', params: {
    threadId: 't1', turnId: 'turn1', permissions: { network: { enabled: true }, fileSystem: null },
  } });
  await bridge.decide(store.pendingApprovals()[0]!.token, 'accept', 'c1', 'alice');
  expect(codex.responses[0]!.result).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('multi-question responses keep question IDs, and secret questions stay local', async () => {
  const { bridge, codex, store } = fixture();
  const packet = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 't1', turnId: 'turn1', questions: [
    { id: 'a', question: 'Which?', header: 'Choice' }, { id: 'b', question: 'Why?', header: 'Reason' },
  ] } };
  await bridge.serverRequest(packet);
  await bridge.decide(store.pendingApprovals()[0]!.token, 'answer', 'c1', 'alice', { a: 'First', b: 'Simpler' });
  expect(codex.responses[0]!.result).toEqual({ answers: { a: { answers: ['First'] }, b: { answers: ['Simpler'] } } });
  await bridge.serverRequest({ ...packet, id: 8, params: { ...packet.params, questions: [{ id: 's', question: 'Secret', isSecret: true }] } });
  const secret = store.pendingApprovals().find(a => a.rpcId === '8')!;
  expect(approvalDelivery(secret).buttons).toEqual([]);
});

test('file approvals require the actual proposed diff', async () => {
  const { bridge, store } = fixture();
  const packet = { id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'turn1', itemId: 'patch' } };
  await bridge.serverRequest(packet);
  expect(approvalDelivery(store.pendingApprovals()[0]!).buttons).toEqual([]);
  store.saveItem('t1', { id: 'patch', type: 'fileChange', changes: [{ path: '/work/a', diff: '+hello' }] });
  await bridge.serverRequest({ ...packet, id: 8 });
  const a = store.pendingApprovals().find(a => a.rpcId === '8')!;
  expect(approvalDelivery(a).content).toContain('+hello');
  expect(approvalDelivery(a).buttons).toHaveLength(3);
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
