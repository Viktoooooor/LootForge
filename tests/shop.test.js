'use strict';

/*
 * Mythic shop: prehled ze serveru, vykresleni nabidek a nakup.
 * Nakup se NIKDY neodesle - harness zapis blokuje. Overuje se jen, ze by
 * odesel spravny request, a ze testovaci nabidka nic neposle.
 * Potrebuje server a klienta.
 */

const { createEnv, clientStatus, suite, BASE } = require('./harness');

const t = suite('shop');

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  t.section('prehled obchodu ze serveru');
  const res = await fetch(BASE + '/api/mythic-shop');
  const raw = await res.text();
  let shop = null;
  try { shop = JSON.parse(raw); } catch (_) { /* zustane null */ }
  t.ok(res.ok && shop && Array.isArray(shop.stores), `GET /api/mythic-shop: ${res.status}, ${raw.length} B`);
  if (!shop || !shop.stores.length) return t.done();

  t.ok(raw.length < 60000, 'do prohlizece jde maly prehled, ne megabajty dat obchodu');
  const entries = shop.stores.flatMap((s) => s.entries);
  t.info(`${shop.stores.length} rotaci, ${entries.length} nabidek: ${shop.stores.map((s) => `${s.label} (${s.entries.length})`).join(', ')}`);
  t.ok(shop.stores.every((s, i, a) => i === 0 || a[i - 1].order <= s.order), 'rotace serazene (featured napred)');
  t.ok(entries.every((e) => e.storeId && e.catalogEntryId && e.paymentKey && e.price > 0), 'kazda nabidka ma obchod, id, platbu a cenu');
  t.ok(entries.every((e) => /mythic_essence/.test(e.paymentKey)), 'plati se jen mythic esenci');
  const withImg = entries.filter((e) => e.img).length;
  t.ok(withImg / entries.length >= 0.9, `obrazky naparovane: ${withImg}/${entries.length}`);
  const img = entries.find((e) => e.img);
  if (img) {
    const head = await fetch(BASE + '/lcu' + img.img, { method: 'HEAD' });
    t.ok(head.ok, `obrazek se nacte: ${img.name}`);
  }
  const skins = entries.filter((e) => e.kind === 'skin');
  t.ok(!skins.length || skins.every((e) => e.rarity !== 'DEFAULT'), 'skiny maji raritu (drahokam)');

  t.section('vykresleni');
  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'],
    ['state', 'loadLoot', 'loadShop', 'renderShop', 'shopEntries', 'buyOffer', 'purchase', 'countOf']);
  const $ = env.pick;
  env.mem['lootforge.fast'] = '1';
  await app.loadLoot();
  await app.loadShop();
  const S = app.state;

  t.ok(S.shop.stores.length === shop.stores.length + 1, 'nabidky z klienta + testovaci nabidka');
  const html = $('#grid-shop').innerHTML;
  t.ok((html.match(/class="card shop-card/g) || []).length === entries.length + 1, 'karta pro kazdou nabidku');
  t.ok(/Test offer \(simulated\)/.test(html) && /SIMULATED/.test(html), 'testovaci nabidka je zretelne oznacena');
  t.ok(/Mythic Essence/.test($('#shop-balance').innerHTML), 'zustatek esence v hlavicce obchodu');

  // umele stavy: vlastnene a nedostatek esence
  const me = app.countOf('CURRENCY_mythic');
  const fakeStore = { id: 'X', label: 'Kontrola', endTime: new Date(Date.now() + 90000000).toISOString(), entries: [
    { storeId: 'X', catalogEntryId: 'OWNED', name: 'Vlastneny', kind: 'skin', img: '', rarity: 'MYTHIC', price: 1, paymentKey: '0-lol_mythic_essence', owned: true },
    { storeId: 'X', catalogEntryId: 'EXPENSIVE', name: 'Drahy', kind: 'skin', img: '', rarity: 'MYTHIC', price: me + 50, paymentKey: '0-lol_mythic_essence', owned: false },
  ] };
  S.shop.stores = [fakeStore].concat(S.shop.stores);
  app.renderShop();
  const html2 = $('#grid-shop').innerHTML;
  t.ok(/is-owned[\s\S]*?OWNED[\s\S]*?<button disabled>Owned<\/button>/.test(html2), 'vlastnena nabidka: paska OWNED a nejde koupit');
  t.ok(new RegExp(`<button disabled>Need 50 more</button>`).test(html2), 'nedostatek esence: rekne kolik chybi');
  t.ok(/ends in 1 d/.test(html2), 'odpocet konce rotace');

  t.section('nakup - testovaci nabidka');
  await app.buyOffer('TEST_OFFER');
  t.ok(env.posts.length === 0, 'zadny POST');
  const stage = $('#reveal-cards').children[0] && $('#reveal-cards').children[0].children[0];
  t.ok(stage && /unlock-stage/.test(stage.className), 'koupeno = obrad odemknuti (vis, co kupujes)');

  t.section('nakup - ostra nabidka (POST zablokovany)');
  const real = entries.find((e) => !e.owned && e.price <= me) || entries.find((e) => !e.owned);
  env.posts.length = 0; env.postBodies.length = 0;
  let error = null;
  try { await app.purchase(real); } catch (err) { error = err; }
  t.ok(env.posts.length === 1 && env.posts[0] === '/lcu/lol-shoppefront/v1/purchases', `miri na klienta: ${env.posts[0]}`);
  const body = JSON.parse(env.postBodies[0] || '{}');
  t.ok(body.storeId === real.storeId && body.catalogEntryId === real.catalogEntryId, 'telo: obchod a nabidka');
  t.ok(body.quantity === 1 && body.paymentOptions.length === 1 && body.paymentOptions[0] === real.paymentKey, `telo: 1 kus, platba ${body.paymentOptions}`);
  t.ok(!!error, 'kdyz nakup neprojde, appka neohlasi uspech');

  t.done();
})().catch(t.crash);
