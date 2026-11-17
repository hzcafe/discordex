import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Artifacts, artifactUploads } from '../src/artifacts.js';
import { fileReferences } from '../src/file-references.js';
import { defaultArtifacts, type ArtifactConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { turnDelivery } from '../src/render.js';
import { displayReferences } from '../src/references.js';
import type { Binding, Delivery } from '../src/types.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(options: Partial<ArtifactConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-artifacts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.sqlite'));
  cleanup.push(() => store.close());
  const artifacts = new Artifacts(store, { ...defaultArtifacts, ...options });
  const request = (references: string[], key = 'turn:t:1'): Delivery => {
    const delivery = { content: 'Final reply', artifactRequest: { cwd: dir, references } };
    store.enqueue(key, 'channel', delivery); return delivery;
  };
  return { dir, store, artifacts, request };
}

test('Markdown paths support links, images, inline code, spaces and line references without scanning code examples or URLs', () => {
  const text = 'See [plan](<docs/my plan.md:12>) and `plan.md:42:3`, ![screen](output/shot.png), '
    + '[encoded](docs/my%20plan.md#section), [reference][p], `src/app.ts:5`, <https://example.com/leak.png>.\n'
    + '```sh\ncat `private.md`\n![bad](bad.png)\n```\n\n    [bad](also-bad.pdf)\n\n'
    + '[p]: file:///tmp/review.pdf\n'
    + '[unused]: unused.md\n';
  expect(fileReferences(text)).toEqual(['docs/my plan.md', 'plan.md', 'output/shot.png', '/tmp/review.pdf']);
  expect(fileReferences('[x](file://other-host/secret.md) [y](https://example.com/a.md) `*.md` `foo.md\nbar.md`')).toEqual([]);
  expect(fileReferences('[sandbox](sandbox:/mnt/data/plan.md)')).toEqual(['/mnt/data/plan.md']);
});

test('only visible final assistant content contributes references, including references beyond the inline text limit', () => {
  const binding: Binding = { threadId: 't', channelId: 'c', parentThreadId: null, cwd: '/work', label: 'Project', since: 0, initialTurnId: null, checkpoint: null };
  const state = { turn: { id: 'turn', status: 'completed' as const, items: [
    { id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'a'.repeat(5000) + ' [plan](docs/plan.md)' },
    { id: 'b', type: 'agentMessage', phase: 'commentary', text: '`progress.pdf`' },
    { id: 'c', type: 'commandExecution', command: 'cat private.md' },
    { id: 'd', type: 'agentMessage', text: '`blocked.md`', moderation: { moderated: true } },
    { id: 'e', type: 'agentMessage', text: '`unfinished.md`' },
  ] }, completedItemIds: ['a', 'b', 'c', 'd'], lastItemId: 'a' };
  expect(turnDelivery(binding, state).artifactRequest).toEqual({ cwd: '/work', references: ['docs/plan.md'] });
  expect(turnDelivery(binding, { ...state, turn: { ...state.turn, status: 'inProgress' } }).artifactRequest).toBeUndefined();
});

test('file snapshots are immutable across source changes, deletion and database reopen; duplicate references share bytes', async () => {
  const f = fixture();
  await mkdir(join(f.dir, 'docs'));
  await writeFile(join(f.dir, 'docs/plan.md'), '# Original plan');
  const delivery = f.request(['docs/plan.md', './docs/plan.md']);
  const first = await f.artifacts.prepare('turn:t:1', delivery);
  expect(first.artifacts).toHaveLength(1);
  expect(artifactUploads(f.store, first).files[0]!.data.toString()).toBe('# Original plan');
  const hash = first.artifacts![0]!.hash;
  await writeFile(join(f.dir, 'docs/plan.md'), 'Changed');
  const second = await f.artifacts.prepare('turn:t:1', delivery);
  expect(second.artifacts).toEqual(first.artifacts);
  await unlink(join(f.dir, 'docs/plan.md'));
  const reopened = new Store(join(f.dir, 'state.sqlite'));
  try {
    const retry = await new Artifacts(reopened).prepare('turn:t:1', delivery);
    expect(artifactUploads(reopened, retry).files[0]!.data.toString()).toBe('# Original plan');
    expect(retry.artifacts![0]!.hash).toBe(hash);
    reopened.replaceChannel('channel', 'replacement');
    expect(artifactUploads(reopened, await new Artifacts(reopened).prepare('turn:t:1', delivery)).files[0]!.data.toString()).toBe('# Original plan');
  } finally { reopened.close(); }
});

test('sharing roots, credentials and symlinks are checked independently of discovery roots', async () => {
  const f = fixture(); const outside = fixture();
  await writeFile(join(f.dir, 'ok.md'), 'public');
  await writeFile(join(outside.dir, 'outside.md'), 'private');
  await writeFile(join(f.dir, '.env.txt'), 'secret');
  await mkdir(join(f.dir, '.git')); await writeFile(join(f.dir, '.git/notes.md'), 'internal');
  await symlink(join(outside.dir, 'outside.md'), join(f.dir, 'escape.md'));
  await symlink(join(f.dir, '.env.txt'), join(f.dir, 'disguised.md'));
  await symlink(join(f.dir, 'ok.md'), join(f.dir, 'within.md'));
  const delivery = f.request(['ok.md', 'within.md', '.env.txt', '.git/notes.md', 'escape.md', 'disguised.md', join(outside.dir, 'outside.md')]);
  const result = await f.artifacts.prepare('turn:t:1', delivery);
  expect(result.artifacts).toHaveLength(1);
  expect(result.artifactNotes).toHaveLength(5);
  expect(result.artifactNotes!.every(n => n.includes('outside file-sharing permissions'))).toBe(true);
  const explicit = new Artifacts(f.store, { ...defaultArtifacts, roots: [outside.dir] });
  const allowed = await explicit.prepare('turn:t:2', f.request([join(outside.dir, 'outside.md')], 'turn:t:2'));
  expect(artifactUploads(f.store, allowed).files[0]!.data.toString()).toBe('private');
  const revoked = await f.artifacts.prepare('turn:t:2', f.request([join(outside.dir, 'outside.md')], 'turn:t:2'));
  expect(revoked.artifacts).toHaveLength(0);
  await writeFile(join(f.dir, 'auth.json'), '{"token":"private"}');
  await symlink(join(f.dir, 'auth.json'), join(f.dir, 'renamed.md'));
  const renamed = await f.artifacts.prepare('turn:t:3', f.request(['renamed.md'], 'turn:t:3'));
  expect(renamed.artifacts).toHaveLength(0);
  expect(renamed.artifactNotes!.join()).toContain('not a supported document');
});

test('size, count and cache limits preserve the text reply and do not evict pending uploads', async () => {
  const f = fixture({ maxFileBytes: 10, maxTotalBytes: 12, maxFiles: 2, cacheBytes: 12 });
  await writeFile(join(f.dir, 'a.txt'), '12345678');
  await writeFile(join(f.dir, 'b.txt'), 'abcdefgh');
  await writeFile(join(f.dir, 'large.txt'), 'too large to share');
  const first = await f.artifacts.prepare('one', f.request(['a.txt', 'b.txt', 'missing.pdf', 'large.txt'], 'one'));
  expect(first.content).toBe('Final reply'); expect(first.artifacts).toHaveLength(1);
  expect(first.artifactNotes!.some(n => n.includes('unavailable'))).toBe(true);
  expect(first.artifactNotes!.filter(n => n.includes('size limit'))).toHaveLength(2);
  const full = await f.artifacts.prepare('two', f.request(['b.txt'], 'two'));
  expect(full.artifactNotes!.join()).toContain('cache is full');
  f.store.pruneArtifacts(Number.MAX_SAFE_INTEGER);
  expect(f.store.artifactBlob(first.artifacts![0]!.hash)?.toString()).toBe('12345678');
  const row = f.store.outgoing().find(r => r.key === 'one')!; f.store.delivered(row, 'discord-message');
  const third = await f.artifacts.prepare('three', f.request(['b.txt'], 'three'));
  expect(third.artifacts).toHaveLength(1);
  expect(f.store.artifactBlob(first.artifacts![0]!.hash)).toBeUndefined();
  const expired = artifactUploads(f.store, first);
  expect(expired.files).toHaveLength(0); expect(expired.delivery.artifactNotes!.join()).toContain('expired');
  const retained = artifactUploads(f.store, first, [{ ...first.artifacts![0]!, id: 'attachment' }]);
  expect(retained.files).toHaveLength(1);
  const limit = new Artifacts(f.store, { ...defaultArtifacts, maxFiles: 1 });
  const count = await limit.prepare('four', f.request(['a.txt', 'b.txt'], 'four'));
  expect(count.artifactNotes!.join()).toContain('count limit');
  const oversized = await f.artifacts.prepare('five', { ...f.request(['a.txt'], 'five'),
    file: { name: 'response.md', content: 'a'.repeat(20) } });
  expect(oversized.artifacts).toHaveLength(1);
});

test('media previews use file signatures, names cannot collide, and unsupported files stay out', async () => {
  const f = fixture();
  await mkdir(join(f.dir, 'one')); await mkdir(join(f.dir, 'two'));
  await writeFile(join(f.dir, 'one/plan.md'), 'One'); await writeFile(join(f.dir, 'two/plan.md'), 'Two');
  await writeFile(join(f.dir, 'real.png'), Buffer.from([137,80,78,71,13,10,26,10,0]));
  await writeFile(join(f.dir, 'fake.png'), 'plain text');
  await writeFile(join(f.dir, 'demo.mp4'), Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom')]));
  await writeFile(join(f.dir, 'code.ts'), 'export const secret = 1;');
  const artifacts = new Artifacts(f.store, { ...defaultArtifacts, maxFiles: 8 });
  const result = await artifacts.prepare('media', f.request(['one/plan.md', 'two/plan.md', 'real.png', 'fake.png', 'demo.mp4', 'code.ts'], 'media'));
  expect(new Set(result.artifacts!.map(a => a.name)).size).toBe(5);
  expect(result.artifacts!.map(a => a.kind)).toEqual(['file', 'file', 'image', 'file', 'video']);
  expect(displayReferences('[One](one/plan.md) [Two](two/plan.md)', result.artifacts)).toBe(
    `One — \`${result.artifacts![0]!.name}\` Two — \`${result.artifacts![1]!.name}\``);
  const disabled = await new Artifacts(f.store, { ...defaultArtifacts, enabled: false }).prepare('media', f.request(['real.png']));
  expect(disabled.artifacts).toBeUndefined();
});

test('directories and unreadable/missing files are reported without blocking valid files', async () => {
  const f = fixture(); await mkdir(join(f.dir, 'folder.md')); await writeFile(join(f.dir, 'ok.txt'), 'Good');
  const result = await f.artifacts.prepare('turn:t:1', f.request(['folder.md', 'missing.txt', 'ok.txt']));
  expect(result.artifacts).toHaveLength(1);
  expect(result.artifactNotes!.join()).toContain('not a regular file');
  expect(result.artifactNotes!.join()).toContain('unavailable');
});
