import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Binding, Delivery, Item, Packet, TurnState } from './types.js';

export interface Outgoing { key: string; channel: string; payload: string; message: string | null; attempts: number; revision: number }
export interface Approval { token: string; epoch: string; rpcId: string; threadId: string; channel: string; packet: string; state: string }
export interface Input { id: string; threadId: string; text: string; state: string; queueId: string | null }

export class Store {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (threadId TEXT PRIMARY KEY, channelId TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        key TEXT PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL, message TEXT,
        pending INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
        nextAttempt INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS approvals (
        token TEXT PRIMARY KEY, epoch TEXT NOT NULL, rpcId TEXT NOT NULL, threadId TEXT NOT NULL,
        channel TEXT NOT NULL, packet TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(epoch, rpcId)
      );
      CREATE TABLE IF NOT EXISTS inputs (
        id TEXT PRIMARY KEY, threadId TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'new', queueId TEXT
      );
      CREATE TABLE IF NOT EXISTS items (threadId TEXT, itemId TEXT, json TEXT, PRIMARY KEY(threadId, itemId));
      CREATE TABLE IF NOT EXISTS turn_cards (threadId TEXT, turnId TEXT, json TEXT NOT NULL, PRIMARY KEY(threadId, turnId));
    `);
  }
  getMeta(key: string): string | null { return this.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key: string, value: string): void { this.db.query('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value); }
  claim(context: string): void {
    this.db.transaction(() => {
      const previous = this.getMeta('context');
      if (previous && previous !== context) throw new Error('This state directory belongs to a different Discord channel or Codex socket. Use a separate stateDir.');
      const pid = Number(this.getMeta('pid'));
      if (pid) {
        try { process.kill(pid, 0); throw new Error(`Discordex is already running (PID ${pid})`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      this.setMeta('context', context); this.setMeta('pid', String(process.pid));
    }).immediate();
  }
  release(): void { if (this.getMeta('pid') === String(process.pid)) this.db.query("DELETE FROM meta WHERE key = 'pid'").run(); }
  bindings(): Binding[] { return this.db.query<{ json: string }, []>('SELECT json FROM bindings').all().map(row => JSON.parse(row.json)); }
  binding(id: string): Binding | undefined {
    const row = this.db.query<{ json: string }, [string]>('SELECT json FROM bindings WHERE threadId = ?').get(id);
    return row ? JSON.parse(row.json) : undefined;
  }
  byChannel(channelId: string): Binding | undefined { return this.bindings().find(b => b.channelId === channelId && !b.parentThreadId); }
  saveBinding(binding: Binding): void {
    this.db.query('INSERT OR REPLACE INTO bindings VALUES (?, ?, ?)').run(binding.threadId, binding.channelId, JSON.stringify(binding));
  }
  enqueue(key: string, channel: string, payload: Delivery): void {
    this.db.query('INSERT OR IGNORE INTO outbox (key, channel, payload) VALUES (?, ?, ?)').run(key, channel, JSON.stringify(payload));
  }
  revise(key: string, payload: Delivery): void {
    const json = JSON.stringify(payload);
    this.db.query('UPDATE outbox SET payload = ?, pending = 1, nextAttempt = 0, revision = revision + 1 WHERE key = ? AND payload != ?').run(json, key, json);
  }
  outgoing(): Outgoing[] {
    return this.db.query<Outgoing, [number, number]>(`SELECT * FROM outbox AS o WHERE pending = 1 AND nextAttempt <= ?
      AND NOT EXISTS (SELECT 1 FROM outbox AS prior WHERE prior.channel = o.channel AND prior.rowid < o.rowid AND prior.pending = 1 AND prior.nextAttempt > ?)
      ORDER BY rowid LIMIT 50`).all(Date.now(), Date.now());
  }
  delivered(row: Outgoing, message: string): void {
    // A resolution may revise an approval while Discord's send is in flight.
    this.db.query('UPDATE outbox SET message = ?, pending = CASE WHEN revision = ? THEN 0 ELSE 1 END, attempts = 0, nextAttempt = ? WHERE key = ?')
      .run(message, row.revision, row.key.startsWith('turn:') ? Date.now() + 1000 : 0, row.key);
  }
  retry(row: Outgoing): void {
    this.db.query('UPDATE outbox SET attempts = attempts + 1, nextAttempt = ? WHERE key = ?').run(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8)), row.key);
  }
  approval(token: string): Approval | undefined { return this.db.query<Approval, [string]>('SELECT * FROM approvals WHERE token = ?').get(token) ?? undefined; }
  pendingApprovals(): Approval[] { return this.db.query<Approval, []>("SELECT * FROM approvals WHERE state IN ('pending', 'submitted')").all(); }
  addApproval(epoch: string, packet: Packet, channel: string): Approval {
    const rpcId = JSON.stringify(packet.id);
    const existing = this.db.query<Approval, [string, string]>('SELECT * FROM approvals WHERE epoch = ? AND rpcId = ?').get(epoch, rpcId);
    if (existing) return existing;
    const token = crypto.randomUUID();
    this.db.query('INSERT INTO approvals (token, epoch, rpcId, threadId, channel, packet) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, epoch, rpcId, packet.params!.threadId, channel, JSON.stringify(packet));
    return this.approval(token)!;
  }
  approvalState(token: string, state: string): void { this.db.query('UPDATE approvals SET state = ? WHERE token = ?').run(state, token); }
  resolveApproval(epoch: string, rpcId: unknown): Approval | undefined {
    return this.db.query<Approval, [string, string]>('SELECT * FROM approvals WHERE epoch = ? AND rpcId = ?').get(epoch, JSON.stringify(rpcId)) ?? undefined;
  }
  addInput(id: string, threadId: string, text: string): boolean {
    return this.db.query('INSERT OR IGNORE INTO inputs (id, threadId, text) VALUES (?, ?, ?)').run(id, threadId, text).changes > 0;
  }
  inputs(threadId?: string): Input[] {
    return threadId
      ? this.db.query<Input, [string]>('SELECT * FROM inputs WHERE threadId = ? ORDER BY rowid').all(threadId)
      : this.db.query<Input, []>('SELECT * FROM inputs ORDER BY rowid').all();
  }
  inputState(id: string, state: string, queueId: string | null = null): void {
    this.db.query('UPDATE inputs SET state = ?, queueId = COALESCE(?, queueId) WHERE id = ?').run(state, queueId, id);
  }
  saveItem(threadId: string, item: Item): void { this.db.query('INSERT OR REPLACE INTO items VALUES (?, ?, ?)').run(threadId, item.id, JSON.stringify(item)); }
  item(threadId: string, itemId: string): Item | undefined {
    const row = this.db.query<{ json: string }, [string, string]>('SELECT json FROM items WHERE threadId = ? AND itemId = ?').get(threadId, itemId);
    return row ? JSON.parse(row.json) : undefined;
  }
  turnState(threadId: string, turnId: string): TurnState | undefined {
    const row = this.db.query<{ json: string }, [string, string]>('SELECT json FROM turn_cards WHERE threadId = ? AND turnId = ?').get(threadId, turnId);
    return row ? JSON.parse(row.json) : undefined;
  }
  publishTurn(binding: Binding, state: TurnState, delivery: Delivery): void {
    this.db.transaction(() => {
      this.db.query('INSERT OR REPLACE INTO turn_cards VALUES (?, ?, ?)').run(binding.threadId, state.turn.id, JSON.stringify(state));
      // Coalesce edits without resetting rate-limit cooldowns or failure backoff.
      this.db.query(`INSERT INTO outbox (key, channel, payload) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, pending = 1, revision = outbox.revision + 1
        WHERE outbox.payload != excluded.payload`)
        .run(`turn:${binding.threadId}:${state.turn.id}`, binding.channelId, JSON.stringify(delivery));
    })();
  }
  close(): void { this.db.close(); }
}
