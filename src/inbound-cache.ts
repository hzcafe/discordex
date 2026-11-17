import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultInbound, type InboundConfig } from './config.js';
import type { Store } from './store.js';

export interface OriginalMedia { extension: string; mimeType: string }
export interface SavedMedia extends OriginalMedia { path: string; bytes: number; hash: string; retainedUntil: number }
interface CachedRow { hash: string; extension: string; bytes: number; retainedAt: number }
export class MediaCacheFull extends Error {
  constructor() { super('The original-media cache is full; the original was not saved'); }
}

const types = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
}));
const originalName = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|mp4|mov|webm)$/;
const temporaryName = /^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Immutable files usable by Codex tools; retention outlives queue consumption. */
export class InboundMediaCache {
  readonly directory: string;
  private operations: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private pressureDirectoryMtime?: bigint;
  private directoryInode?: number;
  private directoryDevice?: number;
  private sizes = new Map<string, number>();
  private usedBytes = 0;
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private store: Store, stateDir: string, readonly limits: InboundConfig = defaultInbound) {
    this.directory = join(stateDir, 'inbound-media');
  }
  // Resource slots are handed directly to waiters; there is no polling timer.
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limits.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.running++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running--;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.operations.then(async () => {
      if (!this.initialized) await this.initialize();
      else await this.checkDirectory();
      return operation();
    });
    this.operations = work.catch(() => {});
    return work;
  }

  // A rename precedes the SQLite commit. Reconcile that crash window once per
  // startup. Only the exact names produced by this cache belong to its cleanup.
  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    const registered = new Set(this.store.db.query<CachedRow, []>('SELECT * FROM inbound_media').all()
      .map(row => `${row.hash}.${row.extension}`));
    this.sizes.clear();
    this.usedBytes = 0;
    for await (const entry of await opendir(this.directory)) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!temporaryName.test(name) && !originalName.test(name)) continue;
      const path = join(this.directory, name);
      if (!registered.has(name)) { await unlink(path); continue; }
      const stat = await lstat(path);
      this.sizes.set(name, stat.size);
      this.usedBytes += stat.size;
    }
    this.initialized = true;
  }

  private async checkDirectory(): Promise<void> {
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid!() || (dir.mode & 0o077) !== 0 ||
      (this.directoryInode !== undefined && (dir.ino !== this.directoryInode || dir.dev !== this.directoryDevice))) {
      throw new Error('Original-media cache must be a private directory owned by the service user');
    }
    this.directoryInode = dir.ino;
    this.directoryDevice = dir.dev;
  }

  private hasRoom(bytes: number): boolean {
    return this.usedBytes + bytes <= this.limits.cacheBytes && this.sizes.size < this.limits.maxCachedFiles;
  }

  private async removeFile(name: string): Promise<void> {
    if (!originalName.test(name)) throw new Error('Invalid original-media cache entry');
    await unlink(join(this.directory, name)).catch(error => { if (!missing(error)) throw error; });
    this.usedBytes -= this.sizes.get(name) ?? 0;
    this.sizes.delete(name);
  }

  private async prune(now: number): Promise<void> {
    const cutoff = now - this.limits.retentionDays * 86_400_000;
    const unpinned = `NOT EXISTS (SELECT 1 FROM inbound_media_refs r JOIN inputs i ON i.id = r.inputId
      LEFT JOIN turn_cards t ON t.threadId = i.threadId AND t.turnId = r.turnId
      WHERE r.hash = inbound_media.hash AND (i.state != 'delivered' OR json_extract(t.json, '$.turn.status') = 'inProgress'))`;
    const expired = this.store.db.query<CachedRow, [number]>(
      `SELECT * FROM inbound_media WHERE retainedAt < ? AND ${unpinned}`).all(cutoff);
    for (const row of expired) {
      // Consumption can renew or pin any later row while a prior unlink is pending.
      const removed = this.store.db.transaction(() => {
        const result = this.store.db.query(`DELETE FROM inbound_media WHERE hash = ? AND retainedAt < ? AND ${unpinned}`).run(row.hash, cutoff);
        if (result.changes) this.store.db.query('DELETE FROM inbound_media_refs WHERE hash = ?').run(row.hash);
        return result.changes;
      })();
      if (removed) {
        try { await this.removeFile(`${row.hash}.${row.extension}`); }
        catch (error) { this.initialized = false; throw error; }
      }
    }
  }

  private async verifiedBytes(row: CachedRow): Promise<Buffer | undefined> {
    const name = `${row.hash}.${row.extension}`;
    if (!originalName.test(name) || row.bytes > this.limits.maxFileBytes) return;
    const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(error => { if (!missing(error) && error.code !== 'ELOOP') throw error; });
    if (!file) return;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== row.bytes || stat.nlink !== 1 ||
        stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o400) return;
      const bytes = await file.readFile();
      if (bytes.length === row.bytes && digest(bytes) === row.hash) return bytes;
    } finally { await file.close(); }
  }

  private saved(row: CachedRow): SavedMedia {
    return { extension: row.extension, mimeType: types.get(row.extension)!, hash: row.hash, bytes: row.bytes,
      path: join(this.directory, `${row.hash}.${row.extension}`), retainedUntil: row.retainedAt + this.limits.retentionDays * 86_400_000 };
  }

  lookup(inputId: string, sourceKey: string): Promise<{ saved: SavedMedia; bytes: Buffer } | undefined> {
    return this.serial(async () => {
      const row = this.store.db.query<CachedRow, [string, string]>(`SELECT m.* FROM inbound_media_refs r
        JOIN inbound_media m ON m.hash = r.hash WHERE r.inputId = ? AND r.sourceKey = ?`).get(inputId, sourceKey);
      if (!row) return;
      const bytes = await this.verifiedBytes(row);
      if (!bytes) return;
      row.retainedAt = Date.now();
      this.store.db.query('UPDATE inbound_media SET retainedAt = ? WHERE hash = ?').run(row.retainedAt, row.hash);
      return { saved: this.saved(row), bytes };
    });
  }

  save(inputId: string, sourceKey: string, bytes: Buffer, format: OriginalMedia): Promise<SavedMedia> {
    return this.serial(async () => {
      if (types.get(format.extension) !== format.mimeType || bytes.length > this.limits.maxFileBytes) {
        throw new Error('Unsupported original-media format or size');
      }
      const hash = digest(bytes);
      const attached = this.store.db.query<{ hash: string }, [string, string]>(
        'SELECT hash FROM inbound_media_refs WHERE inputId = ? AND sourceKey = ?').get(inputId, sourceKey);
      if (attached && attached.hash !== hash) throw new Error('Original media changed during retry');
      const known = this.store.db.query<CachedRow, [string]>('SELECT * FROM inbound_media WHERE hash = ?').get(hash);
      if (known && known.extension !== format.extension) throw new Error('Original media has a conflicting file format');
      const row: CachedRow = { hash, extension: format.extension, bytes: bytes.length, retainedAt: Date.now() };
      const name = `${hash}.${format.extension}`;
      const path = join(this.directory, name);
      // An expired but correctly matched original can be renewed without rewriting it.
      const existing = this.sizes.has(name) && await this.verifiedBytes(row);
      if (!existing) {
        await this.prune(row.retainedAt);
        if (this.sizes.has(name)) await this.removeFile(name);
        if (!this.hasRoom(bytes.length)) {
          // An operator may have removed files since startup. Recheck once for
          // each change to the directory while the cache remains full.
          const mtime = (await lstat(this.directory, { bigint: true })).mtimeNs;
          if (mtime !== this.pressureDirectoryMtime) {
            await this.initialize();
            this.pressureDirectoryMtime = mtime;
          }
          if (!this.hasRoom(bytes.length)) throw new MediaCacheFull();
        }
        const temporary = join(this.directory, `${hash}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o400 });
          await rename(temporary, path);
          this.sizes.set(name, bytes.length);
          this.usedBytes += bytes.length;
        } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
      }
      try {
        this.store.db.transaction(() => {
          this.store.db.query(`INSERT INTO inbound_media(hash,extension,bytes,retainedAt) VALUES (?,?,?,?)
            ON CONFLICT(hash) DO UPDATE SET retainedAt = excluded.retainedAt`).run(hash, format.extension, bytes.length, row.retainedAt);
          this.store.db.query('INSERT OR IGNORE INTO inbound_media_refs(inputId,sourceKey,hash) VALUES (?,?,?)').run(inputId, sourceKey, hash);
        })();
      } catch (error) { this.initialized = false; throw error; }
      return this.saved(row);
    });
  }
}
