import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = `${process.platform}-${process.arch}`;
if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(target)) {
  throw new Error(`Unsupported release target: ${target}`);
}
if (process.argv[2] && process.argv[2] !== target) {
  throw new Error(`Expected a ${process.argv[2]} runner, got ${target}`);
}

const name = `discordex-${target}`;
const temp = await mkdtemp(join(tmpdir(), 'discordex-release-'));
const directory = join(temp, name);
try {
  await mkdir(directory);
  // sharp needs its addon and libvips together on disk. Resolve them from
  // beside the installed executable, even when launched from a project folder.
  await Bun.build({
    entrypoints: ['src/cli.ts'],
    target: 'bun',
    compile: { outfile: join(directory, 'discordex'), autoloadDotenv: true },
    plugins: [{
      name: 'packaged-sharp',
      setup(build) {
        build.onLoad({ filter: /[/\\]sharp[/\\]lib[/\\]sharp\.js$/ }, () => ({
          loader: 'js',
          contents: `
            const { dirname, join } = require('node:path');
            process.dlopen(module, join(dirname(process.execPath), 'lib', 'sharp-${target}', 'lib', 'sharp-${target}.node'));
            if (process.platform === 'linux' && process.arch === 'x64' && !module.exports._isUsingX64V2()) {
              throw new Error('sharp requires a CPU with x86-64-v2 support');
            }
          `,
        }));
      },
    }],
  });
  for (const pkg of [`sharp-${target}`, `sharp-libvips-${target}`]) {
    await cp(`node_modules/@img/${pkg}`, join(directory, 'lib', pkg), { recursive: true, dereference: true });
  }
  for (const file of ['README.md', 'docs', '.env.example', 'discordex.config.example.json']) {
    await cp(file, join(directory, file), { recursive: true });
  }
  await mkdir('dist/releases', { recursive: true });
  const archive = resolve('dist/releases', name + '.tar.gz');
  await Bun.$`tar -czf ${archive} -C ${temp} ${name}`;
  console.log(archive);
} finally {
  await rm(temp, { recursive: true, force: true });
}
