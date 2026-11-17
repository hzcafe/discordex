import { expect, test } from 'bun:test';
import { ComponentType } from 'discord.js';
import { displayReferences, presentDelivery } from '../src/references.js';
import { fileReferences } from '../src/file-references.js';
import { discordPayload } from '../src/components.js';
import { approvalDelivery, card } from '../src/render.js';
import { prepareUploads } from '../src/uploads.js';
import { defaultArtifacts } from '../src/config.js';
import type { Artifact, UploadFile } from '../src/types.js';

const artifact: Artifact = { hash: 'plan', name: 'plan-12345678-1.md', kind: 'file', size: 4,
  references: ['/home/alice/project/docs/plan.md', 'docs/plan.md', 'other/copy.md'] };

test('only attached file references use attachment names; other paths and line numbers stay exact', () => {
  const text = '[Plan](/home/alice/project/docs/plan.md:12) and `docs/plan.md`, [copy](other/copy.md), '
    + '[Queue](/root/dev/discordex/src/store.ts#L150-L160), `/home/alice/`, and src/other.ts:25.';
  const displayed = displayReferences(text, [artifact]);
  expect(displayed).toContain('Plan — `plan-12345678-1.md:12`');
  expect(displayed).toContain('`plan-12345678-1.md`');
  expect(displayed).toContain('copy — `plan-12345678-1.md`');
  expect(displayed).toContain('[Queue](/root/dev/discordex/src/store.ts#L150-L160)');
  expect(displayed).toContain('src/other.ts:25');
  expect(displayed).toContain('`/home/alice/`');
  expect(displayReferences('`docs/research/`', [artifact])).toBe('`docs/research/`');
  expect(fileReferences(text)).toEqual(['/home/alice/project/docs/plan.md', 'docs/plan.md', 'other/copy.md']);
});

test('attached reference links, images and encoded paths are replaced while unmatched references remain', () => {
  const text = '[Plan][p] ![Screenshot](file:///home/alice/screen.png) [Report](sandbox:/tmp/my%20report.pdf) '
    + '`/home/alice/my plan.md` `C:\\Users\\Alice\\report.pdf:12`\n\n[p]: /private/project/plan.md\n[unused]: /secret/notes.txt\n';
  const displayed = displayReferences(text, [
    { ...artifact, references: ['/private/project/plan.md'] },
    { ...artifact, name: 'screen.png', references: ['/home/alice/screen.png'] },
    { ...artifact, name: 'report.pdf', references: ['/tmp/my report.pdf'] },
    { ...artifact, name: 'my-plan.md', references: ['/home/alice/my plan.md'] },
  ]);
  expect(displayed).toContain('Plan — `plan-12345678-1.md`');
  expect(displayed).toContain('Screenshot — `screen.png`');
  expect(displayed).toContain('Report — `report.pdf`');
  expect(displayed).toContain('`my-plan.md`');
  expect(displayed).not.toContain('[p]:');
  expect(displayed).toContain('[unused]: /secret/notes.txt');
  expect(displayed).toContain('`C:\\Users\\Alice\\report.pdf:12`');
  expect(displayReferences(text)).toBe(text);
});

test('web links and local service URLs remain exactly as authored', () => {
  const publicLink = '[API](https://docs.example.com/api/reference?view=full#files)';
  expect(displayReferences(publicLink)).toBe(publicLink);
  const text = '[Dev](http://localhost:3000/private) http://192.168.1.2:8080/report '
    + 'http://127.0.0.1:9000 http://10.0.0.1 http://172.16.0.1 https://host.local/a '
    + 'http://[::1]:4000/x https://user:password@example.com/path';
  expect(displayReferences(text, [artifact])).toBe(text);
});

test('commands, code examples, plain paths and unrelated link labels stay exact even with an attachment', () => {
  const text = 'Use `/codex usage` or </codex usage:123>.\n```sh\ncat docs/plan.md\nnode src/app.ts\n```\n'
    + '`cat docs/plan.md` and docs/plan.md and [docs/plan.md](https://example.com/docs).';
  expect(displayReferences(text, [artifact])).toBe(text);
});

test('visible cards and generated full-response files are rewritten while original attachments stay intact', () => {
  const source = '# File contains /home/alice/example.md';
  const file: UploadFile = { ...artifact, data: Buffer.from(source), size: Buffer.byteLength(source) };
  const delivery = { ...card('Details '.repeat(600) + '\n[Plan](/home/alice/project/docs/plan.md)',
    { title: '/root/private/title.md', subtitle: 'See /etc/host/info.txt', footer: 'Stored in /tmp/state.txt' }),
    artifacts: [file], artifactNotes: ['Missing /home/alice/other.pdf'] };
  const payload = discordPayload(delivery, [file]);
  const wire = JSON.stringify(payload.components);
  for (const path of ['/root/private/title.md', '/etc/host/info.txt', '/tmp/state.txt', '/home/alice/other.pdf']) expect(wire).toContain(path);
  const response = payload.files.find(f => f.name === 'response.md')!;
  expect(Buffer.from(response.attachment as Buffer).toString()).not.toContain('/home/alice');
  expect(Buffer.from(response.attachment as Buffer).toString()).toContain(artifact.name);
  expect(Buffer.from(payload.files.find(f => f.name === artifact.name)!.attachment as Buffer).toString()).toBe(source);
  expect(delivery.file!.content).toContain('/home/alice');
});

test('missing or disabled uploads do not rewrite references from artifact metadata alone', () => {
  const delivery = { content: '[Plan](/home/alice/project/docs/plan.md)', artifacts: [artifact] };
  expect(presentDelivery(delivery).content).toBe(delivery.content);
  const payload = discordPayload(delivery);
  expect(JSON.stringify(payload.components)).toContain(delivery.content);
  expect(payload.files).toHaveLength(0);
});

test.each(['count', 'file bytes', 'total bytes'])('files omitted by %s retain their original references', kind => {
  const first: UploadFile = { ...artifact, data: Buffer.from('Plan') };
  const second: UploadFile = { ...artifact, hash: 'two', name: 'other-renamed.md', references: ['/work/other.md'], size: 8, data: Buffer.alloc(8) };
  const limits = { ...defaultArtifacts, ...(kind === 'count' ? { maxFiles: 1 } : kind === 'file bytes' ? { maxFileBytes: 4 } : { maxTotalBytes: 8 }) };
  const result = prepareUploads({ content: '[Plan](docs/plan.md) [Other](/work/other.md)' }, [first, second], limits);
  expect(result.files.map(f => f.name)).toEqual([first.name]);
  expect(result.delivery.content).toBe('Plan — `plan-12345678-1.md` [Other](/work/other.md)');
  expect(result.delivery.artifactNotes!.length).toBeGreaterThan(0);
});

test('retained attachments support reference replacement and still count against byte limits', () => {
  const retained: UploadFile = { ...artifact, data: Buffer.alloc(0) };
  const delivery = { content: '[Plan](docs/plan.md)' };
  expect(prepareUploads(delivery, [retained]).delivery.content).toBe('Plan — `plan-12345678-1.md`');
  const omitted = prepareUploads(delivery, [retained], { ...defaultArtifacts, maxTotalBytes: 3 });
  expect(omitted.files).toHaveLength(0);
  expect(omitted.delivery.content).toBe(delivery.content);
});

test('generated response files only replace references to files that fit the remaining budget', () => {
  const file: UploadFile = { ...artifact, data: Buffer.from('Plan') };
  const content = '[Plan](docs/plan.md)\n' + 'Details '.repeat(600);
  const delivery = card(content, { title: 'Reply' });
  const limits = { ...defaultArtifacts, maxTotalBytes: Buffer.byteLength(displayReferences(content, [file])) + 2 };
  const result = prepareUploads(delivery, [file], limits);
  expect(result.files.map(f => f.name)).toEqual(['response.md']);
  expect(result.delivery.content).toContain('[Plan](docs/plan.md)');
  expect(result.files[0]!.data.toString()).toBe(content);
});

test('expanded filenames still fit the message limit and overflow contains no original paths', () => {
  const file: UploadFile = { ...artifact, references: ['d/a.md'], data: Buffer.from('Plan') };
  const payload = discordPayload({ content: '`d/a.md` '.repeat(300), artifacts: [file] }, [file]);
  const components = payload.components.flatMap(c => c.toJSON().type === ComponentType.Container
    ? (c.toJSON() as any).components : [c.toJSON()]);
  expect(components.filter(c => c.type === ComponentType.TextDisplay).reduce((n, c) => n + c.content.length, 0)).toBeLessThanOrEqual(4000);
  expect(payload.files.find(f => f.name === 'response.md')).toBeDefined();
  expect(JSON.stringify(payload.components)).not.toContain('d/a.md');
});

test.each([false, true])('approval commands, working directories and full details stay exact (long: %s)', long => {
  const command = "/bin/bash -lc 'npm view astro version engines --json && cat /root/dev/app/AGENTS.local.md'";
  const delivery = approvalDelivery({ token: 'prompt', epoch: 'one', rpcId: '1', threadId: 'thread', channel: 'channel', state: 'pending',
    packet: JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval', params: {
      command, cwd: '/root/dev/app', reason: long ? 'Review this command. '.repeat(300) : 'May npm write its package metadata cache?',
      availableDecisions: ['accept', 'decline'],
    } }) });
  const payload = discordPayload(delivery);
  const wire = JSON.stringify(payload.components);
  expect(wire).toContain('dx:prompt:accept');
  expect(wire).not.toContain('Machine paths are hidden');
  expect(wire).not.toContain('local folder');
  if (long) {
    const fullText = Buffer.from(payload.files[0]!.attachment as Buffer).toString();
    expect(fullText).toBe(delivery.file!.content);
    expect(fullText).toContain(command);
    expect(fullText).toContain('/root/dev/app');
  } else {
    expect(wire).toContain(command);
    expect(wire).toContain('/root/dev/app');
  }
  expect(presentDelivery({ content: command }, [artifact]).content).toBe(command);
});

test('pending approvals saved before the fix regain exact details and their buttons', () => {
  const saved = JSON.parse(JSON.stringify({ content: '`/bin/bash` in `/root/dev/app`', reviewRequired: true,
    buttons: [{ id: 'dx:prompt:accept', label: 'Approve once' }] }));
  const delivery = presentDelivery(saved);
  expect(delivery.content).toBe(saved.content);
  expect(delivery.buttons).toEqual(saved.buttons);
  expect((delivery.artifactNotes ?? []).join()).not.toContain('local Codex client');
});

test('large generated replies and bare renamed filenames are still rewritten', () => {
  const file = { ...artifact, references: ['plan.md', ...artifact.references!] };
  expect(displayReferences('`plan.md`', [file])).toBe('`plan-12345678-1.md`');
  const large = 'a'.repeat(300_000) + '\n[Plan](/home/alice/project/docs/plan.md)\n';
  const displayed = displayReferences(large, [file]);
  expect(displayed).not.toContain('/home/alice');
  expect(displayed).toContain('plan-12345678-1.md');
});
