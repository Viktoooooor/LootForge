'use strict';

/*
 * The server: the inventory fingerprint for live updates, the rewritten cache
 * headers and above all the guard - that nothing but the app itself gets to the
 * proxy.
 *
 * The live probes only POST to a path that does NOT exist in the LCU. If the
 * guard failed, the request would reach the client and get a 404 - nothing
 * happens to the account.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { suite, ROOT, BASE, clientStatus } = require('./harness');

const t = suite('server');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const url = new URL(BASE);
const OUR_ORIGIN = `http://${url.hostname}:${url.port}`;
const HARMLESS = '/lcu/lol-loot/v1/lootforge-test-neexistuje';

/** A raw request - fetch does not allow the Host header to be forged. */
function raw(method, pathname, headers = {}, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: pathname, method,
      headers: { Host: `${url.hostname}:${url.port}`, ...headers },
      timeout: 5000,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  t.section('staticke kontroly');
  t.ok(/\.listen\(PORT,\s*'127\.0\.0\.1'/.test(src), 'posloucha jen na 127.0.0.1');
  t.ok(/if \(!guard\(req, res\)\) return;/.test(src), 'kazdy request projde strazi');
  t.ok(/PUBLIC_DIR \+ path\.sep/.test(src), 'kontrola cesty pocita s oddelovacem (ne jen startsWith)');

  t.section('otisk inventare (zive aktualizace)');
  const m = src.match(/function fingerprint\(loot\) \{[\s\S]*?\n\}/);
  t.ok(!!m, 'funkce fingerprint existuje');
  if (m) {
    const fingerprint = eval('(' + m[0].replace('function fingerprint', 'function') + ')');
    const a = [{ lootId: 'CHEST_224', count: 3 }, { lootId: 'MATERIAL_key', count: 20 }];
    t.ok(fingerprint(a) === fingerprint(a.slice().reverse()), 'jine poradi = zadna zmena');
    t.ok(fingerprint(a) !== fingerprint([{ lootId: 'CHEST_224', count: 2 }, { lootId: 'MATERIAL_key', count: 19 }]), 'otevrena bedna = zmena');
    t.ok(fingerprint(a) !== fingerprint(a.concat([{ lootId: 'CHAMPION_SKIN_RENTAL_1', count: 1 }])), 'pribyl shard = zmena');
    t.ok(fingerprint(a) === fingerprint(a.concat([{ lootId: '', count: 25 }])), 'prazdna polozka bez lootId se ignoruje');
  }

  t.section('zadne stahovani YouTube');
  t.ok(!/youtube|spotlight/i.test(src), 'server nestahuje stranky YouTube (podminky YouTube to zakazuji)');


  t.section('cache obrazku');
  const re = src.match(/const GAME_ASSETS = (\/.*\/i);/);
  t.ok(!!re, 'regex pro assety existuje');
  if (re) {
    const GAME_ASSETS = eval(re[1]);
    t.ok(GAME_ASSETS.test('/lol-game-data/assets/ASSETS/Loot/currency_champion.png'), 'obrazky ze hry se cachuji');
    t.ok(!GAME_ASSETS.test('/lol-loot/v1/player-loot'), 'inventar se necachuje');
  }

  const status = await clientStatus();
  if (!status.server) {
    t.info(`server na ${BASE} nebezi - zive sondy preskoceny`);
    return t.done();
  }

  t.section(`straz na ${BASE} - utoky musi byt odmitnute`);
  const json = { 'Content-Type': 'application/json' };
  const cases = [
    ['cizi web, simple request (text/plain)', 'POST', HARMLESS, { Origin: 'https://zly-web.example', 'Content-Type': 'text/plain' }, 403],
    ['cizi web, JSON', 'POST', HARMLESS, { Origin: 'https://zly-web.example', ...json }, 403],
    ['POST bez Originu', 'POST', HARMLESS, json, 403],
    ['nase stranka, ale text/plain', 'POST', HARMLESS, { Origin: OUR_ORIGIN, 'Content-Type': 'text/plain' }, 415],
    ['preflight OPTIONS z ciziho webu', 'OPTIONS', HARMLESS, { Origin: 'https://zly-web.example' }, 403],
    ['DNS rebinding (cizi Host)', 'GET', '/api/status', { Host: `zly-web.example:${url.port}` }, 403],
    ['../server.js', 'GET', '/..%2fserver.js', {}, 403],
    ['sourozenecka slozka ../public-x/a', 'GET', '/..%2fpublic-x%2fa', {}, 403],
  ];
  for (const [label, method, p, headers, expected] of cases) {
    const code = await raw(method, p, headers, method === 'POST' ? '[1]' : undefined);
    t.ok(code === expected, `${label}: ${code} (ma byt ${expected})`);
  }

  t.section('appka sama musi projit');
  t.ok(await raw('GET', '/') === 200, 'stranka');
  t.ok(await raw('GET', '/api/status', { Host: `localhost:${url.port}` }) === 200, 'localhost jako Host');
  if (status.client) {
    t.ok(await raw('GET', '/lcu/lol-loot/v1/player-loot') === 200, 'inventar pres proxy');
    const own = await raw('POST', HARMLESS, { Origin: OUR_ORIGIN, ...json }, '[1]');
    t.ok(own === 404, `POST z nasi stranky dojde az do klienta (LCU 404 za neexistujici cestu): ${own}`);

    const img = await fetch(BASE + '/lcu/lol-game-data/assets/ASSETS/Loot/currency_champion.png', { method: 'HEAD' }).catch(() => null);
    t.ok(img && /max-age=21600/.test(img.headers.get('cache-control') || ''), `cache obrazku: ${img && img.headers.get('cache-control')}`);
  } else {
    t.info('klient nepripojen - sondy do klienta preskoceny');
  }

  t.done();
})().catch(t.crash);
