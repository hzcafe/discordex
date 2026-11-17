import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ComponentType, MessageFlags } from 'discord.js';
import { Bridge } from '../src/bridge.js';
import { DiscordAdapter } from '../src/discord.js';
import { Store } from '../src/store.js';
import { modelPickerPayload, parseModelControl, type ModelOption, type ModelPicker, type ModelAction } from '../src/models.js';
import type { Config } from '../src/config.js';
import type { Binding, CodexPort, Thread } from '../src/types.js';

const config: Config = { guildId: 'guild', channelId: 'index', allowedUserIds: ['alice', 'bob'], approverUserIds: ['alice'],
  autoDiscover: false, projectRoots: ['/work'], socketPath: '/unused', stateDir: '/unused' };
const binding: Binding = { threadId: 't1', channelId: 'c1', parentThreadId: null, label: 'Project', cwd: '/work/project', since: 0, initialTurnId: null, checkpoint: null };
const model = (name: string, efforts = ['low', 'high', 'xhigh'], defaultEffort = 'low'): ModelOption => ({ id: name, model: name,
  displayName: name.toUpperCase(), description: `Description of ${name}`, hidden: false,
  supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: `${reasoningEffort} reasoning` })), defaultReasoningEffort: defaultEffort });
class FakeCodex extends EventEmitter implements CodexPort {
  connected = true; epoch = 'first';
  thread: Thread & { modelProvider: string } = { id: 't1', cwd: '/work/project', model: 'model-a', reasoningEffort: 'xhigh', modelProvider: 'openai', status: { type: 'idle' } };
  models = [model('model-a'), model('model-b', ['low', 'medium'], 'medium'), { ...model('hidden'), hidden: true }];
  calls: { method: string; params: any }[] = [];
  pageSize = 100;
  afterWrite?: () => Promise<void>;
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    let result: any;
    if (method === 'thread/read') result = { thread: structuredClone(this.thread) };
    else if (method === 'model/list') {
      const offset = Number(params.cursor ?? 0);
      result = { data: structuredClone(this.models.slice(offset, offset + this.pageSize)),
        nextCursor: offset + this.pageSize < this.models.length ? String(offset + this.pageSize) : null };
    } else if (method === 'thread/settings/update') {
      this.thread.model = params.model;
      if (params.effort !== undefined) this.thread.reasoningEffort = params.effort;
      await this.afterWrite?.();
      result = {};
    } else throw new Error(`Unexpected method: ${method}`);
    return result as T;
  }
  async respond(): Promise<void> {}
  writes() { return this.calls.filter(c => c.method === 'thread/settings/update'); }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { setSystemTime(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture() {
  const store = new Store(':memory:'); store.saveBinding({ ...binding });
  const codex = new FakeCodex();
  const chat = { checkThread: async () => {}, createThread: async () => 'new', send: async () => 'sent', edit: async () => {} };
  const bridge = new Bridge(config, codex, store, chat, () => {});
  cleanup.push(() => store.close(), () => bridge.stop());
  const act = (picker: ModelPicker, action: ModelAction, value?: string) => bridge.modelAction('c1', 'alice', picker.token, picker.revision, action, value);
  return { store, codex, bridge, act };
}
function controls(picker: ModelPicker) {
  const container = modelPickerPayload(picker).components[0]!.toJSON();
  return container.components.filter(c => c.type === ComponentType.ActionRow).flatMap(c => c.components);
}

test('model and supported effort selections stay local until Apply, then update the same session for future turns', async () => {
  const { bridge, codex, store, act } = fixture();
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'old', status: 'inProgress' } } });
  let picker = await bridge.modelPicker('c1', 'alice');
  expect(picker.models.map(m => m.model)).toEqual(['model-a', 'model-b']);
  expect(picker.effort).toBe('xhigh');
  expect(codex.calls.find(c => c.method === 'model/list')!.params).toEqual({ cursor: null, limit: 100, includeHidden: false, modelProvider: 'openai' });
  picker = await act(picker, 'model', '1');
  expect(picker.effort).toBe('medium');
  const effort = controls(picker).find(c => 'custom_id' in c && c.custom_id.endsWith(':effort'))!;
  expect('options' in effort && effort.options.map(o => o.label)).toEqual(['low', 'medium']);
  picker = await act(picker, 'effort', '0');
  expect(codex.writes()).toHaveLength(0);
  picker = await act(picker, 'apply');
  expect(codex.writes()).toEqual([{ method: 'thread/settings/update', params: { threadId: 't1', model: 'model-b', effort: 'low' } }]);
  expect(picker.current).toEqual({ model: 'model-b', effort: 'low', provider: 'openai' });
  expect(picker.notice).toContain('Saved for subsequent turns');
  expect(store.binding('t1')!.channelId).toBe('c1');
  expect(store.binding('t1')!.model).toBe('model-b');
  expect(store.turnState('t1', 'old')!.model?.name).toBe('model-a');
  await bridge.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'next', status: 'inProgress' } } });
  expect(store.turnState('t1', 'next')!.model).toMatchObject({ name: 'model-b', effort: 'low' });
  await act(picker, 'apply');
  expect(codex.writes()).toHaveLength(1); // Applying unchanged settings is a local no-op.
  expect(codex.calls.some(c => /thread\/(start|resume|queue)/.test(c.method))).toBe(false);
});

test('model controls require an authorized contributor, the original owner/channel, and an eligible live session', async () => {
  const { bridge, codex, store } = fixture();
  await expect(bridge.modelPicker('c1', 'outsider')).rejects.toThrow('not configured');
  await expect(bridge.modelPicker('index', 'alice')).rejects.toThrow('linked Discord thread');
  expect(codex.calls).toHaveLength(0);
  const picker = await bridge.modelPicker('c1', 'bob'); // Contributors need not be approval operators.
  await expect(bridge.modelAction('c1', 'alice', picker.token, picker.revision, 'apply')).rejects.toThrow('out of date');
  store.saveBinding({ ...binding, threadId: 't2', channelId: 'c2' });
  await expect(bridge.modelAction('c2', 'bob', picker.token, picker.revision, 'apply')).rejects.toThrow('out of date');
  codex.thread.cwd = '/private';
  await expect(bridge.modelAction('c1', 'bob', picker.token, picker.revision, 'apply')).rejects.toThrow('outside');
  expect(codex.writes()).toHaveLength(0);
});

test('old dropdown revisions, external setting changes, expired pickers and reconnects cannot write', async () => {
  const { bridge, codex, act } = fixture();
  const old = await bridge.modelPicker('c1', 'alice');
  let picker = await act(old, 'model', '1');
  await expect(act(old, 'effort', '0')).rejects.toThrow('out of date');
  codex.thread.reasoningEffort = 'high';
  await expect(act(picker, 'apply')).rejects.toThrow('settings changed');
  picker = await bridge.modelPicker('c1', 'alice');
  codex.epoch = 'second';
  await expect(act(picker, 'apply')).rejects.toThrow('reconnected');
  picker = await bridge.modelPicker('c1', 'alice');
  setSystemTime(new Date(Date.now() + 16 * 60_000));
  await expect(act(picker, 'apply')).rejects.toThrow('out of date');
  expect(codex.writes()).toHaveLength(0);
});

test('catalog changes and forged effort/model choices are rejected before a settings mutation', async () => {
  const { bridge, codex, act } = fixture();
  let picker = await bridge.modelPicker('c1', 'alice');
  await expect(act(picker, 'model', '999')).rejects.toThrow('Unknown');
  picker = await bridge.modelPicker('c1', 'alice');
  await expect(act(picker, 'effort', 'none')).rejects.toThrow('Unknown');
  picker = await bridge.modelPicker('c1', 'alice');
  picker = await act(picker, 'model', '1');
  codex.models[1]!.supportedReasoningEfforts = [{ reasoningEffort: 'low', description: '' }];
  await expect(act(picker, 'apply')).rejects.toThrow('no longer available');
  expect(codex.writes()).toHaveLength(0);
});

test('duplicate Apply clicks write once and a lost response is never retried automatically', async () => {
  const { bridge, codex, act } = fixture();
  let picker = await act(await bridge.modelPicker('c1', 'alice'), 'model', '1');
  let release!: () => void;
  let writing!: () => void;
  const started = new Promise<void>(resolve => { writing = resolve; });
  codex.afterWrite = () => new Promise<void>(resolve => { release = resolve; writing(); });
  const first = act(picker, 'apply');
  const duplicate = act(picker, 'apply').catch(error => error);
  await started; release(); await first;
  expect((await duplicate).message).toContain('out of date');
  expect(codex.writes()).toHaveLength(1);
  picker = await act(await bridge.modelPicker('c1', 'alice'), 'model', '0');
  codex.afterWrite = async () => { throw new Error('Lost reply after accepted update'); };
  await expect(act(picker, 'apply')).rejects.toThrow('Could not confirm');
  await expect(act(picker, 'apply')).rejects.toThrow('out of date');
  expect(codex.writes()).toHaveLength(2);
  const refreshed = await bridge.modelPicker('c1', 'alice');
  expect(refreshed.current.model).toBe('model-a');
  expect(codex.writes()).toHaveLength(2);
});

test('provider catalog pagination fits Discord menus and keeps the selected model and effort intact', async () => {
  const { bridge, codex, act } = fixture();
  codex.models = Array.from({ length: 28 }, (_, i) => ({ ...model(`model-${i}`), displayName: 'M'.repeat(150), description: 'D'.repeat(200) }));
  codex.pageSize = 10;
  codex.thread.model = 'model-27';
  let picker = await bridge.modelPicker('c1', 'alice');
  expect(picker.page).toBe(1);
  expect(codex.calls.filter(c => c.method === 'model/list').map(c => c.params.cursor)).toEqual([null, '10', '20']);
  const options = controls(picker).filter(c => c.type === ComponentType.StringSelect).flatMap(c => c.options);
  expect(options).toHaveLength(6); // Three models on the final page, three efforts.
  expect(options.every(o => o.label.length <= 100 && (o.description?.length ?? 0) <= 100)).toBe(true);
  picker = await act(picker, 'prev');
  const menu = controls(picker)[0]!;
  expect('options' in menu && menu.options).toHaveLength(25);
  expect(picker.selected).toBe(27);
  expect(JSON.stringify(modelPickerPayload(picker))).toContain('Selected:');
  picker = await act(picker, 'model', '1');
  expect(picker.effort).toBe('xhigh');
  expect(codex.writes()).toHaveLength(0);
});

test('opening and editing the private draft bypass the work queue while Apply waits for it', async () => {
  const { bridge, codex, act } = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const occupied = bridge.serial(() => gate);
  try {
    const picker = await act(await bridge.modelPicker('c1', 'alice'), 'model', '1');
    const applied = act(picker, 'apply');
    await Promise.resolve();
    expect(codex.writes()).toHaveLength(0);
    release(); await occupied; await applied;
    expect(codex.writes()).toHaveLength(1);
  } finally { release(); }
});

test('a disconnect after a settings write reports uncertainty without replaying the mutation', async () => {
  const { bridge, codex, act } = fixture();
  const picker = await act(await bridge.modelPicker('c1', 'alice'), 'model', '1');
  codex.afterWrite = async () => { codex.connected = false; codex.epoch = 'replacement'; };
  await expect(act(picker, 'apply')).rejects.toThrow('Could not confirm');
  expect(codex.writes()).toHaveLength(1);
  codex.connected = true;
  expect((await bridge.modelPicker('c1', 'alice')).current.model).toBe('model-b');
  expect(codex.writes()).toHaveLength(1);
});

test('unknown current models, empty catalogs and models without reasoning controls render valid disabled choices', async () => {
  const { bridge, codex, act } = fixture();
  codex.models = [model('simple', [])];
  let picker = await bridge.modelPicker('c1', 'alice');
  expect(picker.selected).toBe(-1);
  expect(controls(picker).find(c => 'custom_id' in c && c.custom_id.endsWith(':apply'))!.disabled).toBe(true);
  picker = await act(picker, 'model', '0');
  expect(controls(picker).find(c => 'custom_id' in c && c.custom_id.endsWith(':effort'))!.disabled).toBe(true);
  await act(picker, 'apply');
  expect(codex.writes()[0]!.params).toEqual({ threadId: 't1', model: 'simple' });
  codex.models = [];
  picker = await bridge.modelPicker('c1', 'alice');
  expect(controls(picker)[0]!.disabled).toBe(true);
  expect(() => modelPickerPayload(picker).components[0]!.toJSON()).not.toThrow();
});

test('Discord slash and select interactions edit one private model picker and Apply persists both choices', async () => {
  const { bridge, codex, store } = fixture();
  const adapter = new DiscordAdapter(config, store); (adapter as any).bridge = bridge;
  cleanup.push(() => adapter.close());
  const interaction = (kind: 'command' | 'select' | 'button', customId = '', value = '') => {
    const responses: any = {};
    const event = { commandName: 'codex', guildId: 'guild', channelId: 'c1', user: { id: 'alice' }, customId, values: [value],
      options: { getSubcommand: () => 'model' }, isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button',
      isStringSelectMenu: () => kind === 'select', isModalSubmit: () => false, deferred: false, replied: false,
      deferReply: async (p: any) => { responses.defer = p; event.deferred = true; },
      deferUpdate: async () => { responses.update = true; event.deferred = true; },
      editReply: async (p: any) => { responses.edit = p; }, reply: async (p: any) => { responses.reply = p; } };
    return { event, responses };
  };
  const control = (response: any, action: string) => response.edit.components[0].toJSON().components
    .filter((c: any) => c.type === ComponentType.ActionRow).flatMap((c: any) => c.components)
    .find((c: any) => c.custom_id.endsWith(`:${action}`)).custom_id;
  const command = interaction('command'); await (adapter as any).interact(command.event);
  expect(command.responses.defer.flags).toBe(MessageFlags.Ephemeral);
  expect(command.responses.edit.flags).toBe(MessageFlags.IsComponentsV2);
  const select = interaction('select', control(command.responses, 'model'), '1'); await (adapter as any).interact(select.event);
  expect(select.responses.update).toBe(true);
  const effort = interaction('select', control(select.responses, 'effort'), '0'); await (adapter as any).interact(effort.event);
  expect(effort.responses.update).toBe(true);
  expect(codex.writes()).toHaveLength(0);
  const apply = interaction('button', control(effort.responses, 'apply')); await (adapter as any).interact(apply.event);
  expect(JSON.stringify(apply.responses.edit)).toContain('Saved for subsequent turns');
  expect(codex.writes()[0]!.params).toEqual({ threadId: 't1', model: 'model-b', effort: 'low' });
  const forged = interaction('select', control(apply.responses, 'apply'), '0'); await (adapter as any).interact(forged.event);
  expect(forged.responses.reply.content).toContain('Unknown model control');
  expect(codex.writes()).toHaveLength(1);
  expect(() => parseModelControl('dx:model:token:1:apply:extra')).toThrow();
});
