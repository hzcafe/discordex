import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
const outputDir = resolve('dist/releases');
try {
  await mkdir(directory);
  await mkdir(outputDir, { recursive: true });
  const binary = join(outputDir, name);
  await Bun.build({
    entrypoints: ['src/cli.ts'],
    target: 'bun',
    compile: {
      outfile: binary,
      autoloadDotenv: true,
      assets: [`node_modules/@img/sharp-${target}`, `node_modules/@img/sharp-libvips-${target}`],
    },
    plugins: [{
      name: 'packaged-sharp',
      setup(build) {
        build.onLoad({ filter: /[/\\]sharp[/\\]lib[/\\]sharp\.js$/ }, async () => ({
          loader: 'js',
          contents: await Bun.file(new URL('./packaged-sharp.cjs', import.meta.url)).text(),
        }));
      },
    }],
  });
  await copyFile(binary, join(directory, 'discordex'));
  for (const file of ['README.md', 'docs', '.env.example', 'discordex.config.example.json']) {
    await cp(file, join(directory, file), { recursive: true });
  }
  const archive = join(outputDir, name + '.tar.gz');
  await Bun.$`tar -czf ${archive} -C ${temp} ${name}`;
  console.log(binary, archive);
} finally {
  await rm(temp, { recursive: true, force: true });
}
