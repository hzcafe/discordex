// Replacement for sharp/lib/sharp.js in compiled executables only.
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const target = `${process.platform}-${process.arch}`;
const assets = dirname(Bun.main);
const addon = `sharp-${target}/lib/sharp-${target}.node`;
const vipsDir = `sharp-libvips-${target}/lib`;
const libraries = readdirSync(join(assets, vipsDir)).filter(name => name.startsWith('libvips-cpp.'));
if (!libraries.length) throw new Error('The executable is missing its embedded libvips library');

// The OS loader needs real files in the relative layout recorded in sharp's
// native addon. Once mapped, both Linux and macOS can unlink the files.
const directory = mkdtempSync(join(tmpdir(), 'discordex-sharp-'));
try {
  for (const file of [addon, ...libraries.map(name => join(vipsDir, name))]) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(assets, file)));
  }
  process.dlopen(module, join(directory, addon));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

if (target === 'linux-x64' && !module.exports._isUsingX64V2()) {
  throw new Error('sharp requires a CPU with x86-64-v2 support');
}
