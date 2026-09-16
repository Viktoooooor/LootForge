#!/usr/bin/env node
'use strict';

/*
 * Spusti vsechny testy:            node tests/run.js
 * Jen nektere (podle nazvu):       node tests/run.js reroll animace
 *
 * Kazdy *.test.js bezi ve vlastnim procesu. Testy, ktere potrebuji bezici
 * server a prihlaseneho klienta, se bez nich preskoci (SKIP), neselzou.
 * Zadny test nesaha na ucet - POST je v harness.js zablokovany.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { clientStatus, EXIT } = require('./harness');

(async () => {
  const filters = process.argv.slice(2);
  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
    .sort();

  if (!files.length) {
    console.log('Zadny test neodpovida filtru:', filters.join(' '));
    process.exit(1);
  }

  const status = await clientStatus();
  console.log('Hextech Gamba - testy');
  console.log(`server: ${status.server ? 'bezi' : 'NEBEZI'} | klient: ${status.client ? 'pripojen' : 'nepripojen'}`);
  if (!status.client) {
    console.log('(testy, ktere potrebuji klienta, se preskoci - spust League a `node server.js`)');
  }

  const results = [];
  for (const f of files) {
    console.log(`\n=== ${f} ===`);
    const t0 = Date.now();
    const run = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
    const code = run.status == null ? EXIT.FAIL : run.status;
    results.push({ f, code, ms: Date.now() - t0 });
  }

  const label = { [EXIT.OK]: 'ok', [EXIT.FAIL]: 'CHYBA', [EXIT.SKIP]: 'preskoceno' };
  console.log('\n========================================');
  for (const r of results) {
    console.log(`${(label[r.code] || 'CHYBA').padEnd(11)} ${r.f.padEnd(24)} ${(r.ms / 1000).toFixed(1)} s`);
  }

  const failed = results.filter((r) => r.code !== EXIT.OK && r.code !== EXIT.SKIP).length;
  const skipped = results.filter((r) => r.code === EXIT.SKIP).length;
  console.log('========================================');
  console.log(failed
    ? `${failed} ze ${results.length} selhalo`
    : `vsechno proslo${skipped ? ` (${skipped} preskoceno)` : ''}`);
  process.exit(failed ? 1 : 0);
})();
