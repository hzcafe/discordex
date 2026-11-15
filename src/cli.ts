#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, defaultSocket } from './config.js';
import { CodexClient } from './codex.js';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { DiscordAdapter } from './discord.js';

async function doctor(): Promise<void> {
  const path = Bun.env.DISCORDEX_CONFIG || 'discordex.config.json';
  const config = existsSync(path) ? await readConfig(path) : undefined;
  const codex = new CodexClient(config?.socketPath ?? defaultSocket(), 5000);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not connect to Codex. Run: codex app-server daemon start')), 7000);
    codex.once('ready', () => { clearTimeout(timer); resolve(); });
  });
  try {
    codex.start(); await ready;
    const result = await codex.request('thread/loaded/list', {});
    console.log(JSON.stringify({ bun: Bun.version, socket: codex.socketPath, codex: 'connected',
      loadedSessions: result.data.length, moreSessions: Boolean(result.nextCursor), config: Boolean(config), discordTokenConfigured: Boolean(Bun.env.DISCORDEX_DISCORD_TOKEN) }, null, 2));
  } finally { codex.stop(); }
}

async function start(): Promise<void> {
  const config = await readConfig();
  const token = Bun.env.DISCORDEX_DISCORD_TOKEN;
  if (!token) throw new Error('Set DISCORDEX_DISCORD_TOKEN in .env or the environment');
  const store = new Store(join(config.stateDir, 'discordex.sqlite'));
  store.claim(JSON.stringify([config.guildId, config.channelId, config.socketPath]));
  const codex = new CodexClient(config.socketPath);
  const discord = new DiscordAdapter(config, store);
  const bridge = new Bridge(config, codex, store, discord);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    codex.stop(); await discord.close(); await bridge.stop(); store.release(); store.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  try {
    if (!existsSync(config.socketPath) && config.socketPath === defaultSocket()) {
      const daemon = Bun.spawn(['codex', 'app-server', 'daemon', 'start'], { stdout: 'inherit', stderr: 'inherit' });
      if (await daemon.exited !== 0) throw new Error('Could not start the shared Codex daemon');
    }
    await discord.login(token);
    discord.connect(bridge); bridge.start(); codex.start();
    codex.on('diagnostic', text => console.error(`Codex: ${text}`));
    codex.on('ready', () => console.log('Discordex connected to Discord and the shared Codex daemon'));
  } catch (error) { await stop(); throw error; }
}

const command = Bun.argv[2] ?? 'help';
try {
  if (command === 'doctor') await doctor();
  else if (command === 'start') await start();
  else console.log('discordex start   Run the Discord bridge\ndiscordex doctor  Check the local Codex connection without sending messages\n\nCopy discordex.config.example.json and .env.example to configure. See README.md.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
