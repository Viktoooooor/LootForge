'use strict';

/*
 * The filters in the tabs and the inventory clean up. The rules are checked on
 * artificial items mixed into the real inventory (so it is clear which rule
 * takes what). Disenchanting is NEVER sent - the harness blocks POST and success
 * is only faked. Needs the server and the client.
 */

const { createEnv, clientStatus, suite } = require('./harness');

const t = suite('uklid');

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'itemsIn', 'visibleIn', 'setFilter', 'renderGrid', 'fold',
    'cleanupPlan', 'renderCleanup', 'toggleCleanupRule', 'toggleCleanupSkip', 'openCleanup', 'runCleanup', 'readStats',
  ]);
  const $ = env.pick;
  env.mem['lootforge.fast'] = '1';
  await app.loadLoot();
  const S = app.state;

  t.section('filtry');
  t.ok(app.fold('Kai\'Sa Příšerná') === 'kai\'sa priserna', 'hledani bez diakritiky a velikosti pismen');
  const skins = app.itemsIn('skins');
  t.ok(app.visibleIn('skins').length === skins.length, 'bez filtru je videt vsechno');

  const probe = skins.find((i) => !i.isTest) || skins[0];
  const word = app.fold(probe.itemDesc).split(' ').sort((a, b) => b.length - a.length)[0];
  app.setFilter('skins', 'q', word.toUpperCase());
  const found = app.visibleIn('skins');
  t.ok(found.length >= 1 && found.every((i) => app.fold(i.itemDesc).includes(word)), `hledani "${word}": ${found.length} z ${skins.length}`);
  t.ok(/showing \d+ of \d+/.test($('#fcount-skins').textContent) && !$('#freset-skins').hidden, 'pocet a tlacitko Zrusit filtr');
  app.setFilter('skins', 'q', 'tohle-neexistuje-xyz');
  t.ok(/Nothing matches the filter/.test($('#grid-skins').innerHTML), 'prazdny vysledek ma hlasku');
  app.setFilter('skins', 'q', '');

  app.setFilter('skins', 'own', 'owned');
  t.ok(app.visibleIn('skins').every((i) => i.redeemableStatus === 'ALREADY_OWNED' || i.itemStatus === 'OWNED'), 'jen vlastnene');
  app.setFilter('skins', 'own', 'missing');
  t.ok(app.visibleIn('skins').every((i) => i.redeemableStatus !== 'ALREADY_OWNED' && i.itemStatus !== 'OWNED'), 'jen nevlastnene');
  app.setFilter('skins', 'own', '');

  const rarity = (skins.find((i) => i.rarity && i.rarity !== 'DEFAULT') || {}).rarity || 'EPIC';
  app.setFilter('skins', 'rarity', rarity);
  t.ok(app.visibleIn('skins').every((i) => i.rarity === rarity), `jen rarita ${rarity}`);
  app.setFilter('skins', 'rarity', '');

  app.setFilter('skins', 'sort', 'value');
  const byValue = app.visibleIn('skins').filter((i) => !i.isTest).map((i) => i.disenchantValue * i.count);
  t.ok(byValue.every((v, i) => i === 0 || byValue[i - 1] >= v), 'razeni podle hodnoty esence');
  t.ok(app.visibleIn('skins').slice(-3).every((i) => i.isTest) || !skins.some((i) => i.isTest), 'testovaci polozky vzdycky na konci');
  app.setFilter('skins', 'sort', 'rarity');

  t.section('pravidla uklidu (umele polozky)');
  const fake = (lootId, type, owned, count, value, cur) => {
    const item = {
      lootId, type, count, itemDesc: 'UKLID ' + lootId, rarity: 'DEFAULT', disenchantValue: value, disenchantLootName: cur,
      redeemableStatus: owned ? 'ALREADY_OWNED' : 'REDEEMABLE_RENTAL', itemStatus: owned ? 'OWNED' : 'NONE',
    };
    S.items.push(item);
    S.byId.set(lootId, item);
    S.recipes.set(lootId, [{ type: 'DISENCHANT', recipeName: type + '_disenchant', slots: [{ slotNumber: 0, lootIds: [lootId], quantity: 1 }] }]);
    return item;
  };
  // keep the real inventory out of the rules - only the artificial items are checked
  const realIds = new Set(S.items.map((i) => i.lootId));
  const champOwned = fake('CHAMPION_RENTAL_9901', 'CHAMPION_RENTAL', true, 3, 960, 'CURRENCY_champion');
  const champMissing = fake('CHAMPION_RENTAL_9902', 'CHAMPION_RENTAL', false, 3, 1260, 'CURRENCY_champion');
  const champSingle = fake('CHAMPION_RENTAL_9903', 'CHAMPION_RENTAL', false, 1, 1260, 'CURRENCY_champion');
  const skinOwned = fake('CHAMPION_SKIN_RENTAL_9904', 'SKIN_RENTAL', true, 1, 270, 'CURRENCY_cosmetic');
  const ward = fake('WARD_SKIN_RENTAL_9905', 'WARDSKIN_RENTAL', true, 2, 180, 'CURRENCY_cosmetic');

  const entriesOf = (plan, rule) => plan.groups.find((g) => g.rule.id === rule).entries.filter((e) => !realIds.has(e.item.lootId));
  let plan = app.cleanupPlan();
  t.ok(entriesOf(plan, 'champ-owned').map((e) => e.count).join() === '3', 'shard vlastneneho sampiona: vsechny 3 kusy');
  t.ok(entriesOf(plan, 'champ-extra').length === 1 && entriesOf(plan, 'champ-extra')[0].item === champMissing
    && entriesOf(plan, 'champ-extra')[0].count === 2, 'nevlastneny sampion: 2 ze 3, jeden zustane (jediny kus se nebere)');
  t.ok(entriesOf(plan, 'other-owned')[0].item === ward && entriesOf(plan, 'other-owned')[0].count === 2, 'vlastneny ward do uklidu');
  t.ok(entriesOf(plan, 'skin-owned')[0].item === skinOwned && !plan.groups.find((g) => g.rule.id === 'skin-owned').on,
    'skin shardy maji pravidlo, ale vychozi vypnute (radsi reroll)');
  t.ok(!plan.chosen.some((e) => e.item.isTest), 'testovaci polozky do uklidu nikdy');
  t.ok(!plan.chosen.some((e) => e.item === champSingle), 'posledni kus nevlastneneho sampiona zustane');
  const ids = plan.groups.flatMap((g) => g.entries.map((e) => e.item.lootId));
  t.ok(new Set(ids).size === ids.length, 'pravidla se neprekryvaji - nic se nepocita dvakrat');

  app.toggleCleanupSkip(champOwned.lootId);
  plan = app.cleanupPlan();
  t.ok(!plan.chosen.some((e) => e.item === champOwned), 'klik na polozku ji vynecha');
  app.toggleCleanupSkip(champOwned.lootId);

  app.toggleCleanupRule('skin-owned', true);
  t.ok(JSON.parse(env.mem['lootforge.cleanup'])['skin-owned'] === true, 'volba pravidla se pamatuje');
  plan = app.cleanupPlan();
  t.ok(plan.chosen.some((e) => e.item === skinOwned), 'zapnute pravidlo bere skin shardy');
  app.toggleCleanupRule('skin-owned', false);

  app.openCleanup();
  const html = $('#cleanup-rules').innerHTML;
  t.ok(!$('#cleanup').hidden && /2 of 3/.test(html) && /data-cl-rule="skin-owned"(?! checked)/.test(html), 'okno: "2 z 3" a vypnute pravidlo bez fajfky');
  t.ok(/currency_champion/.test($('#cleanup-total').innerHTML) && !$('#cleanup-go').disabled, 'soucet esence s ikonou, tlacitko odemcene');

  t.section('rozlozeni (POST zablokovany, uspech podvrzeny)');
  // artificial items only, so it is clear exactly what would be sent
  for (const g of app.cleanupPlan().groups) for (const e of g.entries) if (realIds.has(e.item.lootId)) S.cleanup.skip.add(e.item.lootId);
  const before = app.readStats();
  env.postResponse = (url) => {
    const m = /recipes\/([^/]+)\/craft\?repeat=(\d+)/.exec(url);
    const cur = /SKIN|WARD/.test(m[1]) ? 'CURRENCY_cosmetic' : 'CURRENCY_champion';
    const body = JSON.stringify({ added: [{ deltaCount: 100 * Number(m[2]), playerLoot: { lootId: cur, type: 'CURRENCY', itemDesc: 'Esence', count: 1 } }] });
    return { ok: true, status: 200, statusText: 'OK', json: async () => JSON.parse(body), text: async () => body };
  };
  await app.runCleanup();
  env.postResponse = null;

  const sent = env.posts.map((u) => decodeURIComponent(u));
  t.ok(sent.length === 3, `tri crafty (vlastneny sampion, nadbytecne kusy, ward): ${sent.length}`);
  t.ok(sent.some((u) => /CHAMPION_RENTAL_disenchant\/craft\?repeat=3$/.test(u)), 'vlastneny sampion: repeat=3');
  t.ok(sent.some((u) => /CHAMPION_RENTAL_disenchant\/craft\?repeat=2$/.test(u)), 'nadbytecne kusy: repeat=2 (jeden zustane)');
  t.ok(env.postBodies.some((b) => b === JSON.stringify([champMissing.lootId])), 'telo: presne ta polozka');
  t.ok($('#cleanup').hidden, 'okno uklidu se pred rozkladanim zavre');
  const after = app.readStats();
  t.ok(after.disenchanted - before.disenchanted === 7, `do statistik 7 rozlozenych kusu (${after.disenchanted - before.disenchanted})`);
  t.ok((after.gained.CURRENCY_champion || 0) - (before.gained.CURRENCY_champion || 0) === 500, 'a ziskana esence z odpovedi klienta');

  t.done();
})().catch(t.crash);
