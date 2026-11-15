import { expect, test } from 'bun:test';
import { ComponentType, MessageFlags, ButtonStyle } from 'discord.js';
import { discordPayload, discordEditPayload } from '../src/components.js';
import { approvalDelivery, card, turnDelivery } from '../src/render.js';
import type { Approval } from '../src/store.js';
import type { Binding, Item } from '../src/types.js';

const binding: Binding = { threadId: 'thread-123', parentThreadId: null, channelId: 'channel', label: 'Fix login flow',
  cwd: '/work/app', since: 0, initialTurnId: null, checkpoint: null };
function reply(binding: Binding, item: Item, active = false) {
  return turnDelivery(binding, { turn: { id: 't', status: active ? 'inProgress' : 'completed', items: [item] }, completedItemIds: [item.id], lastItemId: item.id });
}
function flatten(components: any[]): any[] {
  return components.flatMap(c => [c, ...flatten(c.components ?? [])]);
}
function wire(payload: ReturnType<typeof discordPayload>) { return payload.components.map(c => c.toJSON()); }

test('assistant replies use a small attribution footer without repeating the thread title', () => {
  const delivery = reply(binding, { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'Fixed the login bug.' });
  const payload = discordPayload(delivery);
  const components = wire(payload);
  expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
  expect('content' in payload).toBe(false);
  expect('embeds' in payload).toBe(false);
  expect(components[0]!.type).toBe(ComponentType.Container);
  const texts = flatten(components).filter(c => c.type === ComponentType.TextDisplay).map(c => c.content);
  expect(texts).toEqual(['Fixed the login bug.', '-# ✓ Codex · Complete']);
  expect(flatten(components).some(c => c.type === ComponentType.Separator)).toBe(false);
  expect(texts.join('')).not.toContain('thread-123');
  expect(payload.allowedMentions.parse).toEqual([]);
  const subagent = reply({ ...binding, parentThreadId: 'parent', label: 'Reviewer' }, { id: 'a', type: 'agentMessage', text: 'Review complete.' });
  expect(flatten(wire(discordPayload(subagent))).filter(c => c.type === ComponentType.TextDisplay).map(c => c.content))
    .toEqual(['Review complete.', '-# ✓ Reviewer · Complete']);
  const progress = reply(binding, { id: 'p', type: 'agentMessage', phase: 'commentary', text: 'Checking the logs.' }, true);
  expect(flatten(wire(discordPayload(progress))).at(-1).content).toBe('-# ◦ Codex · Working');
  const labeled = turnDelivery(binding, { turn: { id: 't', status: 'inProgress' }, lastItemId: null, completedItemIds: [],
    model: { name: 'example-model', effort: 'high', source: 'selected' } });
  expect(flatten(wire(discordPayload(labeled))).at(-1).content).toBe('-# ◦ Codex · example-model · high · Working');
});

test('long replies keep more text inline and explicitly expose the full attachment in V2', () => {
  const inline = card('a'.repeat(3000), { title: 'Codex' });
  expect(inline.file).toBeUndefined();
  expect(inline.content).toHaveLength(3000);
  const text = '```ts\n' + 'const test = true;\n'.repeat(700) + '```';
  const delivery = reply(binding, { id: 'long', type: 'agentMessage', phase: 'final_answer', text });
  const payload = discordPayload(delivery);
  const components = flatten(wire(payload));
  expect(delivery.file!.content).toBe(text);
  expect(payload.files).toHaveLength(1);
  expect(components.find(c => c.type === ComponentType.File).file.url).toBe('attachment://response.md');
  expect(components.at(-1).content).toBe('-# ✓ Codex · Complete');
  expect(components.filter(c => c.type === ComponentType.TextDisplay).reduce((n, c) => n + c.content.length, 0)).toBeLessThanOrEqual(4000);
  expect((delivery.content.match(/^```/gm)?.length ?? 0) % 2).toBe(0);
});

test('approval controls remain scoped and disappear on resolution, including conversion of old messages', () => {
  const approval: Approval = { token: 'token', epoch: 'epoch', rpcId: '1', threadId: binding.threadId, channel: binding.channelId, state: 'pending',
    packet: JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval', params: {
      threadId: binding.threadId, command: 'git status', availableDecisions: ['accept', 'decline', 'cancel'],
    } }) };
  const components = flatten(wire(discordPayload(approvalDelivery(approval, binding))));
  const buttons = components.filter(c => c.type === ComponentType.Button);
  expect(buttons.map(b => b.custom_id)).toEqual(['dx:token:accept', 'dx:token:decline', 'dx:token:cancel']);
  expect(buttons.map(b => b.style)).toEqual([ButtonStyle.Success, ButtonStyle.Danger, ButtonStyle.Secondary]);
  const edited = discordEditPayload(approvalDelivery({ ...approval, state: 'resolved' }, binding));
  expect(flatten(wire(edited)).some(c => c.type === ComponentType.Button)).toBe(false);
  expect(edited.content).toBeNull();
  expect(edited.embeds).toEqual([]);
  expect(edited.attachments).toEqual([]);
  expect(edited.flags).toBe(MessageFlags.IsComponentsV2);
});

test('persisted legacy deliveries remain readable and retain their action IDs', () => {
  const payload = discordEditPayload({ content: 'Old pending approval', buttons: [{ id: 'dx:old:decline', label: 'Decline', danger: true }] });
  const components = flatten(wire(payload));
  expect(components.find(c => c.type === ComponentType.Button).custom_id).toBe('dx:old:decline');
  expect(components.some(c => c.content?.includes('Old pending approval'))).toBe(true);
  expect(payload.content).toBeNull();
});

test('empty completion and failures use the same card shape as live progress', () => {
  const complete = wire(discordPayload(turnDelivery(binding, { turn: { id: 't', status: 'completed' }, completedItemIds: [], lastItemId: null })));
  expect(complete).toHaveLength(1);
  expect(complete[0]!.type).toBe(ComponentType.Container);
  expect(flatten(complete).at(-1).content).toBe('-# ✓ Codex · Complete');
  const failed = flatten(wire(discordPayload(turnDelivery(binding, { turn: { id: 't', status: 'failed', error: { message: 'Connection lost' } }, completedItemIds: [], lastItemId: null }))));
  expect(failed.some(c => c.content?.includes('Connection lost'))).toBe(true);
  expect(failed[0].type).toBe(ComponentType.Container);
});
