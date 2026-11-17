import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { approvalDelivery } from '../src/render.js';

test('existing databases retain delivery state when deletion recovery is enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-store-upgrade-'));
  const path = join(dir, 'state.sqlite');
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE outbox (key TEXT PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL,
    message TEXT, pending INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
    nextAttempt INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);
    INSERT INTO outbox (key, channel, payload, message, attempts, revision)
    VALUES ('reply', 'channel', '{"content":"latest"}', 'original-message', 3, 7);`);
  legacy.close();
  let store: Store | undefined;
  try {
    store = new Store(path);
    const old = store.outgoing()[0]!;
    expect(old).toMatchObject({ message: 'original-message', attempts: 3, revision: 7, generation: 0 });
    store.recreateMessage(old);
    store.delivered(old, 'stale-ack'); store.retry(old);
    expect(store.outgoing()[0]).toMatchObject({ message: null, attempts: 0, generation: 1 });
    store.close(); store = new Store(path);
    expect(store.outgoing()[0]).toMatchObject({ message: null, generation: 1, payload: '{"content":"latest"}' });
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('review receipts, failures and retries cannot overwrite a newer review or replacement channel', () => {
  const store = new Store(':memory:');
  try {
    const packet = { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 't', command: 'git status' } };
    const a = store.addApproval('epoch', packet, 'channel');
    const key = `approval:${a.token}`;
    store.enqueue(key, 'channel', approvalDelivery(a));
    const old = store.outgoing()[0]!;
    store.updateApprovalPacket(a.token, { ...packet, params: { ...packet.params, cwd: '/work' } });
    store.revise(key, approvalDelivery(store.approval(a.token)!));
    store.delivered(old, 'message', { token: a.token, state: 'ready' });
    store.retry(old);
    expect(store.blockDelivery(old, 'stale failure')).toBe(false);
    expect(store.approval(a.token)!.reviewDelivery).toBe('pending');
    const current = store.outgoing()[0]!;
    expect(current.message).toBe('message');
    store.delivered(current, 'message', { token: a.token, state: 'ready' });
    expect(store.approval(a.token)!.reviewDelivery).toBe('ready');
    store.replaceChannel('channel', 'replacement');
    store.delivered(current, 'old-channel-message', { token: a.token, state: 'ready' });
    expect(store.approval(a.token)).toMatchObject({ channel: 'replacement', reviewDelivery: 'pending' });
    const replacement = store.outgoing()[0]!;
    store.recreateMessage(replacement);
    store.delivered(replacement, 'deleted-message', { token: a.token, state: 'ready' });
    expect(store.approval(a.token)!.reviewDelivery).toBe('pending');
  } finally { store.close(); }
});

test('quarantined output survives restart, preserves its payload and does not block later output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-quarantine-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  try {
    store.enqueue('bad', 'channel', { content: 'Preserve this message' });
    store.enqueue('later', 'channel', { content: 'Approval' });
    store.blockDelivery(store.outgoing()[0]!, 'Invalid form body');
    store.close(); store = new Store(path);
    expect(store.outgoing().map(r => r.key)).toEqual(['later']);
    expect(store.blockedDeliveries()[0]!.payload).toContain('Preserve this message');
    store.revise('bad', { content: 'Corrected payload' });
    expect(store.blockedDeliveries()).toHaveLength(0);
    expect(store.outgoing()[0]!.payload).toContain('Corrected payload');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('automatic attachment retries survive restart without blocking the channel or overwriting revised content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-partial-'));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  try {
    store.enqueue('reply', 'channel', { content: 'Summary', file: { name: 'response.md', content: 'Full answer' } });
    const first = store.outgoing()[0]!;
    store.delivered(first, 'original-message', undefined, true);
    store.enqueue('later', 'channel', { content: 'Later approval' });
    store.close(); store = new Store(path);
    expect(store.outgoing().map(r => r.key)).toEqual(['later']);
    expect(store.db.query<{ pending: number; partial: number; attempts: number }, []>("SELECT pending, partial, attempts FROM outbox WHERE key = 'reply'").get())
      .toEqual({ pending: 1, partial: 1, attempts: 1 });
    store.db.query("UPDATE outbox SET nextAttempt = 0 WHERE key = 'reply'").run();
    const retry = store.outgoing()[0]!;
    expect(retry.message).toBe('original-message');
    expect(retry.payload).toContain('Full answer');
    store.revise('reply', { content: 'New reply' });
    store.delivered(retry, 'original-message', undefined, true);
    const newest = store.outgoing()[0]!;
    expect(newest).toMatchObject({ partial: 0, attempts: 0, payload: '{"content":"New reply"}' });
    store.delivered(newest, 'original-message');
    expect(store.outgoing().map(r => r.key)).toEqual(['later']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
