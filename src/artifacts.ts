import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultArtifacts, type ArtifactConfig } from './config.js';
import { artifactExtensions } from './file-references.js';
import { Store } from './store.js';
import type { Artifact, Delivery, UploadedFile, UploadFile } from './types.js';

interface Snapshot { artifact?: Artifact; path?: string; note?: string }
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part));
};
const sensitive = (path: string) => path.split('/').some(part =>
  /^(?:\.git|\.ssh|\.aws|\.gnupg|\.azure)$|^\.env(?:$|[.-])|(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?|id_rsa)(?:$|[._-])/i.test(part));
const safeName = (path: string) => basename(path).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-100).replace(/^SPOILER_/i, '') || 'file';
const digest = (input: string | Buffer) => new Bun.CryptoHasher('sha256').update(input).digest('hex');

function kind(path: string, bytes: Buffer): Artifact['kind'] {
  const ext = extname(path).toLowerCase();
  const head = bytes.subarray(0, 32);
  const image = (ext === '.png' && head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    || (['.jpg', '.jpeg'].includes(ext) && head[0] === 255 && head[1] === 216 && head[2] === 255)
    || (ext === '.gif' && /^GIF8[79]a/.test(head.toString('ascii')))
    || (ext === '.webp' && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP')
    || (ext === '.avif' && head.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(head.toString('ascii', 8)));
  if (image) return 'image';
  if ((['.mp4', '.mov'].includes(ext) && head.toString('ascii', 4, 8) === 'ftyp')
    || (ext === '.webm' && head.subarray(0, 4).equals(Buffer.from([26,69,223,163])))) return 'video';
  return 'file';
}

/** Snapshots live in SQLite, independently of the source file and Discord attachment URLs. */
export class Artifacts {
  constructor(private store: Store, private options: ArtifactConfig = defaultArtifacts) {}

  private async snapshot(path: string, roots: string[], limit: number): Promise<{ result: Snapshot; bytes: Buffer }> {
    if (sensitive(path) || !roots.some(root => inside(root, path))) throw new Error('outside file-sharing permissions');
    const canonical = await realpath(path);
    if (sensitive(canonical) || !roots.some(root => inside(root, canonical))) throw new Error('outside file-sharing permissions');
    if (!artifactExtensions.has(extname(canonical).toLowerCase())) throw new Error('target is not a supported document or media file');
    // Nonblocking prevents a swapped FIFO from hanging the bridge. Check the
    // opened descriptor as well, so a parent symlink race cannot escape a root.
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new Error('not a regular file');
      const opened = await realpath(`/proc/self/fd/${file.fd}`);
      if (sensitive(opened) || !roots.some(root => inside(root, opened))) throw new Error('outside file-sharing permissions');
      if (before.size > BigInt(limit)) throw new Error('exceeds the attachment size limit');
      const data = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await file.read(data, length, data.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error('changed while being read');
      }
      const bytes = data.subarray(0, length);
      return { bytes, result: { path: opened, artifact: { hash: digest(bytes), name: safeName(path), size: length, kind: kind(path, bytes) } } };
    } finally { await file.close(); }
  }

  async prepare(deliveryKey: string, delivery: Delivery): Promise<Delivery> {
    const request = delivery.artifactRequest;
    if (!this.options.enabled || !request) return delivery;
    const configured = [request.cwd, ...this.options.roots].map(root => resolve(root));
    const roots = [...configured, ...await Promise.all(configured.map(async root => {
      try { return await realpath(root); } catch { return resolve(root); }
    }))];
    this.store.pruneArtifacts(Date.now() - this.options.retentionDays * 86_400_000);
    const artifacts: Artifact[] = [];
    const notes: string[] = [];
    const hashes = new Set<string>();
    const names = new Set([delivery.file?.name ?? 'response.md']);
    const generatedSize = Buffer.byteLength(delivery.file?.content ?? '');
    // Oversized generated files are omitted by the transport, leaving room for valid referenced files.
    let remaining = this.options.maxTotalBytes - (generatedSize <= this.options.maxFileBytes ? generatedSize : 0);
    for (const reference of request.references.slice(0, 32)) {
      if (!artifactExtensions.has(extname(reference).toLowerCase())) continue;
      const path = resolve(request.cwd, reference.startsWith('~/') ? resolve(homedir(), reference.slice(2)) : reference);
      const label = safeName(path);
      if (artifacts.length >= this.options.maxFiles) { notes.push('Additional files omitted: attachment count limit.'); break; }
      const id = digest(`${deliveryKey}\0${request.cwd}\0${path}`);
      let snapshot: Snapshot;
      const saved = this.store.artifactResult(id);
      if (saved) snapshot = JSON.parse(saved);
      else {
        try {
          const { result, bytes } = await this.snapshot(path, roots, Math.min(this.options.maxFileBytes, Math.max(0, remaining)));
          if (!this.store.saveArtifact(id, deliveryKey, JSON.stringify(result), result.artifact!.hash, bytes, this.options.cacheBytes)) {
            throw new Error('attachment cache is full');
          }
          snapshot = result;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const reason = code === 'ENOENT' || code === 'ENOTDIR' ? 'file is unavailable on this host'
            : code === 'EACCES' || code === 'EPERM' ? 'file is not readable'
            : code ? 'file could not be read' : error instanceof Error ? error.message : 'file could not be read';
          snapshot = { note: `${label}: ${reason}.` };
          this.store.saveArtifactResult(id, deliveryKey, JSON.stringify(snapshot));
        }
      }
      if (snapshot.note) { notes.push(snapshot.note); continue; }
      const snapshotPath = snapshot.path;
      if (!snapshotPath || sensitive(path) || sensitive(snapshotPath) || !roots.some(root => inside(root, path))
        || !roots.some(root => inside(root, snapshotPath))) { notes.push(`${label}: outside file-sharing permissions.`); continue; }
      const artifact = snapshot.artifact!;
      if (hashes.has(artifact.hash)) {
        artifacts.find(a => a.hash === artifact.hash)!.references!.push(reference, path);
        continue;
      }
      if (artifact.size > this.options.maxFileBytes || artifact.size > remaining) { notes.push(`${label}: exceeds the attachment size limit.`); continue; }
      let name = artifact.name;
      for (let suffix = 1; names.has(name); suffix++) {
        name = `${basename(artifact.name, extname(artifact.name))}-${artifact.hash.slice(0, 8)}-${suffix}${extname(artifact.name)}`;
      }
      names.add(name); hashes.add(artifact.hash); remaining -= artifact.size;
      artifacts.push({ ...artifact, name, references: [reference, path] });
    }
    return { ...delivery, artifacts, artifactNotes: [...new Set(notes)] };
  }
}

export function artifactUploads(store: Store, delivery: Delivery, retained: UploadedFile[] = []): { delivery: Delivery; files: UploadFile[] } {
  const files: UploadFile[] = [];
  const notes = [...delivery.artifactNotes ?? []];
  for (const artifact of delivery.artifacts ?? []) {
    if (retained.some(r => r.hash === artifact.hash && r.name === artifact.name)) {
      files.push({ ...artifact, data: Buffer.alloc(0) }); continue;
    }
    const data = store.artifactBlob(artifact.hash);
    if (data) files.push({ ...artifact, data });
    else notes.push(`${artifact.name}: saved attachment has expired.`);
  }
  return { delivery: { ...delivery, artifactNotes: notes }, files };
}
