import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient, RpcError } from '../src/codex.js';

test('Bun client speaks WebSocket RPC over a Unix socket, including server requests and errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-rpc-')); const path = join(dir, 'codex.sock');
  const received: any[] = [];
  const server = Bun.serve({ unix: path,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('WebSocket required', { status: 400 }); },
    websocket: { message(ws, raw) {
      const packet = JSON.parse(String(raw)); received.push(packet);
      if (packet.method === 'initialize') ws.send(JSON.stringify({ id: packet.id, result: { userAgent: 'test' } }));
      else if (packet.method === 'thread/loaded/list') {
        ws.send(JSON.stringify({ method: 'turn/started', params: { threadId: 't1' } }));
        ws.send(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } }));
        ws.send(JSON.stringify({ id: packet.id, result: { data: ['t1'] } }));
      } else if (packet.method === 'bad') ws.send(JSON.stringify({ id: packet.id, error: { code: -32601, message: 'Unknown method' } }));
    } },
  });
  const client = new CodexClient(path, 1000);
  const notifications: any[] = []; const requests: any[] = [];
  client.on('notification', p => notifications.push(p)); client.on('serverRequest', p => requests.push(p));
  try {
    const ready = new Promise<void>(resolve => client.once('ready', resolve)); client.start(); await ready;
    expect(await client.request('thread/loaded/list')).toEqual({ data: ['t1'] });
    expect(received.slice(0, 3).map(p => p.method)).toEqual(['initialize', 'initialized', 'thread/loaded/list']);
    expect(notifications[0].method).toBe('turn/started');
    expect(requests[0].id).toBe('approval');
    await client.respond('approval', { decision: 'decline' });
    await expect(client.request('bad')).rejects.toBeInstanceOf(RpcError);
    await expect(client.request('never-replied')).rejects.toThrow('outcome may be unknown');
    expect(received.find(p => p.id === 'approval').result).toEqual({ decision: 'decline' });
  } finally { client.stop(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test('disconnect rejects in-flight RPCs and reconnects with a new approval epoch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-reconnect-')); const path = join(dir, 'codex.sock');
  let initializations = 0;
  const server = Bun.serve({ unix: path,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('Upgrade required', { status: 400 }); },
    websocket: { message(ws, raw) {
      const packet = JSON.parse(String(raw));
      if (packet.method === 'initialize') { initializations++; ws.send(JSON.stringify({ id: packet.id, result: {} })); }
      if (packet.method === 'drop') ws.close();
    } },
  });
  const client = new CodexClient(path, 1000);
  try {
    const first = new Promise<void>(resolve => client.once('ready', resolve)); client.start(); await first;
    const oldEpoch = client.epoch;
    const again = new Promise<void>(resolve => client.once('ready', resolve));
    await expect(client.request('drop')).rejects.toThrow('outcome may be unknown');
    await again;
    expect(initializations).toBe(2);
    expect(client.epoch).not.toBe(oldEpoch);
    expect(client.connected).toBe(true);
  } finally { client.stop(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test('immediate stop/start retires the old socket and rejects its pending RPCs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discordex-restart-')); const path = join(dir, 'codex.sock');
  let initializations = 0; let activeSockets = 0; let requests = 0; let disconnections = 0;
  const server = Bun.serve({ unix: path,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('Upgrade required', { status: 400 }); },
    websocket: {
      open() { activeSockets++; }, close() { activeSockets--; },
      message(ws, raw) {
        const packet = JSON.parse(String(raw));
        if (packet.method === 'initialize') { initializations++; ws.send(JSON.stringify({ id: packet.id, result: {} })); }
        else if (packet.method === 'pending') requests++;
        else if (packet.method === 'echo') ws.send(JSON.stringify({ id: packet.id, result: 'replacement' }));
      },
    },
  });
  const client = new CodexClient(path, 3000);
  client.on('disconnected', () => disconnections++);
  try {
    const first = new Promise<void>(resolve => client.once('ready', resolve)); client.start(); await first;
    const oldEpoch = client.epoch;
    const pending = client.request('pending').catch(error => error);
    while (!requests) await Bun.sleep(1);
    const again = new Promise<void>(resolve => client.once('ready', resolve));
    client.stop(); client.start();
    expect((await pending).message).toBe('Codex disconnected; request outcome may be unknown');
    await again;
    expect(client.epoch).not.toBe(oldEpoch);
    // The former socket's close would otherwise schedule a third connection in 500–750 ms.
    await Bun.sleep(1000);
    expect(initializations).toBe(2);
    expect(activeSockets).toBe(1);
    expect(disconnections).toBe(1);
    expect(client.connected).toBe(true);
    expect(await client.request('echo')).toBe('replacement');
    const finalPending = client.request('pending').catch(error => error);
    client.stop();
    expect((await finalPending).message).toBe('Codex disconnected; request outcome may be unknown');
    expect(client.connected).toBe(false);
    expect(disconnections).toBe(2);
    const deadline = Date.now() + 1000;
    while (activeSockets && Date.now() < deadline) await Bun.sleep(1);
    expect(activeSockets).toBe(0);
  } finally { client.stop(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
