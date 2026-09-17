'use strict';

/*
 * Rezim rerollu na skutecnem inventari: zasobnik, pojistky vyberu, navrh
 * a reroll testovacich shardu. Animaci samotnou testuje animace.test.js.
 * Potrebuje server a klienta.
 */

const { createEnv, clientStatus, suite } = require('./harness');

const t = suite('reroll');

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'itemsIn', 'cardHtml', 'toggleSelect', 'setRerollMode',
    'suggestReroll', 'rerollSelected', 'alreadyOwned',
  ]);
  const $ = env.pick;
  env.mem['lootforge.fast'] = '1';
  await app.loadLoot();
  const S = app.state;
  const skins = app.itemsIn('skins');
  const real = skins.filter((i) => !i.isTest);
  const tests = skins.filter((i) => i.isTest);

  if (real.length < 4) t.skip(`na ucte jsou jen ${real.length} skin shardy, test jich potrebuje 4`);
  t.info(`inventar: ${real.length} ostrych skin shardu, ${tests.length} testovacich`);

  t.section('zasobnik');
  t.ok(skins.every((i) => app.cardHtml(i, 'skins').includes('data-rr="1"')), 'skin shardy jsou oznacene jako rerollovatelne');
  app.setRerollMode(true);
  t.ok(S.rerollMode && document.body.classList.contains('rr-on'), 'rezim zapnuty');
  t.ok(!$('#rr-tray').hidden && $('#actionbar').hidden, 'zasobnik videt, bezna lista schovana');
  t.ok($('#rr-go').disabled, 'Rerollnout zamcene pri 0/3');

  app.toggleSelect(real[0].lootId);
  app.toggleSelect(real[1].lootId);
  t.ok(/Pick 1 more skin shard/.test($('#rr-hint').textContent), `napoveda: "${$('#rr-hint').textContent}"`);
  app.toggleSelect(real[2].lootId);
  t.ok(S.selected.size === 3 && !$('#rr-go').disabled, '3/3 odemkne tlacitko');
  t.ok(($('#rr-slots').innerHTML.match(/is-filled/g) || []).length === 3, 'tri plne sloty');

  t.section('pojistky');
  app.toggleSelect(real[3].lootId);
  t.ok(S.selected.size === 3 && /exactly 3/.test($('#toast').textContent), `ctvrty neprojde: "${$('#toast').textContent}"`);
  app.toggleSelect(real[0].lootId);
  app.toggleSelect(tests[0].lootId);
  t.ok(!S.selected.has(tests[0].lootId), 'testovaci k ostrym neprojde');

  // i kdyby se vyber nejak dostal na ctyri, reroll nesmi vzit libovolne tri
  S.selected = new Set(real.slice(0, 4).map((i) => i.lootId));
  await app.rerollSelected();
  t.ok(env.posts.length === 0 && /exactly 3/.test($('#toast').textContent), `4 vybrane -> odmitnuto: "${$('#toast').textContent}"`);

  t.section('navrh');
  app.suggestReroll();
  const picked = [...S.selected].map((id) => S.byId.get(id));
  const expected = real.slice()
    .sort((a, b) => (app.alreadyOwned(b) - app.alreadyOwned(a)) || (a.disenchantValue - b.disenchantValue))
    .slice(0, 3);
  t.ok(picked.every((i) => !i.isTest), 'navrhuje jen ostre shardy');
  t.ok(picked.map((i) => i.lootId).join() === expected.map((i) => i.lootId).join(),
    `duplikaty napred, pak nejlevnejsi: ${picked.map((i) => `${i.itemDesc} (${i.disenchantValue}${app.alreadyOwned(i) ? ', dup' : ''})`).join(' | ')}`);
  t.ok(env.posts.length === 0, 'navrh jen vybira, nic neposila');

  t.section('reroll testovacich shardu');
  app.setRerollMode(false);
  app.setRerollMode(true);
  S.selected = new Set(tests.map((i) => i.lootId));
  await app.rerollSelected();
  const text = $('#modal-text').textContent;
  t.ok(tests.every((i) => text.includes(i.itemDesc)), 'potvrzeni vyjmenuje vsechny tri');
  t.ok(env.posts.length === 0, 'zadny POST');
  t.ok(!env.mem['lootforge.stats'] && !env.mem['lootforge.history'], 'nic do statistik ani historie');
  const stage = $('#reveal-cards').children[0] && $('#reveal-cards').children[0].children[0];
  t.ok(stage && String(stage.className).startsWith('rr-stage'), 'prehrala se animace rerollu');
  t.ok(S.rerollMode, 'rezim zustane zapnuty na dalsi reroll');

  t.section('odchod z rezimu');
  $('#reveal').hidden = true;
  env.press('Escape');
  t.ok(!S.rerollMode && $('#rr-tray').hidden && !document.body.classList.contains('rr-on'), 'Esc rezim vypne a uklidi');

  t.done();
})().catch(t.crash);
