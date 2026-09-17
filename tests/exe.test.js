'use strict';

/*
 * LootForge.exe (npm run build). Spusti postavene exe na vlastnim portu a
 * overi, ze bezi samo - bez Node a bez slozky public vedle sebe.
 * Bez dist/LootForge.exe se preskoci. Klienta nepotrebuje.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { suite, sleep, ROOT } = require('./harness');

const t = suite('exe');
const EXE = path.join(ROOT, 'dist', 'LootForge.exe');
const PORT = 4548;
const URL_BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  if (process.platform !== 'win32') t.skip('exe je jen pro Windows');
  if (!fs.existsSync(EXE)) t.skip('dist/LootForge.exe neexistuje - postav ho: npm run build');

  t.section('bez okna konzole');
  const head = fs.readFileSync(EXE).subarray(0, 4096);
  const pe = head.readUInt32LE(0x3c);
  t.ok(head.readUInt16LE(pe + 24 + 68) === 2, 'exe je okenni aplikace (subsystem GUI), konzole se neotevre');

  // kratka doba necinnosti, at jde overit samo-ukonceni
  const proc = spawn(EXE, [], {
    env: { ...process.env, PORT: String(PORT), OPEN_BROWSER: '0', LOOTFORGE_IDLE_EXIT_MS: '1500' },
    stdio: 'ignore', windowsHide: true,
  });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const stop = () => { if (!exited) proc.kill(); };
  process.on('exit', stop);

  try {
    let status = null;
    for (let i = 0; i < 40 && !status && !exited; i++) {
      await sleep(250);
      status = await fetch(URL_BASE + '/api/status').then((r) => r.json()).catch(() => null);
    }

    t.section('spusteni');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    t.ok(!!status, `exe odpovida na ${URL_BASE}`);
    if (!status) return t.done();
    t.ok(status.app && status.app.version === pkg.version, `verze v exe ${status.app && status.app.version} = package.json ${pkg.version}`);

    t.section('soubory zabalene uvnitr');
    const page = await fetch(URL_BASE + '/').then((r) => r.text());
    t.ok(/<title>LootForge<\/title>/.test(page), 'stranka appky');
    let stale = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
      const res = await fetch(`${URL_BASE}/${f}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (!res.ok) t.ok(false, `${f}: ${res.status}`);
      else if (!body.equals(fs.readFileSync(path.join(ROOT, 'public', f)))) stale.push(f);
    }
    t.ok(true, 'vsechny soubory z public/ exe serviruje');
    if (stale.length) t.info(`POZOR: exe je starsi nez zdrojaky (${stale.join(', ')}) - pred vydanim npm run build`);
    else t.ok(true, 'obsah exe odpovida aktualnim zdrojakum');

    t.section('ochrana');
    const trav = await fetch(URL_BASE + '/..%2Fpackage.json');
    t.ok(trav.status === 403, `../ mimo public: ${trav.status}`);
    const missing = await fetch(URL_BASE + '/neexistuje.js');
    t.ok(missing.status === 404, `neexistujici soubor: ${missing.status}`);
    const post = await fetch(URL_BASE + '/lcu/lol-loot/v1/lootforge-test-neexistuje', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '[]' });
    t.ok(post.status === 403, `zapis bez Origin odmitnut i v exe: ${post.status}`);

    t.section('log a samo-ukonceni');
    const logFile = path.join(process.env.LOCALAPPDATA || '', 'LootForge', 'lootforge.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    t.ok(new RegExp(`LOOTFORGE v${pkg.version.replace(/\./g, '\\.')}`).test(log), `vypisy jdou do logu (${logFile})`);

    // "zalozka" = SSE spojeni. Dokud je otevrena, exe bezi.
    const sse = await new Promise((resolve, reject) => {
      const req = http.get(URL_BASE + '/api/events', { headers: { Host: `127.0.0.1:${PORT}` } }, resolve);
      req.on('error', reject);
    });
    await sleep(2500);
    t.ok(!exited, 'se zalozkou otevrenou exe bezi dal (i po limitu necinnosti)');
    sse.destroy();
    for (let i = 0; i < 20 && !exited; i++) await sleep(250);
    t.ok(exited, 'zalozka zavrena -> exe samo skonci');
  } finally {
    stop();
    await sleep(200);
  }
  t.done();
})().catch(t.crash);
