import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Binding, Delivery, GoalCardState, Item, Packet, TokenUsageSnapshot, TurnState } from './types.js';

export interface Outgoing { key: string; channel: string; payload: string; message: string | null; attempts: number; revision: number; generation: number; partial: number }
export type ApprovalState = 'pending' | 'submitted' | 'uncertain' | 'resolved' | 'expired';
export type InputState = 'new' | 'submitting' | 'unknown' | 'queued' | 'delivered';
export interface Approval { token: string; epoch: string; rpcId: string; threadId: string; channel: string; packet: string; state: ApprovalState;
  reviewDelivery?: 'pending' | 'ready' | 'unavailable' }
export interface Input { id: string; threadId: string; text: string; state: InputState; queueId: string | null }

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
        nextAttempt INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 0
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
      CREATE TABLE IF NOT EXISTS artifact_results (id TEXT PRIMARY KEY, deliveryKey TEXT NOT NULL, hash TEXT, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifact_result_delivery ON artifact_results(deliveryKey);
      CREATE TABLE IF NOT EXISTS artifact_blobs (hash TEXT PRIMARY KEY, content BLOB NOT NULL, touchedAt INTEGER NOT NULL);
    `);
    this.db.transaction(() => {
      const additions = [
        ['outbox', 'generation', 'INTEGER NOT NULL DEFAULT 0'], ['outbox', 'blocked', 'INTEGER NOT NULL DEFAULT 0'],
        ['outbox', 'failure', 'TEXT'], ['approvals', 'reviewDelivery', "TEXT NOT NULL DEFAULT 'pending'"],
        ['outbox', 'partial', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [table, column, definition] of additions) {
        if (!this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    })();
  }
  getMeta(key: string): string | null { return this.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  setMeta(key: string, value: string): void { this.db.query('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value); }
  artifactResult(id: string): string | undefined {
    return this.db.query<{ json: string }, [string]>('SELECT json FROM artifact_results WHERE id = ?').get(id)?.json;
  }
  saveArtifactResult(id: string, deliveryKey: string, json: string, hash: string | null = null): void {
    this.db.query('INSERT OR REPLACE INTO artifact_results VALUES (?, ?, ?, ?)').run(id, deliveryKey, hash, json);
  }
  artifactBlob(hash: string): Buffer | undefined {
    const row = this.db.query<{ content: Uint8Array }, [string]>('SELECT content FROM artifact_blobs WHERE hash = ?').get(hash);
    if (!row) return;
    this.db.query('UPDATE artifact_blobs SET touchedAt = ? WHERE hash = ?').run(Date.now(), hash);
    return Buffer.from(row.content);
  }
  private evictArtifact(before: number): boolean {
    const row = this.db.query<{ hash: string }, [number]>(`SELECT hash FROM artifact_blobs WHERE touchedAt < ?
      AND hash NOT IN (SELECT r.hash FROM artifact_results r JOIN outbox o ON o.key = r.deliveryKey
        WHERE o.pending = 1 AND r.hash IS NOT NULL) ORDER BY touchedAt LIMIT 1`).get(before);
    if (!row) return false;
    this.db.query('DELETE FROM artifact_blobs WHERE hash = ?').run(row.hash); return true;
  }
  pruneArtifacts(before: number): void { while (this.evictArtifact(before)) { /* Pending uploads remain pinned. */ } }
  saveArtifact(id: string, deliveryKey: string, json: string, hash: string, data: Buffer, maxBytes: number): boolean {
    return this.db.transaction(() => {
      if (!this.db.query('SELECT 1 FROM artifact_blobs WHERE hash = ?').get(hash)) {
        const used = () => this.db.query<{ bytes: number }, []>('SELECT COALESCE(SUM(length(content)), 0) AS bytes FROM artifact_blobs').get()!.bytes;
        while (used() + data.length > maxBytes) if (!this.evictArtifact(Number.MAX_SAFE_INTEGER)) return false;
        this.db.query('INSERT INTO artifact_blobs VALUES (?, ?, ?)').run(hash, data, Date.now());
      }
      this.saveArtifactResult(id, deliveryKey, json, hash);
      return true;
    })();
  }
  tokenUsage(threadId: string): TokenUsageSnapshot | null {
    const value = this.getMeta(`token-usage:${threadId}`);
    return value ? JSON.parse(value) : null;
  }
  saveTokenUsage(threadId: string, usage: TokenUsageSnapshot): void { this.setMeta(`token-usage:${threadId}`, JSON.stringify(usage)); }
  goalCard(threadId: string): GoalCardState | null {
    const value = this.getMeta(`goal-card:${threadId}`);
    return value ? JSON.parse(value) : null;
  }
  messageId(key: string): string | null {
    return this.db.query<{ message: string | null }, [string]>('SELECT message FROM outbox WHERE key = ?').get(key)?.message ?? null;
  }
  publishGoal(binding: Binding, state: GoalCardState, delivery: Delivery): void {
    this.db.transaction(() => {
      this.setMeta(`goal-card:${binding.threadId}`, JSON.stringify(state));
      this.publishLatest(`goal:${binding.threadId}`, binding.channelId, delivery);
    })();
  }
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
  replaceChannel(previous: string, replacement: string): void {
    this.db.transaction(() => {
      const bindings = this.bindings().filter(b => b.channelId === previous);
      const refresh = new Set<string>();
      for (const binding of bindings) {
        this.saveBinding({ ...binding, channelId: replacement });
        refresh.add(`attached:${binding.threadId}`);
        refresh.add(`goal:${binding.threadId}`);
        const turns = this.db.query<{ turnId: string; json: string }, [string]>('SELECT turnId, json FROM turn_cards WHERE threadId = ?').all(binding.threadId);
        for (const turn of turns) if ((JSON.parse(turn.json) as TurnState).turn.status === 'inProgress') {
          refresh.add(`turn:${binding.threadId}:${turn.turnId}`);
        }
      }
      for (const approval of this.pendingApprovals()) if (approval.channel === previous) refresh.add(`approval:${approval.token}`);
      this.db.query("UPDATE approvals SET channel = ?, reviewDelivery = 'pending' WHERE channel = ?").run(replacement, previous);
      // Keep pending output and current controls, without replaying delivered history.
      this.db.query(`UPDATE outbox SET channel = ?, message = NULL, attempts = 0, nextAttempt = 0,
        revision = revision + 1, generation = generation + 1, blocked = 0, failure = NULL, partial = 0 WHERE channel = ?`).run(replacement, previous);
      for (const key of refresh) this.db.query('UPDATE outbox SET pending = 1 WHERE key = ? AND channel = ?').run(key, replacement);
      this.db.query('DELETE FROM meta WHERE key = ?').run(`inbox-cursor:${previous}`);
    })();
  }
  enqueue(key: string, channel: string, payload: Delivery): void {
    this.db.query('INSERT OR IGNORE INTO outbox (key, channel, payload) VALUES (?, ?, ?)').run(key, channel, JSON.stringify(payload));
  }
  revise(key: string, payload: Delivery): void {
    const json = JSON.stringify(payload);
    this.db.query('UPDATE outbox SET payload = ?, pending = 1, nextAttempt = 0, attempts = 0, blocked = 0, failure = NULL, partial = 0, revision = revision + 1 WHERE key = ? AND payload != ?').run(json, key, json);
  }
  outgoing(): Outgoing[] {
    return this.db.query<Outgoing, [number, number]>(`SELECT * FROM outbox AS o WHERE pending = 1 AND blocked = 0 AND nextAttempt <= ?
      AND NOT EXISTS (SELECT 1 FROM outbox AS prior WHERE prior.channel = o.channel AND prior.rowid < o.rowid AND prior.pending = 1 AND prior.blocked = 0 AND prior.partial = 0 AND prior.nextAttempt > ?)
      ORDER BY rowid LIMIT 50`).all(Date.now(), Date.now());
  }
  delivered(row: Outgoing, message: string, review?: Delivery['approvalReview'], retryAttachments = false): void {
    // A resolution may revise an approval while Discord's send is in flight.
    this.db.transaction(() => {
      this.db.query('UPDATE outbox SET message = ? WHERE key = ? AND channel = ? AND generation = ?')
        .run(message, row.key, row.channel, row.generation);
      if (!this.currentDelivery(row)) return;
      if (review && row.key === `approval:${review.token}`) {
        this.db.query("UPDATE approvals SET reviewDelivery = ? WHERE token = ? AND channel = ? AND state = 'pending'")
          .run(review.state, review.token, row.channel);
      }
      // Text is already visible: retry only the attachments, without holding up
      // later messages in this channel. Keep the original desired payload.
      this.db.query('UPDATE outbox SET pending = ?, partial = ?, attempts = ?, nextAttempt = ? WHERE key = ?')
        .run(retryAttachments ? 1 : 0, retryAttachments ? 1 : 0, retryAttachments ? row.attempts + 1 : 0,
          retryAttachments ? this.retryAt(row) : /^(turn|goal):/.test(row.key) ? Date.now() + 1000 : 0, row.key);
    })();
  }
  private retryAt(row: Outgoing): number { return Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8)); }
  retry(row: Outgoing): void {
    this.db.query('UPDATE outbox SET attempts = attempts + 1, nextAttempt = ? WHERE key = ? AND channel = ? AND generation = ? AND revision = ?')
      .run(this.retryAt(row), row.key, row.channel, row.generation, row.revision);
  }
  blockDelivery(row: Outgoing, reason: string): boolean {
    return this.db.transaction(() => {
      if (!this.currentDelivery(row)) return false;
      this.db.query('UPDATE outbox SET blocked = 1, partial = 0, failure = ? WHERE key = ?').run(reason.slice(0, 1000), row.key);
      if (row.key.startsWith('approval:')) this.db.query("UPDATE approvals SET reviewDelivery = 'unavailable' WHERE token = ? AND state = 'pending'").run(row.key.slice('approval:'.length));
      return true;
    })();
  }
  blockedDeliveries(channel?: string): Outgoing[] {
    return channel ? this.db.query<Outgoing, [string]>('SELECT * FROM outbox WHERE blocked = 1 AND channel = ?').all(channel)
      : this.db.query<Outgoing, []>('SELECT * FROM outbox WHERE blocked = 1').all();
  }
  currentDelivery(row: Outgoing): boolean {
    return Boolean(this.db.query('SELECT 1 FROM outbox WHERE key = ? AND channel = ? AND generation = ? AND revision = ?')
      .get(row.key, row.channel, row.generation, row.revision));
  }
  recreateMessage(row: Outgoing): void {
    this.db.transaction(() => {
      const result = this.db.query(`UPDATE outbox SET message = NULL, pending = 1, attempts = 0, nextAttempt = 0,
        revision = revision + 1, generation = generation + 1, blocked = 0, failure = NULL, partial = 0 WHERE key = ? AND channel = ? AND generation = ?`)
        .run(row.key, row.channel, row.generation);
      if (result.changes && row.key.startsWith('approval:')) this.db.query("UPDATE approvals SET reviewDelivery = 'pending' WHERE token = ? AND state = 'pending'").run(row.key.slice('approval:'.length));
    })();
  }
  approval(token: string): Approval | undefined { return this.db.query<Approval, [string]>('SELECT * FROM approvals WHERE token = ?').get(token) ?? undefined; }
  pendingApprovals(): Approval[] { return this.db.query<Approval, []>("SELECT * FROM approvals WHERE state IN ('pending', 'submitted', 'uncertain')").all(); }
  addApproval(epoch: string, packet: Packet, channel: string): Approval {
    const rpcId = JSON.stringify(packet.id);
    const existing = this.db.query<Approval, [string, string]>('SELECT * FROM approvals WHERE epoch = ? AND rpcId = ?').get(epoch, rpcId);
    if (existing) {
      // A fresh daemon replay is evidence the uncertain request is still pending.
      // Submitted and terminal requests must never be reopened by ordinary item updates.
      if (existing.state === 'uncertain') this.db.query("UPDATE approvals SET state = 'pending', reviewDelivery = 'pending' WHERE token = ?").run(existing.token);
      const old: Packet = JSON.parse(existing.packet);
      for (const field of ['command', 'cwd', 'discordexDiff', 'permissions']) old.params![field] ??= packet.params?.[field];
      this.updateApprovalPacket(existing.token, old);
      return this.approval(existing.token)!;
    }
    const token = crypto.randomUUID();
    this.db.query('INSERT INTO approvals (token, epoch, rpcId, threadId, channel, packet) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, epoch, rpcId, packet.params!.threadId, channel, JSON.stringify(packet));
    return this.approval(token)!;
  }
  updateApprovalPacket(token: string, packet: Packet): boolean {
    const json = JSON.stringify(packet);
    return this.db.query("UPDATE approvals SET packet = ?, reviewDelivery = 'pending' WHERE token = ? AND state = 'pending' AND packet != ?").run(json, token, json).changes > 0;
  }
  approvalState(token: string, state: Exclude<ApprovalState, 'pending'>): boolean {
    const from: Record<Exclude<ApprovalState, 'pending'>, ApprovalState[]> = {
      submitted: ['pending'], uncertain: ['submitted'], resolved: ['pending', 'submitted', 'uncertain'], expired: ['pending', 'submitted', 'uncertain'],
    };
    const current = this.approval(token);
    if (!current || !from[state].includes(current.state)) return false;
    return this.db.query('UPDATE approvals SET state = ? WHERE token = ? AND state = ?').run(state, token, current.state).changes > 0;
  }
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
  inputState(id: string, state: InputState, queueId: string | null = null): void {
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
      this.publishLatest(`turn:${binding.threadId}:${state.turn.id}`, binding.channelId, delivery);
    })();
  }
  private publishLatest(key: string, channelId: string, delivery: Delivery): void {
    // Coalesce edits without resetting rate-limit cooldowns or failure backoff.
    this.db.query(`INSERT INTO outbox (key, channel, payload) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, pending = 1, revision = outbox.revision + 1,
        nextAttempt = CASE WHEN outbox.blocked = 1 OR outbox.partial = 1 THEN 0 ELSE outbox.nextAttempt END,
        attempts = CASE WHEN outbox.partial = 1 THEN 0 ELSE outbox.attempts END, blocked = 0, failure = NULL, partial = 0
      WHERE outbox.payload != excluded.payload`)
      .run(key, channelId, JSON.stringify(delivery));
  }
  close(): void { this.db.close(); }
}
