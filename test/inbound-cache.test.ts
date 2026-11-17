import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultInbound, type InboundConfig } from '../src/config.js';
import { InboundMediaCache, MediaCacheFull } from '../src/inbound-cache.js';
import { Store } from '../src/store.js';

const gif = { extension: 'gif', mimeType: 'image/gif' };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(overrides: Partial<InboundConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'discordex-input-cache-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'state.sqlite');
  const store = new Store(db);
  cleanup.push(() => store.close());
  const limits = { ...defaultInbound, ...overrides };
  return { dir, store, db, cache: new InboundMediaCache(store, dir, limits), limits };
}

test('originals deduplicate by bytes and retry restores the right attachment after restart', async () => {
  const { cache, store, dir, db, limits } = await fixture({ maxCachedFiles: 2 });
  const first = Buffer.from('first original'); const second = Buffer.from('second original');
  const saved = await cache.save('msg', 'first', first, gif);
  const copy = await cache.save('another', 'other-key', first, gif);
  await cache.save('msg', 'second', second, gif);
  expect(saved.path).toBe(copy.path);
  expect((await stat(saved.path)).mode & 0o777).toBe(0o400);
  expect(await readdir(cache.directory)).toHaveLength(2);
  store.db.query('UPDATE inbound_media SET retainedAt = 0').run();
  const restartedStore = new Store(db);
  cleanup.push(() => restartedStore.close());
  const restarted = new InboundMediaCache(restartedStore, dir, limits);
  const before = Date.now();
  const restored = await restarted.lookup('msg', 'first');
  expect(restored?.bytes).toEqual(first);
  expect(restored?.saved.path).toBe(saved.path);
  expect(restored!.saved.retainedUntil).toBeGreaterThanOrEqual(before + limits.retentionDays * 86_400_000);
  expect((await restarted.lookup('msg', 'second'))?.bytes).toEqual(second);
  expect(await restarted.lookup('another', 'first')).toBeUndefined();
  await expect(restarted.save('msg', 'first', second, gif)).rejects.toThrow('changed during retry');
});

test.each([
  { cacheBytes: 8, maxCachedFiles: 9 },
  { cacheBytes: 90, maxCachedFiles: 1 },
])('concurrent unique writes respect original retention and aggregate capacity %#', async limits => {
  const { cache } = await fixture(limits);
  const originals = [Buffer.from('first'), Buffer.from('other')];
  const results = await Promise.allSettled(originals.map((bytes, i) => cache.save('m', String(i), bytes, gif)));
  expect(results[0]!.status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(MediaCacheFull) });
  expect((await cache.lookup('m', '0'))?.bytes).toEqual(originals[0]!);
  expect(await readdir(cache.directory)).toHaveLength(1);
});

test('expiry protects pending inputs and the consuming turn, releasing originals across unrelated active turns', async () => {
  const { cache, store } = await fixture({ maxCachedFiles: 1 });
  const bytes = Buffer.from('animation');
  const saved = await cache.save('id', 'attachment', bytes, gif);
  store.addInput('id', 'thread', saved.path);
  const expire = () => store.db.query('UPDATE inbound_media SET retainedAt = 0').run();
  const setTurn = (id: string, status: string) => store.db.query('INSERT OR REPLACE INTO turn_cards VALUES (?, ?, ?)')
    .run('thread', id, JSON.stringify({ turn: { id, status } }));
  const incoming = () => cache.save('later', 'other', Buffer.from('other'), gif);
  expire();
  await expect(incoming()).rejects.toThrow(MediaCacheFull);
  store.bindInputMediaTurn('id', 'using-original');
  store.inputState('id', 'delivered');
  // Queue consumption renews the lease before the turn/start card has appeared.
  await expect(incoming()).rejects.toThrow(MediaCacheFull);
  setTurn('using-original', 'inProgress');
  expire();
  await expect(incoming()).rejects.toThrow(MediaCacheFull);
  expect(await readFile(saved.path)).toEqual(bytes);
  setTurn('using-original', 'completed');
  setTurn('other-turn', 'inProgress');
  await incoming();
  expect(await cache.lookup('id', 'attachment')).toBeUndefined();
  await expect(stat(saved.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('reconciliation cleans only managed files and a private cache detects changed originals and symlinks', async () => {
  const { cache, dir } = await fixture();
  await mkdir(cache.directory, { mode: 0o700 });
  const temp = 'a'.repeat(64) + '.12345678-1234-4abc-8def-123456789012.tmp';
  const orphan = 'b'.repeat(64) + '.gif';
  for (const name of ['notes.tmp', 'notes.txt', temp, orphan]) await writeFile(join(cache.directory, name), name);
  const bytes = Buffer.from('animation');
  const saved = await cache.save('id', 'key', bytes, gif);
  expect((await readdir(cache.directory)).sort()).toEqual([saved.hash + '.gif', 'notes.tmp', 'notes.txt'].sort());
  await chmod(saved.path, 0o600);
  await writeFile(saved.path, 'corrupted');
  await chmod(saved.path, 0o400);
  expect(await cache.lookup('id', 'key')).toBeUndefined();
  await cache.save('id', 'key', bytes, gif);
  expect((await cache.lookup('id', 'key'))?.bytes).toEqual(bytes);
  const outside = join(dir, 'outside');
  await writeFile(outside, bytes, { mode: 0o400 });
  await unlink(saved.path); await symlink(outside, saved.path);
  expect(await cache.lookup('id', 'key')).toBeUndefined();
  await cache.save('id', 'key', bytes, gif);
  expect((await stat(saved.path)).ino).not.toBe((await stat(outside)).ino);
  expect(await readFile(outside)).toEqual(bytes);
  await chmod(cache.directory, 0o755);
  await expect(cache.lookup('id', 'key')).rejects.toThrow('private directory');
});

test('capacity reconciliation notices externally removed originals', async () => {
  const { cache } = await fixture({ maxCachedFiles: 1 });
  const saved = await cache.save('one', 'original', Buffer.from('one'), gif);
  await expect(cache.save('two', 'original', Buffer.from('two'), gif)).rejects.toThrow(MediaCacheFull);
  await unlink(saved.path);
  await cache.save('two', 'original', Buffer.from('two'), gif);
  expect(await cache.lookup('one', 'original')).toBeUndefined();
  expect((await cache.lookup('two', 'original'))?.bytes).toEqual(Buffer.from('two'));
});
