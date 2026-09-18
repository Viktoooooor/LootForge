#!/usr/bin/env node
'use strict';

/*
 * Builds LootForge.exe - one file, so the player does not have to install Node.js.
 *
 *   node scripts/build-exe.js      (or npm run build)
 *
 * It uses Node's built-in "single executable application" (SEA): server.js is
 * the main script, public/ and package.json are bundled as assets and the server
 * reads them through node:sea (see readAppFile in server.js). The result:
 *
 *   dist/LootForge.exe
 *   dist/LootForge-<version>-windows-x64.zip   (exe + README, LICENSE, CHANGELOG)
 *
 * The app itself has no dependencies. Only the build downloads postject through
 * npx (the official Node.js tool for injecting the blob into the exe).
 *
 * The exe runs without a console window (GUI subsystem); its output goes to
 * %LOCALAPPDATA%\LootForge\lootforge.log and it quits once the tab is closed.
 *
 * The exe is not signed - on the first run Windows SmartScreen shows
 * "Windows protected your PC" (More info -> Run anyway).
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
// the value from the Node.js SEA documentation - postject finds the spot in the exe by it
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) { console.log(`\n> ${msg}`); }

/*
 * A file can be locked for two reasons: the antivirus holds a freshly written
 * exe for a few seconds while it scans it (just wait), or LootForge.exe is
 * running (only the user can close that - so say it instead of retrying eight
 * times in vain).
 */
function running() {
  try {
    return /LootForge\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq LootForge.exe'], { encoding: 'utf8' }));
  } catch (_) { return false; }
}

function retry(what, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return fn(); } catch (err) {
      if (running()) {
        console.error(`\nLootForge.exe prave bezi, proto ho nejde prepsat.\n` +
          `Zavri jeho zalozku v prohlizeci (za chvili skonci sam), nebo ukonci proces, a spust build znovu.\n`);
        process.exit(1);
      }
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
const assets = {
  'package.json': path.join(ROOT, 'package.json'),
  // MIT: the licence text has to travel with the program, so the exe can be shared on its own
  LICENSE: path.join(ROOT, 'LICENSE'),
};
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
// PE header: e_lfanew at 0x3C; after the "PE\0\0" signature (4) and the COFF header (20)
// comes the optional header, whose offset 68 holds Subsystem (2 = GUI, 3 = console).
// The same for PE32 and PE32+. The exe is not signed, so nobody checks the checksum.
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
  // with a locked file Compress-Archive can "succeed" and leave an empty zip
  if (!fs.existsSync(ZIP) || fs.statSync(ZIP).size < fs.statSync(EXE).size / 10) {
    fs.rmSync(ZIP, { force: true });
    throw new Error('zip je prazdny');
  }
});

fs.rmSync(BLOB, { force: true });
fs.rmSync(CONFIG, { force: true });

const mb = (f) => (fs.statSync(f).size / 1048576).toFixed(1) + ' MB';
console.log(`\nHotovo:\n  ${path.relative(ROOT, EXE)}  ${mb(EXE)}\n  ${path.relative(ROOT, ZIP)}  ${mb(ZIP)}`);
