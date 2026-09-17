#!/usr/bin/env node
'use strict';

/*
 * Postavi LootForge.exe - jeden soubor, hrac nepotrebuje instalovat Node.js.
 *
 *   node scripts/build-exe.js      (nebo npm run build)
 *
 * Pouziva vestaveny Node "single executable application" (SEA): server.js je
 * hlavni skript, public/ a package.json se zabali jako assety a server je cte
 * pres node:sea (viz readAppFile v server.js). Vysledek:
 *
 *   dist/LootForge.exe
 *   dist/LootForge-<verze>-windows-x64.zip   (exe + README, LICENSE, CHANGELOG)
 *
 * Appka sama zadne zavislosti nema. Jen pri buildu se pres npx stahne nastroj
 * postject (oficialni nastroj Node.js pro vlozeni blobu do exe).
 *
 * Exe bezi bez okna konzole (subsystem GUI); vypisy jdou do
 * %LOCALAPPDATA%\LootForge\lootforge.log a konci samo po zavreni zalozky.
 *
 * Exe neni podepsane - Windows SmartScreen pri prvnim spusteni zobrazi
 * varovani "Windows protected your PC" (More info -> Run anyway).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXE = path.join(DIST, 'LootForge.exe');
const BLOB = path.join(DIST, 'sea-prep.blob');
const CONFIG = path.join(DIST, 'sea-config.json');
const ZIP = path.join(DIST, `LootForge-${pkg.version}-windows-x64.zip`);
// hodnota z dokumentace Node.js pro SEA - postject podle ni najde misto v exe
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) { console.log(`\n> ${msg}`); }

/*
 * Antivirus (Defender) si cerstve zapsane exe na par vterin zamkne ke kontrole.
 * Mazani i baleni do zipu pak spadne na EPERM - chvili pockat a zkusit znovu.
 */
function retry(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return fn(); } catch (err) {
      if (attempt >= 8) throw err;
      console.log(`  ${what}: soubor je zamceny (nejspis antivirus), zkousim znovu za 2 s…`);
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
    }
  }
}

if (process.platform !== 'win32') {
  console.error('Build exe je jen pro Windows (appka zatim podporuje jen Windows klienta).');
  process.exit(1);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Na build je potreba Node.js 20.12+ (assety v SEA), mas ${process.version}.`);
  process.exit(1);
}

step('assety');
const assets = { 'package.json': path.join(ROOT, 'package.json') };
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else assets[path.relative(ROOT, full).split(path.sep).join('/')] = full;
  }
})(path.join(ROOT, 'public'));
console.log(`  ${Object.keys(assets).length} souboru: ${Object.keys(assets).join(', ')}`);

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({
  main: path.join(ROOT, 'server.js'),
  output: BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));

step('blob');
execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], { stdio: 'inherit', cwd: ROOT });

step('kopie node.exe');
retry('smazani stareho exe', () => fs.rmSync(EXE, { force: true }));
fs.copyFileSync(process.execPath, EXE);

step('vlozeni aplikace (postject)');
execFileSync('npx', ['--yes', 'postject@1.0.0-alpha.6', EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE, '--overwrite'],
  { stdio: 'inherit', cwd: ROOT, shell: true });

step('bez okna konzole');
// PE hlavicka: e_lfanew na 0x3C, za podpisem "PE\0\0" (4) a COFF hlavickou (20)
// zacina optional header a v nem je na offsetu 68 Subsystem (2 = GUI, 3 = konzole).
// Stejne u PE32 i PE32+. Exe neni podepsane, takze checksum nikdo nekontroluje.
{
  const buf = fs.readFileSync(EXE);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('LootForge.exe nema PE hlavicku');
  const at = pe + 24 + 68;
  const before = buf.readUInt16LE(at);
  buf.writeUInt16LE(2, at);
  fs.writeFileSync(EXE, buf);
  console.log(`  subsystem ${before} -> 2 (Windows GUI)`);
}

step('zip pro GitHub release');
retry('smazani stareho zipu', () => fs.rmSync(ZIP, { force: true }));
const files = [EXE, ...['README.md', 'LICENSE', 'CHANGELOG.md'].map((f) => path.join(ROOT, f))];
retry('baleni zipu', () => {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Compress-Archive -Path ${files.map((f) => `'${f}'`).join(',')} -DestinationPath '${ZIP}' -Force`], { stdio: 'pipe' });
  // Compress-Archive umi pri zamcenem souboru skoncit "uspesne" s prazdnym zipem
  if (!fs.existsSync(ZIP) || fs.statSync(ZIP).size < fs.statSync(EXE).size / 10) {
    fs.rmSync(ZIP, { force: true });
    throw new Error('zip je prazdny');
  }
});

fs.rmSync(BLOB, { force: true });
fs.rmSync(CONFIG, { force: true });

const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1) + ' MB';
console.log(`\nHotovo:\n  ${path.relative(ROOT, EXE)}  ${mb(EXE)}\n  ${path.relative(ROOT, ZIP)}  ${mb(ZIP)}`);
