import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { goalCard, parseGoalBudget, parseGoalControl } from '../src/goals.js';
import { discordPayload } from '../src/components.js';
import type { Config } from '../src/config.js';
import type { Binding, CodexPort, Delivery, GoalCardState, ThreadGoal } from '../src/types.js';

const config: Config = { guildId: 'guild', channelId: 'index', allowedUserIds: ['alice', 'bob'], approverUserIds: ['alice'],
  autoDiscover: false, projectRoots: ['/work'], socketPath: '/unused', stateDir: '/unused' };
const binding: Binding = { threadId: 'root', channelId: 'channel', parentThreadId: null, cwd: '/work/project', label: 'Project',
  since: 0, initialTurnId: null, checkpoint: null };
const sample = (patch: Partial<ThreadGoal> = {}): ThreadGoal => ({ threadId: 'root', objective: 'Finish the migration', status: 'active',
  tokenBudget: 10000, tokensUsed: 3500, timeUsedSeconds: 65, createdAt: 100, updatedAt: 101, ...patch });

class GoalCodex extends EventEmitter implements CodexPort {
  connected = true; epoch = 'connection-1'; goal: ThreadGoal | null = null;
  calls: { method: string; params: any }[] = [];
  failSetAfterCommit = false;
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: unknown;
    if (method === 'thread/goal/get') result = { goal: this.goal };
    else if (method === 'thread/goal/set') {
      const replacing = params.objective !== undefined && (!this.goal || params.objective !== this.goal.objective || this.goal.status === 'complete');
      this.goal = { ...(replacing ? sample({ tokensUsed: 0, timeUsedSeconds: 0, createdAt: 200 }) : this.goal!),
        ...('objective' in params ? { objective: params.objective } : {}),
        ...('status' in params ? { status: params.status } : {}),
        ...('tokenBudget' in params ? { tokenBudget: params.tokenBudget } : {}), updatedAt: 300 };
      if (this.failSetAfterCommit) throw new Error('connection lost after acceptance');
      result = { goal: this.goal };
    } else if (method === 'thread/goal/clear') { this.goal = null; result = { cleared: true }; }
    else if (method === 'thread/resume' || method === 'thread/read') result = { thread: { id: 'root', cwd: '/work/project', status: { type: 'idle' } } };
    else if (method === 'thread/turns/list' || method === 'thread/queue/list') result = { data: [] };
    else throw new Error(`Unexpected method: ${method}`);
    return structuredClone(result) as T;
  }
  async respond(): Promise<void> {}
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(path = ':memory:') {
  const store = new Store(path); store.saveBinding(binding);
  const codex = new GoalCodex();
  const sent: Delivery[] = []; const edits: { id: string; delivery: Delivery }[] = [];
  const chat = { checkThread: async () => {}, createThread: async () => 'channel', send: async (_channel: string, delivery: Delivery) => {
    sent.push(delivery); return `message-${sent.length}`;
  }, edit: async (_channel: string, id: string, delivery: Delivery) => { edits.push({ id, delivery }); } };
  const bridge = new Bridge(config, codex, store, chat, () => {});
  cleanup.push(() => store.close()); cleanup.push(() => bridge.stop());
  const version = () => store.goalCard('root')!.version;
  const action = (type: Parameters<Bridge['goalAction']>[4], input?: Parameters<Bridge['goalAction']>[5], expected = version()) =>
    bridge.serial(() => bridge.goalAction('channel', 'alice', 'root', expected, type, input));
  const tick = async () => { store.db.query('UPDATE outbox SET nextAttempt = 0').run(); await bridge.flush(); };
  return { store, codex, bridge, chat, sent, edits, version, action, tick };
}

test('goal command opens one shared card; polling empty sessions does not create cards', async () => {
  const f = fixture();
  await f.bridge.sync(); await f.bridge.flush();
  expect(f.sent).toHaveLength(0);
  await f.bridge.showGoal('channel', 'alice'); await f.tick();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.content).toContain('No goal set');
  expect(f.sent[0]!.buttons!.map(b => b.label)).toEqual(['Create goal', 'Refresh']);
  await f.bridge.showGoal('channel', 'bob'); await f.tick();
  expect(f.sent).toHaveLength(1); expect(f.edits).toHaveLength(0);
  expect(f.store.messageId('goal:root')).toBe('message-1');
});

test('create, pause, resume, budget edits, and clear use explicit user RPCs and preserve accounting', async () => {
  const f = fixture(); await f.bridge.showGoal('channel', 'alice'); await f.tick();
  await f.action('create', { objective: 'Ship the feature', budget: '10000' });
  expect(f.codex.calls.find(c => c.method === 'thread/goal/set')!.params).toEqual({ threadId: 'root', origin: 'user', objective: 'Ship the feature', tokenBudget: 10000, status: 'active' });
  f.codex.goal!.tokensUsed = 3500;
  await f.action('pause');
  expect(f.codex.goal!.status).toBe('paused');
  expect(f.codex.goal!.tokensUsed).toBe(3500);
  await f.action('budget', { budget: '20000' });
  expect(f.codex.calls.at(-1)!.params).toEqual({ threadId: 'root', origin: 'user', tokenBudget: 20000 });
  expect(f.codex.goal!.status).toBe('paused'); expect(f.codex.goal!.tokensUsed).toBe(3500);
  await f.action('budget', { budget: '' });
  expect(f.codex.calls.at(-1)!.params).toEqual({ threadId: 'root', origin: 'user', tokenBudget: null });
  await f.action('resume');
  expect(f.codex.calls.at(-1)!.params).toEqual({ threadId: 'root', origin: 'user', status: 'active' });
  await f.action('clear'); await f.tick();
  expect(f.codex.calls.at(-1)!.params).toEqual({ threadId: 'root', origin: 'user' });
  expect(f.codex.goal).toBeNull();
  expect(f.sent).toHaveLength(1);
  expect(f.edits.at(-1)!.id).toBe('message-1');
  expect(f.codex.calls.some(c => c.method === 'turn/start' || c.method === 'turn/interrupt')).toBe(false);
});

test('another contributor can operate goals, but unauthorized users, channels, and projects cannot', async () => {
  const f = fixture(); f.codex.goal = sample();
  await f.bridge.showGoal('channel', 'alice');
  await f.bridge.goalAction('channel', 'bob', 'root', f.version(), 'pause');
  expect(f.codex.goal!.status).toBe('paused');
  f.codex.calls = [];
  await expect(f.bridge.showGoal('channel', 'eve')).rejects.toThrow('not configured');
  await expect(f.bridge.showGoal('index', 'alice')).rejects.toThrow('linked Discord thread');
  await expect(f.bridge.goalAction('channel', 'alice', 'another-thread', f.version(), 'clear')).rejects.toThrow('different session');
  f.store.saveBinding({ ...binding, cwd: '/private' });
  await expect(f.bridge.showGoal('channel', 'alice')).rejects.toThrow('outside');
  expect(f.codex.calls).toHaveLength(0);
});

test('stale buttons and submitted modals cannot overwrite a replaced or edited goal', async () => {
  const f = fixture(); f.codex.goal = sample(); await f.bridge.showGoal('channel', 'alice');
  const old = f.version();
  expect(f.bridge.goalForm('channel', 'alice', 'root', old, 'budget').goal!.tokenBudget).toBe(10000);
  f.codex.goal = sample({ objective: 'A different goal', createdAt: 200 });
  await expect(f.action('budget', { budget: '90000' }, old)).rejects.toThrow('goal changed');
  await expect(f.action('clear', undefined, old)).rejects.toThrow('goal changed');
  expect(f.codex.calls.some(c => c.method === 'thread/goal/set' || c.method === 'thread/goal/clear')).toBe(false);
  const beforeEdit = f.version(); await f.action('budget', { budget: '20000' });
  await expect(f.action('budget', { budget: '30000' }, beforeEdit)).rejects.toThrow('goal changed');
  expect(f.codex.goal!.tokenBudget).toBe(20000);
});

test('resuming an exhausted goal requires a budget change and never resets usage accounting', async () => {
  const f = fixture(); f.codex.goal = sample({ status: 'budgetLimited', tokensUsed: 12000 });
  await f.bridge.showGoal('channel', 'alice');
  await expect(f.action('resume')).rejects.toThrow('Increase or remove the budget');
  expect(f.codex.calls.some(c => c.method === 'thread/goal/set')).toBe(false);
  await f.action('budget', { budget: '20000' });
  expect(f.codex.goal.status).toBe('budgetLimited');
  await f.action('resume');
  expect(f.codex.goal.status).toBe('active'); expect(f.codex.goal.tokensUsed).toBe(12000);
});

test('live goal counters keep buttons valid and update the same card; stale notifications cannot resurrect or clear goals', async () => {
  const f = fixture(); f.codex.goal = sample(); await f.bridge.showGoal('channel', 'alice'); await f.tick();
  const old = f.version();
  f.codex.goal = sample({ tokensUsed: 4500, timeUsedSeconds: 125, updatedAt: 120 });
  await f.bridge.notification({ method: 'thread/goal/updated', params: { threadId: 'root', goal: sample() } });
  expect(f.version()).toBe(old);
  await f.tick(); expect(f.edits.at(-1)!.delivery.content).toContain('4,500 / 10,000');
  f.codex.goal = null;
  await f.bridge.notification({ method: 'thread/goal/updated', params: { threadId: 'root', goal: sample() } });
  expect(f.store.goalCard('root')!.goal).toBeNull();
  f.codex.goal = sample({ objective: 'New goal', createdAt: 200 });
  await f.bridge.notification({ method: 'thread/goal/cleared', params: { threadId: 'root' } });
  await f.tick();
  expect(f.store.goalCard('root')!.goal!.objective).toBe('New goal');
  expect(f.sent).toHaveLength(1);
  expect(f.edits.every(e => e.id === 'message-1')).toBe(true);
});

test('goal snapshots discovered during sync appear automatically and reconnects invalidate old controls', async () => {
  const f = fixture(); f.codex.goal = sample();
  f.bridge.start(); await f.bridge.serial(async () => {}); await f.tick();
  const old = f.version();
  expect(f.sent).toHaveLength(1);
  f.codex.connected = false; f.codex.emit('disconnected');
  await f.tick();
  expect(f.edits.at(-1)!.delivery.buttons!.map(b => b.label)).toEqual(['Refresh']);
  expect(() => f.bridge.goalForm('channel', 'alice', 'root', old, 'budget')).toThrow('out of date');
  f.codex.connected = true; f.codex.epoch = 'connection-2';
  await f.bridge.sync();
  await expect(f.action('pause', undefined, old)).rejects.toThrow('goal changed');
  expect(f.codex.calls.some(c => c.method === 'thread/goal/set')).toBe(false);
});

test('uncertain goal mutations are not retried automatically and refresh reconciles acceptance', async () => {
  const f = fixture(); await f.bridge.showGoal('channel', 'alice');
  const old = f.version(); f.codex.failSetAfterCommit = true;
  await expect(f.action('create', { objective: 'Finish work' })).rejects.toThrow('Could not confirm');
  expect(f.store.goalCard('root')!.unavailable).toContain('could not be confirmed');
  f.codex.failSetAfterCommit = false;
  await f.action('refresh');
  expect(f.store.goalCard('root')!.goal!.objective).toBe('Finish work');
  await expect(f.action('create', { objective: 'Duplicate work' }, old)).rejects.toThrow('goal changed');
  expect(f.codex.calls.filter(c => c.method === 'thread/goal/set')).toHaveLength(1);
});

test('goal cards retain their Discord message across a database reopen and preserve delivery backoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-goal-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path); first.saveBinding(binding);
  const state: GoalCardState = { goal: sample(), version: 'old-version', epoch: 'old-connection' };
  first.publishGoal(binding, state, goalCard(binding, state));
  first.delivered(first.outgoing()[0]!, 'saved-message'); first.close();
  const f = fixture(path); f.codex.goal = sample({ tokensUsed: 4000 });
  await f.bridge.showGoal('channel', 'alice'); await f.tick();
  expect(f.sent).toHaveLength(0); expect(f.edits[0]!.id).toBe('saved-message');
  f.chat.edit = async () => { throw new Error('Discord unavailable'); };
  f.codex.goal.tokensUsed = 4500; await f.bridge.showGoal('channel', 'alice'); await f.tick();
  const retry = f.store.db.query<{nextAttempt:number},[]>('SELECT nextAttempt FROM outbox').get()!.nextAttempt;
  f.codex.goal.tokensUsed = 4600; await f.bridge.showGoal('channel', 'alice');
  expect(f.store.db.query<{nextAttempt:number},[]>('SELECT nextAttempt FROM outbox').get()!.nextAttempt).toBe(retry);
});

test('invalid budgets and empty objectives never mutate goals, and completed goals can start fresh', async () => {
  const f = fixture(); await f.bridge.showGoal('channel', 'alice');
  for (const budget of ['0', '-1', '1.5', '1e6', '100,000', '9007199254740992']) {
    expect(() => parseGoalBudget(budget)).toThrow('positive whole number');
    await expect(f.action('create', { objective: 'Do work', budget })).rejects.toThrow('positive whole number');
  }
  await expect(f.action('create', { objective: '   ' })).rejects.toThrow('objective');
  expect(f.codex.calls.some(c => c.method === 'thread/goal/set')).toBe(false);
  f.codex.goal = sample({ status: 'complete' }); await f.bridge.showGoal('channel', 'alice');
  await f.action('create', { objective: 'Finish the migration' });
  expect(f.codex.goal.status).toBe('active'); expect(f.codex.goal.tokensUsed).toBe(0);
});

test('goal cards label budget and time separately, preserve full long objectives, and keep Discord controls within limits', () => {
  for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const) {
    const state: GoalCardState = { goal: sample({ status }), version: '12345678-123', epoch: 'connection' };
    const delivery = goalCard(binding, state);
    expect(delivery.content).toContain('6,500 tokens left');
    expect(delivery.content).toContain('🟦🟦🟦🟦🟦🟦⬛⬛⬛⬛');
    expect(delivery.content).toContain('1m 5s');
    expect(delivery.card!.footer).toContain('Separate from account');
    expect(delivery.buttons!.length).toBeLessThanOrEqual(5);
    for (const button of delivery.buttons!) {
      expect(button.id.length).toBeLessThanOrEqual(100);
      expect(parseGoalControl(button.id).threadId).toBe('root');
    }
    expect(() => discordPayload(delivery).components.map(c => c.toJSON())).not.toThrow();
  }
  const goal = sample({ objective: 'a'.repeat(4000), tokenBudget: null });
  const delivery = goalCard(binding, { goal, version: 'v', epoch: 'e' });
  expect(delivery.content.length).toBeLessThan(1500);
  expect(delivery.file!.content).toBe(goal.objective);
  expect(delivery.content).toContain('No token budget');
  expect(() => parseGoalControl('dx:goal:root:v:delete-everything')).toThrow('Unknown');
});
