import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test('configuration requires explicit identities and rejects approvers outside the contributor list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-config-')); dirs.push(dir);
  const path = join(dir, 'config.json');
  const value = { guildId: '100000000000000001', channelId: '100000000000000002', allowedUserIds: ['100000000000000003'], approverUserIds: ['100000000000000004'] };
  await Bun.write(path, JSON.stringify(value));
  await expect(readConfig(path)).rejects.toThrow('Every approver');
  value.approverUserIds = [...value.allowedUserIds];
  await Bun.write(path, JSON.stringify(value));
  expect((await readConfig(path)).autoDiscover).toBe(true);
  await Bun.write(path, JSON.stringify({ ...value, verbosity: 'quiet' }));
  expect('verbosity' in await readConfig(path)).toBe(false); // Old settings are harmless.
  await Bun.write(path, JSON.stringify({ ...value, projectRoots: ['relative/path'] }));
  await expect(readConfig(path)).rejects.toThrow('absolute paths');
});

test('a state directory cannot be used by two runners or silently reassigned to another bot channel', () => {
  const store = new Store(':memory:');
  try {
    store.claim('guild/channel/socket');
    expect(() => store.claim('guild/channel/socket')).toThrow('already running');
    store.release();
    expect(() => store.claim('different/channel/socket')).toThrow('different Discord channel');
    store.claim('guild/channel/socket'); store.release();
  } finally { store.close(); }
});
