import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const name = `discordex-${process.platform}-${process.arch}`;
const archive = resolve('dist/releases', name + '.tar.gz');
const temp = await mkdtemp(join(tmpdir(), 'dx-'));
// macOS temporary directory paths can exceed the Unix socket path limit.
const socketDir = await mkdtemp('/tmp/dx-sock-');
const socket = join(socketDir, 'peer');
try {
  await Bun.$`tar -xzf ${archive} -C ${temp}`;
  const cwd = join(temp, 'project');
  await mkdir(cwd);
  const id = '100000000000000000';
  await Bun.write(join(cwd, 'discordex.config.json'), JSON.stringify({
    guildId: id, channelId: id, allowedUserIds: [id], approverUserIds: [id], socketPath: socket,
  }));
  await Bun.write(join(cwd, '.env'), 'DISCORDEX_DISCORD_TOKEN=smoke-test\n');
  const peer = Bun.serve({
    unix: socket,
    fetch(req, server) { if (!server.upgrade(req)) return new Response('Upgrade required', { status: 400 }); },
    websocket: {
      message(ws, data) {
        const request = JSON.parse(String(data));
        if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, result: {} }));
        if (request.method === 'thread/loaded/list') ws.send(JSON.stringify({ id: request.id, result: { data: ['session'] } }));
      },
    },
  });
  try {
    const output = await Bun.$`${join(temp, name, 'discordex')} doctor`.cwd(cwd)
      .env({ PATH: '/usr/bin:/bin', HOME: cwd }).json();
    if (output.codex !== 'connected' || output.loadedSessions !== 1 || !output.config || !output.discordTokenConfigured) {
      throw new Error('Packaged doctor could not read the config, dotenv file, and test daemon');
    }
    console.log(`Verified ${name} from an extracted release archive`);
  } finally { await peer.stop(true); }
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
}
