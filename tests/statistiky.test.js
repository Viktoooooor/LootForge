'use strict';

/*
 * Statistiky: zapis po klicich, nacteni stareho formatu, co se pocita z beden
 * a vykresleni. Klienta nepotrebuje - pracuje jen s localStorage napodobeninou.
 * Ze testovaci polozky do statistik nezapisuji, hlida bezpecnost.test.js.
 */

const { createEnv, suite, sleep } = require('./harness');

const t = suite('statistiky');

(async () => {
  const env = createEnv();
  // stary format ze starsi verze appky
  env.mem['lootforge.stats'] = JSON.stringify({ opened: 5, disenchanted: 2 });
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'readStats', 'bumpStats', 'recordChests', 'renderSession', 'kindOf', 'currencyOf', 'rarityChartHtml',
  ]);
  const $ = env.pick;
  await sleep(50);   // boot appky (bez klienta skonci hned)

  t.section('stary format');
  const old = app.readStats();
  t.ok(old.opened === 5 && old.disenchanted === 2, 'puvodni pocty zustaly');
  t.ok(old.rerolls === 0 && typeof old.gained === 'object' && typeof old.rarity === 'object', 'nove polozky maji vychozi hodnotu');

  t.section('druhy dropu');
  const kinds = [
    ['SKIN_RENTAL', 'skin'], ['CHAMPION_SKIN', 'skin'], ['CHAMPION_RENTAL', 'champion'], ['CHAMPION', 'champion'],
    ['CURRENCY', 'currency'], ['WARDSKIN_RENTAL', 'ward'], ['EMOTE', 'emote'], ['SUMMONERICON', 'icon'], ['MATERIAL', 'other'],
  ];
  t.ok(kinds.every(([type, kind]) => app.kindOf({ type }) === kind), 'typy lootu -> druh (ward skin neni skin)');

  t.section('otevreni beden');
  const drops = [
    { type: 'SKIN_RENTAL', rarity: 'EPIC', count: 1, lootId: 'CHAMPION_SKIN_RENTAL_1' },
    { type: 'SKIN_RENTAL', rarity: 'EPIC', count: 1, lootId: 'CHAMPION_SKIN_RENTAL_2' },
    { type: 'SKIN_RENTAL', rarity: 'LEGENDARY', count: 1, lootId: 'CHAMPION_SKIN_RENTAL_3' },
    { type: 'SKIN_RENTAL', rarity: 'DEFAULT', count: 1, lootId: 'CHAMPION_SKIN_RENTAL_4' },
    { type: 'CHAMPION_RENTAL', rarity: 'DEFAULT', count: 1, lootId: 'CHAMPION_RENTAL_110' },
    { type: 'CURRENCY', rarity: 'DEFAULT', count: 450, lootId: 'CURRENCY_champion' },
  ];
  t.ok(JSON.stringify(app.currencyOf(drops)) === '{"CURRENCY_champion":450}', 'esence z dropu');
  app.recordChests('Hextech Chest', 4, drops);
  let s = app.readStats();
  t.ok(s.opened === 9 && s.chests['Hextech Chest'] === 4, `bedny: ${s.opened} celkem, 4x Hextech Chest`);
  t.ok(s.rarity.EPIC === 2 && s.rarity.LEGENDARY === 1 && s.rarity.DEFAULT === 1, 'rarity jen ze skin shardu');
  t.ok(s.kinds.skin === 4 && s.kinds.champion === 1 && s.kinds.currency === 1, 'mena se pocita jako jeden drop, ne 450');
  t.ok(s.gained.CURRENCY_champion === 450, 'esence z beden se pricte');
  t.ok(s.since > 0, 'datum zacatku pocitani');

  t.section('akce');
  app.bumpStats({ disenchanted: 3, gained: { CURRENCY_cosmetic: 1260 } });
  app.bumpStats({ unlocked: 1, spent: { CURRENCY_cosmetic: 1050 } });
  app.bumpStats({ purchases: 1, spent: { CURRENCY_mythic: 125 } });
  app.bumpStats({ rerolls: 1 });
  s = app.readStats();
  t.ok(s.disenchanted === 5 && s.unlocked === 1 && s.purchases === 1 && s.rerolls === 1, 'pocty se prictou');
  t.ok(s.gained.CURRENCY_champion === 450 && s.gained.CURRENCY_cosmetic === 1260, 'objekty se prictou po klicich');
  t.ok(s.spent.CURRENCY_cosmetic === 1050 && s.spent.CURRENCY_mythic === 125, 'utracena esence');

  t.section('vykresleni');
  app.renderSession();
  const tiles = $('#stats').innerHTML;
  t.ok(/<b>9<\/b><span>chests opened/.test(tiles), 'dlazdice: bedny');
  t.ok(/0\.44 per chest/.test(tiles), 'skin shardu na bednu (4 / 9)');
  t.ok(/1,260/.test(tiles) && /Mythic_Essence/.test(tiles), 'tok esence s ikonami');
  const charts = $('#stats-charts').innerHTML;
  t.ok(/Skin shard rarity <span>4<\/span>/.test(charts), 'graf rarit');
  t.ok(/epic <b>2<\/b> <em>50%<\/em>/.test(charts) && /legendary <b>1<\/b> <em>25%<\/em>/.test(charts), 'procenta rarit');
  t.ok(/flex-grow:2/.test(charts), 'pruh rarit je pomerny');
  t.ok(/What chests drop/.test(charts) && /Chests opened/.test(charts) && /Hextech Chest/.test(charts), 'grafy druhu a beden');
  t.ok(app.rarityChartHtml({}) === '', 'bez dat zadny prazdny graf');
  t.ok(/counted since/.test($('#stats-since').textContent), 'od kdy se pocita');

  t.done();
})().catch(t.crash);
