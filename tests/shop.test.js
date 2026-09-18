'use strict';

/*
 * The Mythic Shop: the summary from the server, how the offers are rendered and
 * buying. A purchase is NEVER sent - the harness blocks writes. Only the request
 * that would be sent is checked, and that the test offer sends nothing.
 * Needs the server and the client.
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
  try { shop = JSON.parse(raw); } catch (_) { /* it stays null */ }
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
    ['state', 'loadLoot', 'loadShop', 'renderShop', 'shopEntries', 'buyOffer', 'purchase', 'countOf',
      'loadCollection', 'openSkinPreview', 'ownsSkin', 'closeDetail']);
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

  // artificial states: owned, and not enough essence
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

  t.section('nahled skinu a chromy');
  const shopSkins = entries.filter((e) => e.kind === 'skin');
  const shopChromas = entries.filter((e) => e.kind === 'chroma');
  t.ok(shopSkins.every((e) => e.skinId > 0 && /uncentered/.test(e.splash || '')), `skiny v obchode maji id a celou kresbu (${shopSkins.length})`);
  t.ok(shopChromas.every((e) => e.chromaId > 0 && e.skinId > 0 && e.skinName), `chromy vedi, na jaky skin patri (${shopChromas.length})`);
  t.ok(shopChromas.every((e) => Math.floor(e.skinId / 1000) === Math.floor(e.chromaId / 1000)), 'chroma a jeji skin maji stejneho sampiona');

  await app.loadCollection();
  app.renderShop();
  const shopHtml = $('#grid-shop').innerHTML;
  t.ok((shopHtml.match(/data-shop-skin="/g) || []).length === shopSkins.length + shopChromas.length, 'skiny i chromy jdou v obchode rozkliknout');

  if (shopChromas.length) {
    const ownedChromas = shopChromas.filter((e) => app.ownsSkin(e.skinId));
    t.info(`chromy: ${ownedChromas.length} k vlastnenym skinum, ${shopChromas.length - ownedChromas.length} k nevlastnenym`);
    t.ok((shopHtml.match(/shop-need is-missing/g) || []).length === shopChromas.length - ownedChromas.length
      && (shopHtml.match(/shop-need is-ok/g) || []).length === ownedChromas.length,
      'u kazde chromy je videt, jestli mas jeji skin');
    const miss = shopChromas.find((e) => !app.ownsSkin(e.skinId));
    if (miss) {
      t.ok(shopHtml.includes(`Needs ${miss.skinName} - you don't own it`), `varovani u "${miss.name}"`);
    }
  }

  const preview = shopSkins.find((e) => !app.ownsSkin(e.skinId)) || shopSkins[0];
  const pctx = await app.openSkinPreview(preview.skinId);
  t.ok(pctx && !$('#detail').hidden && pctx.skinId === preview.skinId, `nahled skinu z obchodu: ${pctx && pctx.name}`);
  t.ok(/uncentered/.test($('#detail-img').dataset.want || $('#detail-img').src), 'cely splash i u skinu, ktery nemas');
  t.ok(env.posts.length === 0, 'nahled nic nezapisuje');
  app.closeDetail();

  if (shopChromas.length) {
    const c = shopChromas[0];
    const cctx = await app.openSkinPreview(c.skinId, c.chromaId);
    await cctx.chromaLoad;
    await new Promise((r) => setTimeout(r, 30));
    t.ok(cctx.chromaView === c.chromaId && $('#detail-art').classList.contains('is-chroma'), `klik na chromu v obchode ukaze ${c.name}`);
    t.ok($('#detail-chromas').innerHTML.includes(`Mythic Shop &middot; ${c.price}`), 'chroma z obchodu ma misto "no longer available" cenu');
    app.closeDetail();
  }

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
