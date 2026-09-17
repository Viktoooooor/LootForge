'use strict';

/*
 * Quality of life: hvezdicka (chraneny shard), zapamatovany stav UI,
 * upozorneni na novy loot a prubeh se Stopem u "Otevrit vse".
 * Nic se neotevre ani nerozlozi - POST blokuje harness, uspech se podvrhne.
 * Potrebuje server a klienta.
 */

const { createEnv, clientStatus, suite, sleep } = require('./harness');

const t = suite('pohodli');

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  const EXPORTS = [
    'state', 'loadLoot', 'itemsIn', 'visibleIn', 'setFilter', 'cardHtml', 'toggleFavorite', 'isFavorite', 'selectIn',
    'suggestReroll', 'cleanupPlan', 'renderCleanup', 'openCleanup', 'disenchant', 'switchTab', 'setCollection',
    'lootGains', 'openEverything', 'requestStop', 'readStats', 'isOpenable', 'showReveal',
    'setBootPhase', 'bootWaiting', 'setConnected',
  ];
  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], EXPORTS);
  const $ = env.pick;
  env.mem['lootforge.fast'] = '1';
  await app.loadLoot();
  const S = app.state;

  // ------------------------------------------------------ uvodni obrazovka
  t.section('uvodni obrazovka');
  const boot = $('#boot');
  // pripojeno: animace, jmeno, pak zmizi
  for (let i = 0; i < 40 && !boot.hidden; i++) await sleep(100);
  t.ok(boot.hidden && !document.body.classList.contains('boot-open'), 'po pripojeni a nacteni lootu zmizi a pusti rolovani');
  t.ok(/^Welcome, .+/.test($('#boot-name').textContent), `pozdravi hrace: "${$('#boot-name').textContent.replace(/#.*/, '#…')}"`);
  t.ok($('#boot-status').textContent === 'Connected', 'stav Connected');

  // klient odpadl
  app.setConnected(false);
  app.bootWaiting();
  t.ok(!boot.hidden && boot.classList.contains('is-searching') && document.body.classList.contains('boot-open'), 'klient odpadl: obrazovka se vrati (hledani)');
  t.ok($('#boot-hint').hidden, 'prvni vterinu bez rady');
  await sleep(1300);
  t.ok(boot.classList.contains('is-waiting') && !$('#boot-hint').hidden && /Start <b>League of Legends<\/b>/.test($('#boot-hint').innerHTML), 'po chvili: cekani s radou, co udelat');

  app.setBootPhase('stopped');
  t.ok(boot.classList.contains('is-stopped') && /LootForge has stopped/.test($('#boot-status').textContent) && /again/.test($('#boot-hint').innerHTML), 'server neodpovida: stopped s radou');

  await app.loadLoot();
  for (let i = 0; i < 40 && !boot.hidden; i++) await sleep(100);
  t.ok(boot.hidden && !boot.classList.contains('is-stopped'), 'klient zase tu: animace pripojeni a pryc');

  S.busy = true;
  app.bootWaiting();
  t.ok(boot.hidden, 'behem akce (odhaleni) se neukazuje');
  S.busy = false;

  // ------------------------------------------------------------ hvezdicka
  t.section('hvezdicka');
  const realSkins = app.itemsIn('skins').filter((i) => !i.isTest);
  if (realSkins.length < 2) t.skip('test potrebuje aspon 2 skin shardy');
  const star = realSkins[realSkins.length - 1];
  app.toggleFavorite(star.lootId);
  t.ok(app.isFavorite(star.lootId) && JSON.parse(env.mem['lootforge.favorites']).includes(star.lootId), 'hvezdicka se ulozi');
  const card = app.cardHtml(star, 'skins');
  t.ok(/fav-box is-on" data-fav="/.test(card) && /class="card [^"]*is-fav/.test(card), 'karta: zlata hvezdicka a zvyrazneny ramecek');
  t.ok(app.visibleIn('skins')[0] === star, 'oznaceny shard je nahore');
  t.ok(!/data-fav="/.test(app.cardHtml(app.itemsIn('skins').find((i) => i.isTest) || { lootId: 'x', isTest: true, count: 1 }, 'skins')),
    'testovaci polozky hvezdicku nemaji');

  app.selectIn('skins', 'all');
  t.ok(!S.selected.has(star.lootId) && S.selected.size === realSkins.length - 1, 'Select all oznaceny shard vynecha');
  S.selected.clear();

  app.setFilter('skins', 'own', 'fav');
  t.ok(app.visibleIn('skins').length === 1 && app.visibleIn('skins')[0] === star, 'filtr Starred');
  app.setFilter('skins', 'own', '');

  if (realSkins.length >= 4) {
    // shard, ktery by "Suggest 3" jinak vzal nejdriv
    const cheapest = realSkins.slice().sort((a, b) => (b.redeemableStatus === 'ALREADY_OWNED') - (a.redeemableStatus === 'ALREADY_OWNED') || a.disenchantValue - b.disenchantValue)[0];
    app.toggleFavorite(cheapest.lootId);
    app.suggestReroll();
    t.ok(S.selected.size === 3 && !S.selected.has(cheapest.lootId) && !S.selected.has(star.lootId), 'Suggest 3 oznacene nenavrhne');
    app.toggleFavorite(cheapest.lootId);
    S.selected.clear();
  }

  // uklid: umely vlastneny champion shard
  const fake = {
    lootId: 'CHAMPION_RENTAL_9911', type: 'CHAMPION_RENTAL', count: 2, itemDesc: 'POHODLI Champ', rarity: 'DEFAULT',
    disenchantValue: 500, disenchantLootName: 'CURRENCY_champion', redeemableStatus: 'ALREADY_OWNED', itemStatus: 'OWNED',
  };
  S.items.push(fake);
  S.byId.set(fake.lootId, fake);
  S.recipes.set(fake.lootId, [{ type: 'DISENCHANT', recipeName: 'CHAMPION_RENTAL_disenchant', slots: [{ slotNumber: 0, lootIds: [fake.lootId], quantity: 1 }] }]);
  const inPlan = () => app.cleanupPlan().groups.some((g) => g.entries.some((e) => e.item === fake));
  t.ok(inPlan(), 'bez hvezdicky jde do uklidu');
  app.toggleFavorite(fake.lootId);
  t.ok(!inPlan(), 's hvezdickou ho uklid nevezme');
  app.openCleanup();
  t.ok(/2 starred items are protected/.test($('#cleanup-total').innerHTML), 'uklid rekne, kolik je chranenych');

  env.autoConfirm = false;   // jen precist potvrzeni, nic neposilat
  const pending = app.disenchant([star.lootId]);
  await sleep(10);
  t.ok(/^Includes starred: /.test($('#modal-text').textContent), `rucni rozlozeni oznaceneho varuje: "${$('#modal-text').textContent.slice(0, 50)}…"`);
  $('#modal-cancel').onclick();
  await pending;
  env.autoConfirm = true;
  t.ok(env.posts.length === 0, 'nic se neposlalo');
  app.toggleFavorite(star.lootId);
  app.toggleFavorite(fake.lootId);
  t.ok(!app.isFavorite(star.lootId) && JSON.parse(env.mem['lootforge.favorites']).length === 0, 'druhy klik hvezdicku sunda');

  // ------------------------------------------------------------ novy loot
  t.section('upozorneni na novy loot');
  const prev = new Map([['CURRENCY_champion', 100], ['MATERIAL_key', 2]]);
  const gains = app.lootGains(prev, [
    { lootId: 'CURRENCY_champion', type: 'CURRENCY', count: 550 },
    { lootId: 'MATERIAL_key', type: 'MATERIAL', count: 1 },
    { lootId: 'CHEST_1', type: 'CHEST', count: 1, rarity: 'DEFAULT' },
    { lootId: 'TEST_X', type: 'CHEST', count: 1, isTest: true },
  ]);
  t.ok(gains.length === 2 && gains[0].item.lootId === 'CHEST_1' && gains[1].diff === 450, 'jen pribytky, bez testovacich, meny na konci');

  const realFetch = global.fetch;
  let extra = 0;
  global.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (url !== '/lcu/lol-loot/v1/player-loot' || !extra) return res;
    const loot = await res.json();
    const be = loot.find((i) => i.lootId === 'CURRENCY_champion');
    if (be) be.count += extra;
    return { ok: true, status: 200, json: async () => loot, text: async () => JSON.stringify(loot) };
  };
  await app.loadLoot();   // vychozi stav
  $('#toast').textContent = '';
  extra = 450;
  await app.loadLoot();
  t.ok(/^New loot: \+450 Blue Essence/.test($('#toast').textContent), `po hre: "${$('#toast').textContent}"`);
  t.ok(/w-item is-up/.test($('#wallet').innerHTML) && /w-delta">\+450</.test($('#wallet').innerHTML), 'penezenka se rozsviti (+450)');
  const walletHtml = $('#wallet').innerHTML;
  await app.loadLoot();
  t.ok($('#wallet').innerHTML === walletHtml, 'beze zmeny se penezenka nekresli znovu (zablesk dobehne)');

  $('#toast').textContent = '';
  extra = 900;
  await app.loadLoot({ quiet: true });
  t.ok($('#toast').textContent === '', 'po vlastni akci appky se nehlasi (co padlo, bylo videt v odhaleni)');
  extra = 0;
  global.fetch = realFetch;
  await app.loadLoot({ quiet: true });

  // ------------------------------------------------- otevrit vse: prubeh
  t.section('otevrit vse: prubeh a stop');
  const chest = {
    lootId: 'CHEST_9912', type: 'CHEST', count: 12, itemDesc: 'POHODLI Chest', rarity: 'DEFAULT',
    redeemableStatus: 'NOT_REDEEMABLE', itemStatus: 'NONE',
  };
  const withFakeChest = () => {
    // jen umela bedna - skutecne bedny z planu vynechat
    // po nacteni lootu v nem zustava kopie umele bedny (JSON) - i tu pryc
    S.items = S.items.filter((i) => i.lootId !== chest.lootId && !app.isOpenable(i)).concat([chest]);
    S.byId = new Map(S.items.map((i) => [i.lootId, i]));
    S.recipes.set(chest.lootId, [{ type: 'OPEN', recipeName: 'CHEST_9912_OPEN', slots: [{ slotNumber: 0, lootIds: [chest.lootId], quantity: 1 }] }]);
  };
  // obnoveni lootu uprostred smycky: skutecny loot + umela bedna
  global.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (url !== '/lcu/lol-loot/v1/player-loot') return res;
    const loot = (await res.json()).concat([chest]);
    return { ok: true, status: 200, json: async () => loot, text: async () => JSON.stringify(loot) };
  };
  const progress = [];
  env.postResponse = (url) => {
    progress.push($('#reveal-progress-text').textContent);
    const n = Number(/repeat=(\d+)/.exec(url)[1]);
    const body = JSON.stringify({ added: Array.from({ length: n }, (_, k) => ({ playerLoot: { lootId: 'CHAMPION_RENTAL_' + (k + 1), type: 'CHAMPION_RENTAL', itemDesc: 'Champ ' + k, rarity: 'DEFAULT', count: 1 } })) });
    return { ok: true, status: 200, statusText: 'OK', json: async () => JSON.parse(body), text: async () => body };
  };

  withFakeChest();
  env.posts.length = 0;
  const before = app.readStats().opened;
  await app.openEverything();
  const repeats = env.posts.map((u) => Number(/repeat=(\d+)/.exec(u)[1]));
  t.ok(repeats.join() === '5,5,2', `12 beden po davkach: ${repeats.join(' + ')}`);
  t.ok(env.posts.every((u) => /CHEST_9912_OPEN\/craft/.test(u)), 'jen umela bedna');
  t.ok(progress.join('|') === '0 / 12 chests|5 / 12 chests|10 / 12 chests', `prubeh: ${progress.join(' > ')}`);
  t.ok($('#reveal-progress').hidden && $('#reveal-stop').hidden, 'po dokonceni se prubeh i Stop schovaji');
  t.ok(app.readStats().opened - before === 12 && /Opened 12x/.test($('#reveal-title').textContent), 'statistiky: 12 beden');

  withFakeChest();
  env.posts.length = 0;
  env.postResponse = ((inner) => (url) => { app.requestStop(); return inner(url); })(env.postResponse);
  await app.openEverything();
  t.ok(env.posts.length === 1, `Stop behem prvni davky: dalsi uz neodesla (${env.posts.length})`);
  t.ok(/Stopped after 5 of 12 chests/.test($('#reveal-title').textContent), `titulek: "${$('#reveal-title').textContent}"`);
  t.ok($('#reveal-stop').hidden, 'po zastaveni se Stop schova');
  app.showReveal('dalsi');
  t.ok($('#reveal-stop').disabled === false && /Stop after this batch/.test($('#reveal-stop').textContent), 'dalsi odhaleni ma Stop zase pripraveny');

  env.postResponse = null;
  global.fetch = realFetch;

  // druha a treti appka prepisou globalni napodobeniny DOMu - proto az na konci
  // ----------------------------------------------------- zapamatovany stav
  t.section('zapamatovany stav');
  app.setFilter('skins', 'q', 'tohle se neulozi');
  app.setFilter('skins', 'sort', 'value');
  app.setFilter('champs', 'own', 'owned');
  app.setCollection('kind', 'emotes');
  app.switchTab('champs');
  const ui = JSON.parse(env.mem['lootforge.ui']);
  t.ok(ui.tab === 'champs' && ui.filters.skins.sort === 'value' && ui.filters.champs.own === 'owned' && ui.collection.kind === 'emotes', 'tab, filtry a kolekce se ulozi');
  t.ok(!('q' in ui.filters.skins), 'hledany text se neuklada');

  const env2 = createEnv();
  env2.mem['lootforge.ui'] = env.mem['lootforge.ui'];
  const app2 = env2.load(['reel.js', 'simulator.js', 'app.js'], ['state', 'visibleIn']);
  const S2 = app2.state;
  t.ok(S2.scope === 'champs', 'po obnoveni stranky stejny tab');
  t.ok(S2.filters.skins.sort === 'value' && S2.filters.skins.q === '' && S2.filters.champs.own === 'owned', 'filtry zpet, hledani prazdne');
  t.ok(S2.collection.kind === 'emotes', 'kolekce na stejnem druhu');
  const env3 = createEnv();
  env3.mem['lootforge.ui'] = '{"tab":"<script>","filters":{"skins":{"sort":5}},"collection":{"kind":"nesmysl"}}';
  const S3 = env3.load(['reel.js', 'simulator.js', 'app.js'], ['state']).state;
  t.ok(S3.scope === 'chests' && S3.filters.skins.sort === 'rarity' && S3.collection.kind === 'skins', 'poskozeny zaznam se ignoruje');

  await sleep(300);   // boot druhe a treti appky dobehne
  t.done();
})().catch(t.crash);
