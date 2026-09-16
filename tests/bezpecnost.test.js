'use strict';

/*
 * Nejdulezitejsi test: appka nesmi omylem sahnout na ucet.
 *  - testovaci polozky nikdy nevyrobi POST a nezapisou do statistik
 *  - michani testovacich a ostrych se odmitne
 *  - ostra cesta porad miri na klienta (POST tu zablokuje harness)
 *  - pri vypadku klienta se hromadna akce zastavi hned
 * Potrebuje server a klienta.
 */

const fs = require('fs');
const path = require('path');
const { createEnv, clientStatus, suite, sleep, PUBLIC } = require('./harness');

const t = suite('bezpecnost');

(async () => {
  t.section('staticke kontroly');
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const craftCalls = (src.match(/\/craft\?repeat=/g) || []).length;
  t.ok(craftCalls === 1, `v app.js je jedina cesta ke craftu (${craftCalls})`);
  const craftFn = src.match(/async function craft\([\s\S]*?\n\}/);
  t.ok(craftFn && craftFn[0].indexOf('isTest') > -1 && craftFn[0].indexOf('isTest') < craftFn[0].indexOf('lcu('),
    'craft() odchyti testovaci polozku DRIV, nez cokoliv posle');
  t.ok(/'Content-Type': 'application\/json'/.test(craftFn ? craftFn[0] : ''), 'craft posila JSON (server jiny zapis odmitne)');

  const writes = (src.match(/method: 'POST'/g) || []).length;
  t.ok(writes === 2, `v app.js jsou presne dve zapisove cesty - craft() a purchase() (${writes})`);
  const buyFn = src.match(/async function purchase\([\s\S]*?\n\}/);
  t.ok(buyFn && buyFn[0].indexOf('isTest') > -1 && buyFn[0].indexOf('isTest') < buyFn[0].indexOf('lcu('),
    'purchase() odchyti testovaci nabidku DRIV, nez cokoliv posle');
  t.ok(buyFn && /Failure|failure/.test(buyFn[0]) && /nepotvrdil/.test(buyFn[0]), 'purchase() ceka na vysledek a nehlasi uspech naslepo');

  const status = await clientStatus();
  if (!status.client) t.skip('zbytek potrebuje bezici server a prihlaseneho klienta');

  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'itemsIn', 'disenchant', 'upgrade', 'openTestChest', 'isMixedBatch',
  ]);
  const $ = env.pick;
  env.mem['gamba.fast'] = '1';
  await app.loadLoot();
  const S = app.state;
  const tests = S.items.filter((i) => i.isTest);
  const realSkins = app.itemsIn('skins').filter((i) => !i.isTest);
  const testSkin = app.itemsIn('skins').find((i) => i.isTest);

  t.section('testovaci polozky');
  t.ok(tests.length === 5, `5 testovacich polozek (bedna, 3 skin shardy, champion shard): ${tests.length}`);

  await app.openTestChest(5, false);
  t.ok(env.posts.length === 0, 'testovaci bedna 5x: zadny POST');

  await app.disenchant([testSkin.lootId]);
  t.ok(env.posts.length === 0, 'rozlozeni testovaciho shardu: zadny POST');
  t.ok(/oranzova esence/i.test($('#reveal-cards').children.map((c) => c.children.map((x) => x.innerHTML).join('')).join('')),
    'dostal jsi oranzovou esenci (simulovane)');

  await app.upgrade(testSkin.lootId);
  t.ok(env.posts.length === 0, 'odemknuti testovaciho shardu: zadny POST');
  t.ok(!env.mem['gamba.stats'] && !env.mem['gamba.history'], 'do statistik ani historie nic');

  t.section('michani');
  t.ok(app.isMixedBatch([realSkins[0].lootId, testSkin.lootId]), 'mix se rozpozna');
  $('#toast').textContent = '';
  await app.disenchant([realSkins[0].lootId, testSkin.lootId]);
  t.ok(env.posts.length === 0 && /Nemichej/.test($('#toast').textContent), `odmitnuto: "${$('#toast').textContent}"`);

  t.section('ostra cesta (POST zablokovany harnessem)');
  await app.disenchant([realSkins[0].lootId]);
  t.ok(env.posts.length === 1 && /SKIN_RENTAL_disenchant\/craft/.test(env.posts[0]), `miri na klienta: ${env.posts[0]}`);
  t.ok(!env.mem['gamba.stats'], 'neuspesny craft se do statistik nepocita');

  t.section('vypadek klienta');
  env.posts.length = 0;
  env.postResponse = () => ({
    ok: false, status: 502, statusText: 'Bad Gateway',
    json: async () => ({ error: 'lcu_unreachable' }), text: async () => '',
  });
  await app.disenchant(realSkins.slice(0, 4).map((i) => i.lootId));
  t.ok(env.posts.length === 1, `ctyri shardy, klient odpadl -> zastaveno po ${env.posts.length}. pokusu`);
  t.ok(/prestal odpovidat/.test($('#toast').textContent), `jedna srozumitelna hlaska: "${$('#toast').textContent}"`);
  env.postResponse = null;

  await sleep(50);
  t.done();
})().catch(t.crash);
