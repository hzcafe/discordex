import { expect, test } from 'bun:test';
import { bridgeRunner } from '../src/runner.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(prepare = async () => {}, login = async () => {}, failClose = false) {
  const calls: string[] = [];
  const runner = bridgeRunner(
    { start() { calls.push('codex.start'); }, stop() { calls.push('codex.stop'); } },
    { async login() { calls.push('login'); await login(); calls.push('logged in'); }, async close() { calls.push('discord.close'); if (failClose) throw new Error('close failed'); } },
    { start() { calls.push('bridge.start'); }, async stop() { calls.push('bridge.stop'); } },
    { release() { calls.push('release'); }, close() { calls.push('store.close'); } },
    prepare, () => { calls.push('connect'); },
  );
  return { calls, runner };
}

test('stop during daemon startup closes resources without waiting for the daemon and skips login', async () => {
  const daemon = deferred();
  const { runner, calls } = fixture(() => daemon.promise);
  const starting = runner.start('fake');
  await runner.stop();
  expect(calls).toEqual(['codex.stop', 'discord.close', 'bridge.stop', 'release', 'store.close']);
  daemon.resolve(); await starting;
  expect(calls).not.toContain('login');
  expect(calls).not.toContain('bridge.start');
  expect(calls).not.toContain('codex.start');
});

test('stop during login waits for login before close and never connects or starts services', async () => {
  const login = deferred();
  const { runner, calls } = fixture(undefined, () => login.promise);
  const starting = runner.start('fake');
  await Promise.resolve();
  const stopping = runner.stop();
  expect(runner.stop()).toBe(stopping);
  expect(calls).toEqual(['login']);
  login.resolve(); await starting; await stopping;
  expect(calls).toEqual(['login', 'logged in', 'codex.stop', 'discord.close', 'bridge.stop', 'release', 'store.close']);
});

test('failed cleanup still stops bridge and releases and closes store exactly once', async () => {
  const { runner, calls } = fixture(undefined, undefined, true);
  await runner.start('fake');
  const stopping = runner.stop();
  await expect(stopping).rejects.toThrow('Bridge shutdown failed');
  expect(runner.stop()).toBe(stopping);
  expect(calls).toEqual(['login', 'logged in', 'connect', 'bridge.start', 'codex.start', 'codex.stop', 'discord.close', 'bridge.stop', 'release', 'store.close']);
});
