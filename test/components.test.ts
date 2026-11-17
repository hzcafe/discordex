import { expect, test } from 'bun:test';
import { ComponentType, MessageFlags, ButtonStyle } from 'discord.js';
import { discordPayload, discordEditPayload } from '../src/components.js';
import { approvalDelivery, card, turnDelivery } from '../src/render.js';
import type { Approval } from '../src/store.js';
import type { Binding, Item, UploadFile } from '../src/types.js';
import { defaultArtifacts } from '../src/config.js';

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

test('documents and media stay visible without injecting file text, and notices respect the V2 text budget', () => {
  // Cached snapshots from older versions may still carry preview metadata.
  const legacyFile = { name: 'plan.md', hash: 'plan', kind: 'file' as const,
    data: Buffer.from('# Plan @everyone'), size: 16, preview: '# Plan @everyone' };
  const files: UploadFile[] = [
    legacyFile,
    { name: 'shot.png', hash: 'image', kind: 'image', data: Buffer.from('png'), size: 3 },
    { name: 'demo.mp4', hash: 'video', kind: 'video', data: Buffer.from('mp4'), size: 3 },
  ];
  const delivery = { ...card('a'.repeat(3400), { title: 'Answer', footer: 'Codex · Complete' }),
    artifactNotes: ['Missing file: a.pdf.', 'b'.repeat(2000)] };
  const payload = discordPayload(delivery, files);
  const components = flatten(wire(payload));
  expect(payload.files).toHaveLength(3);
  expect(components.find(c => c.type === ComponentType.File).file.url).toBe('attachment://plan.md');
  expect(components.find(c => c.type === ComponentType.MediaGallery).items.map((i: any) => i.media.url))
    .toEqual(['attachment://shot.png', 'attachment://demo.mp4']);
  const texts = components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content);
  expect(texts.join()).toContain('Missing file');
  expect(texts.reduce((n, text) => n + text.length, 0)).toBeLessThanOrEqual(4000);
  expect(payload.allowedMentions.parse).toEqual([]);
  expect(flatten(wire(discordPayload({ content: 'Done' }, files)))
    .filter(c => c.type === ComponentType.TextDisplay).map(c => c.content)).toEqual(['**Codex**\nDone']);
});

test('editing retains identical attachments and uploads only new or changed files', () => {
  const files: UploadFile[] = [
    { name: 'plan.md', hash: 'plan', kind: 'file', data: Buffer.from('Plan'), size: 4 },
    { name: 'image.png', hash: 'new-image', kind: 'image', data: Buffer.from('New'), size: 3 },
  ];
  const edited = discordEditPayload({ content: 'Updated' }, files, [
    { name: 'plan.md', hash: 'plan', id: '11' }, { name: 'image.png', hash: 'old-image', id: '12' },
    { name: 'removed.pdf', hash: 'removed', id: '13' },
  ]);
  expect(edited.attachments).toEqual([{ id: '11', filename: 'plan.md' }]);
  expect(edited.files).toHaveLength(1); expect(edited.files[0]!.name).toBe('image.png');
  expect(JSON.stringify(wire(edited))).toContain('attachment://plan.md');
});

test('generated and referenced attachments share one byte budget on sends and edits', () => {
  const limits = { ...defaultArtifacts, maxFileBytes: 10, maxTotalBytes: 12 };
  const files: UploadFile[] = [
    { name: 'plan.md', hash: 'plan', kind: 'file', data: Buffer.from('12345678'), size: 8 },
    { name: 'small.txt', hash: 'small', kind: 'file', data: Buffer.from('ok'), size: 2 },
  ];
  const delivery = { content: 'Reply', file: { name: 'response.md', content: '123456' } };
  const sent = discordPayload(delivery, files, [], limits);
  expect(sent.files.map(f => f.name)).toEqual(['response.md', 'small.txt']);
  expect(JSON.stringify(wire(sent))).toContain('plan.md: exceeds the attachment size limit');
  const edited = discordEditPayload(delivery, files, [{ id: '1', name: 'plan.md', hash: 'plan' }], limits);
  expect(edited.attachments).toEqual([]);
  expect(edited.files.map(f => f.name)).toEqual(['response.md', 'small.txt']);
});

test('long escaped headings, footers, notices and controls fit the shared message text budget', () => {
  const delivery = { ...card('a'.repeat(3400), { title: '*'.repeat(300), subtitle: '_'.repeat(300), footer: '*'.repeat(90) },
    'response.md', [{ id: 'dx:prompt:accept', label: 'Approve once' }]), artifactNotes: ['Missing file. '.repeat(200)] };
  const payload = discordPayload(delivery);
  const components = flatten(wire(payload));
  const text = components.filter(c => c.type === ComponentType.TextDisplay).map(c => c.content).join('');
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(components.length).toBeLessThanOrEqual(40);
  expect(components.some(c => c.type === ComponentType.Button && c.custom_id === 'dx:prompt:accept')).toBe(true);
  expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
});
