import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { JsonObject, Packet, RequestId } from './types.js';

export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}
export class CodexClient extends EventEmitter {
  private socket?: WebSocket;
  private sequence = 0;
  private stopped = true;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private retryMs = 500;
  private pending = new Map<RequestId, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  connected = false;
  epoch = '';

  constructor(readonly socketPath: string, private timeoutMs = 15_000) { super(); }

  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }
  private connect(): void {
    if (this.stopped || this.socket) return;
    // Codex's control socket carries WebSocket frames, not raw JSONL.
    const ws = new WebSocket(`ws+unix://${this.socketPath}:/`, { handshakeTimeout: this.timeoutMs, maxPayload: 64 * 1024 * 1024 });
    this.socket = ws;
    this.epoch = crypto.randomUUID();
    ws.on('message', data => {
      if (this.socket !== ws) return;
      let packet: Packet;
      try { packet = JSON.parse(data.toString()); }
      catch { ws.close(1002, 'Invalid JSON'); return; }
      if (packet.method) {
        this.emit(packet.id === undefined ? 'notification' : 'serverRequest', packet);
      } else if (packet.id !== undefined) {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(packet.id);
        if (packet.error) pending.reject(new RpcError(packet.error.code, packet.error.message));
        else pending.resolve(packet.result);
      }
    });
    ws.on('error', error => { if (this.socket === ws) this.emit('diagnostic', error.message); });
    ws.on('open', () => {
      if (this.socket !== ws || this.stopped) return;
      void (async () => {
        await this.request('initialize', { clientInfo: { name: 'discordex', title: 'Discordex', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false, requiredHumanApproval: true,
            optOutNotificationMethods: ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
              'rawResponse/completed', 'rawResponseItem/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta',
              'item/fileChange/outputDelta', 'item/plan/delta'] } });
        if (this.stopped || this.socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        await this.write({ method: 'initialized' });
        if (this.stopped || this.socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.connected = true; this.retryMs = 500;
        let alive = true;
        ws.on('pong', () => { alive = true; });
        this.heartbeat = setInterval(() => {
          if (this.socket !== ws || this.stopped) return;
          if (!alive) ws.terminate(); else { alive = false; ws.ping(); }
        }, 30_000);
        this.emit('ready');
      })().catch(error => { if (this.socket === ws) this.emit('diagnostic', String(error)); ws.terminate(); });
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.connected = false;
      clearInterval(this.heartbeat);
      this.rejectPending();
      if (!this.stopped) {
        const epoch = this.epoch;
        this.reconnect = setTimeout(() => { if (this.epoch === epoch) this.connect(); }, this.retryMs + Math.random() * 250);
        this.retryMs = Math.min(this.retryMs * 2, 30_000);
      }
      this.emit('disconnected');
    });
  }
  private write(packet: Packet): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new Error('Codex is disconnected')); return; }
      this.socket.send(JSON.stringify(packet), error => error ? reject(error) : resolve());
    });
  }
  request<T = any>(method: string, params: JsonObject = {}): Promise<T> {
    if (method !== 'initialize' && !this.connected) return Promise.reject(new Error('Codex is disconnected'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; outcome may be unknown`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  async respond(id: RequestId, result: unknown): Promise<void> {
    const socket = this.socket;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.write({ id, result }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex approval response timed out; outcome may be unknown')), this.timeoutMs);
      })]);
    }
    catch (error) {
      // Do not retry a decision with an unknown outcome. Reconnect so Codex can
      // replay requests that are still pending under a fresh connection epoch.
      if (socket && this.socket === socket) socket.terminate();
      throw error;
    } finally { clearTimeout(timer); }
  }
  private rejectPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex disconnected; request outcome may be unknown')); }
    this.pending.clear();
  }
  stop(): void {
    this.stopped = true; this.connected = false; clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    const ws = this.socket;
    this.socket = undefined;
    this.rejectPending();
    ws?.terminate();
    if (ws) this.emit('disconnected');
  }
}
