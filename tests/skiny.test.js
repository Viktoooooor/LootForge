'use strict';

/*
 * Skiny na sampiona a detail skinu. Potrebuje server a klienta.
 *  - seznam vlastnenych skinu (nezavisle proti klientovi, bez Jade)
 *  - detail skin shardu: CELY splash (uncentered), galerie, nahled, video
 *  - champion shardy detail ani skiny nemaji (bez sampiona nemas ani skin)
 * Video se hleda na YouTube jen jednou za beh (server si ho pamatuje).
 */

const { createEnv, clientStatus, suite, BASE } = require('./harness');

const t = suite('skiny');

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  t.section('seznam ze serveru');
  const data = await (await fetch(BASE + '/api/owned-skins')).json();
  const all = Object.entries(data.byChampion).flatMap(([cid, list]) => list.map((sk) => ({ ...sk, cid: Number(cid) })));
  t.ok(data.total === all.length && all.length > 0, `${data.total} skinu na ${Object.keys(data.byChampion).length} sampionu`);
  t.ok(all.every((sk) => sk.cid < 1000), 'zadne Jade verze (sampioni 60001+ z jineho produktu)');
  t.ok(all.every((sk) => sk.id % 1000 !== 0 && Math.floor(sk.id / 1000) === sk.cid), 'bez zakladnich skinu, kazdy u sveho sampiona');
  t.ok(all.every((sk) => /uncentered/.test(sk.splash)), 'kazdy ma cely (uncentered) splash');

  const me = await (await fetch(BASE + '/lcu/lol-summoner/v1/current-summoner')).json();
  const minimal = await (await fetch(`${BASE}/lcu/lol-champions/v1/inventories/${me.summonerId}/skins-minimal`)).json();
  const owned = minimal.filter((sk) => sk.ownership && sk.ownership.owned && !sk.isBase
    && !sk.ownership.rental.rented && !sk.ownership.loyaltyReward && !sk.ownership.xboxGPReward);
  const jade = owned.filter((sk) => sk.championId >= 1000).length;
  t.ok(owned.length - jade === data.total, `sedi s klientem: ${owned.length} vlastnenych - ${jade} Jade = ${data.total}`);

  t.section('cely splash');
  const skinsJson = await (await fetch(BASE + '/lcu/lol-game-data/assets/v1/skins.json')).json();
  const league = Object.values(skinsJson).filter((sk) => Math.floor(sk.id / 1000) < 1000);
  const derivable = league.filter((sk) => String(sk.splashPath).replace(/_splash_centered_/i, '_splash_uncentered_') === sk.uncenteredSplashPath);
  t.ok(derivable.length === league.length, `centered -> uncentered jde odvodit u vsech ${league.length} skinu League (${derivable.length})`);
  const art = await (await fetch(`${BASE}/api/skin/${all[0].id}`)).json();
  t.ok(/uncentered/.test(art.splash) && art.championName, `/api/skin/${all[0].id}: ${art.name} (${art.championName})`);

  // ---------------------------------------------------------------- appka
  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'itemsIn', 'cardHtml', 'championIdOf', 'skinIdOf', 'skinChampionOf', 'fullSplashOf',
    'ownedSkinsFor', 'upgrade', 'revealDrops', 'showReveal', 'openDetail', 'openDetailFromDrop', 'previewSkin',
    'closeDetail', 'toggleVideo', 'setRerollMode',
  ]);
  const $ = env.pick;
  env.mem['gamba.fast'] = '1';
  await app.loadLoot();
  const S = app.state;

  t.section('rozpoznani skinu');
  const cases = [
    [{ type: 'SKIN_RENTAL', lootId: 'CHAMPION_SKIN_RENTAL_40066', storeItemId: 40066 }, 40066, 40, 'skin shard'],
    [{ type: 'SKIN', lootId: 'CHAMPION_SKIN_40066' }, 40066, 40, 'skin z odemknuti'],
    [{ type: 'SKIN', lootId: 'TEST_SKIN_40066' }, 40066, 40, 'skin ze simulatoru'],
    [{ type: 'CHAMPION_RENTAL', lootId: 'CHAMPION_RENTAL_110', storeItemId: 110 }, 0, 0, 'champion shard neni skin'],
    [{ type: 'CURRENCY', lootId: 'CURRENCY_champion' }, 0, 0, 'mena'],
  ];
  for (const [input, skin, champ, label] of cases) {
    t.ok(app.skinIdOf(input) === skin && app.skinChampionOf(input) === champ, `${label} -> skin ${app.skinIdOf(input)}, sampion ${app.skinChampionOf(input)}`);
  }

  t.section('karty');
  const realSkins = app.itemsIn('skins').filter((i) => !i.isTest);
  const realChamps = app.itemsIn('champs').filter((i) => !i.isTest);
  const shard = realSkins.find((i) => app.ownedSkinsFor(app.skinChampionOf(i)).length > 0) || realSkins[0];
  const n = app.ownedSkinsFor(app.skinChampionOf(shard)).length;
  const shardCard = app.cardHtml(shard, 'skins');
  t.ok(/data-detail="1"/.test(shardCard) && /data-pick="/.test(shardCard), 'skin shard: otevira detail, vyber na kolecku');
  if (n) t.ok(new RegExp(`<b>${n}</b> (skin|skiny|skinu) na sampiona`).test(shardCard), `${shard.itemDesc}: "${n} ... na sampiona"`);
  t.ok(realChamps.every((i) => !/skins-chip|data-detail/.test(app.cardHtml(i, 'champs'))), `${realChamps.length} champion shardu: bez skinu a bez detailu`);

  t.section('klik');
  env.click({ '.card[data-selectable]': { dataset: { id: shard.lootId, detail: '1' } } });
  t.ok(!$('#detail').hidden && S.selected.size === 0, 'klik na skin shard otevre detail');
  env.press('Escape');
  t.ok($('#detail').hidden, 'Esc detail zavre');
  const champ = realChamps[0];
  env.click({ '.card[data-selectable]': { dataset: { id: champ.lootId } } });
  t.ok($('#detail').hidden && S.selected.has(champ.lootId), 'klik na champion shard jen vybere (zadny detail)');
  S.selected.clear();
  env.click({ '[data-pick]': { dataset: { pick: shard.lootId } } });
  t.ok(S.selected.has(shard.lootId) && $('#detail').hidden, 'kolecko vybere');
  S.selected.clear();
  app.setRerollMode(true);
  env.click({ '.card[data-selectable]': { dataset: { id: shard.lootId, detail: '1' } } });
  t.ok(S.selected.has(shard.lootId) && $('#detail').hidden, 'v rezimu rerollu klik plni slot');
  app.setRerollMode(false);

  t.section('detail - obrazek');
  const expected = '/lcu' + app.fullSplashOf(shard.splashPath);
  const pending = app.openDetail(shard.lootId);
  // prvni obrazek se nastavi hned, bez cekani na server
  t.ok($('#detail-img').src === expected, `hned cely splash z lootu, bez serveru: ${expected.split('/').pop()}`);
  t.ok(!/_tile_|_centered_/.test($('#detail-img').src), 'ne ctvercovy vyrez ani priblizena verze');
  const ctx = await pending;
  t.ok($('#detail-img').src === expected, 'po odpovedi serveru se nezmeni');
  t.ok(app.openDetail(champ.lootId) === null, 'champion shard detail neotevre');

  t.section('detail - skiny na sampiona');
  const mySkins = app.ownedSkinsFor(ctx.championId);
  const gallery = $('#detail-skins').innerHTML;
  t.ok(mySkins.length
    ? (gallery.match(/data-preview="/g) || []).length === mySkins.length && gallery.includes(`${ctx.championName}: tvoje skiny`)
    : /zatim nemas zadny skin/.test(gallery),
    mySkins.length ? `vsech ${mySkins.length} tvych skinu na ${ctx.championName}` : `${ctx.championName}: zatim zadny skin`);
  if (mySkins.length) {
    const other = mySkins[0];
    app.previewSkin(other.id);
    t.ok($('#detail-img').src === '/lcu' + other.splash && /uncentered/.test(other.splash), `nahled ${other.name}: jeho cely splash`);
    t.ok(/Tvuj skin/.test($('#detail-caption').innerHTML), 'popisek "Tvuj skin"');
    env.click({ '[data-detail-back]': {} });
    t.ok($('#detail-img').src === expected, 'zpet na shard');
  }

  t.section('detail - video prohlidka');
  t.ok(/data-video/.test($('#detail-info').innerHTML) && /Video prohlidka/.test($('#detail-info').innerHTML), 'tlacitko Video prohlidka');
  await app.toggleVideo();
  const video = $('#detail-video').innerHTML;
  const embedded = /youtube-nocookie\.com\/embed\/[\w-]{11}\?autoplay=1/.test(video);
  t.ok(embedded || /Hledat na YouTube/.test(video), embedded ? 'video vlozene (youtube-nocookie, autoplay)' : 'video nenalezeno -> odkaz na hledani');
  t.ok($('#detail-art').classList.contains('is-video') && /Zpet na splash/.test($('#detail-info').innerHTML), 'misto splashe video, tlacitko Zpet na splash');
  await app.toggleVideo();
  t.ok($('#detail-video').innerHTML === '' && !$('#detail-art').classList.contains('is-video'), 'zpet: iframe pryc (prehravani se zastavi)');
  await app.toggleVideo();
  app.closeDetail();
  t.ok($('#detail-video').innerHTML === '', 'zavreni detailu video zastavi');

  t.section('odhaleni');
  const [richId, richList] = Object.entries(data.byChampion).sort((a, b) => b[1].length - a[1].length)[0];
  const skinDrop = { name: richList[0].name, img: '/lcu' + richList[0].img, rarity: richList[0].rarity, count: 1, type: 'SKIN_RENTAL', lootId: `CHAMPION_SKIN_RENTAL_${richList[0].id}` };
  app.showReveal('drop');
  await app.revealDrops([skinDrop], 'drop', { reel: true });
  const html = $('#reveal-cards').innerHTML;
  t.ok((html.match(/class="skin-mini /g) || []).length === Math.min(richList.length, 12) && /is-this/.test(html),
    `padl skin -> ${Math.min(richList.length, 12)} tvych skinu na sampiona ${richId}, padly oznaceny`);
  env.click({ '[data-drop]': { dataset: { drop: '0' } } });
  t.ok(!$('#detail').hidden, 'Detail skinu i pro drop mimo inventar');
  app.closeDetail();

  app.showReveal('champ');
  await app.revealDrops([{ name: 'Annie', img: '', rarity: 'DEFAULT', count: 1, type: 'CHAMPION_RENTAL', lootId: 'CHAMPION_RENTAL_1' }], 'champ', { reel: true });
  t.ok(!/skins-owned|data-drop/.test($('#reveal-cards').innerHTML), 'padly sampion: bez skinu a bez detailu');

  t.section('potvrzeni pred odemknutim');
  const testSkin = S.items.find((i) => i.isTest && i.type === 'SKIN_RENTAL');
  await app.upgrade(testSkin.lootId);
  t.ok($('#modal').classList.contains('is-wide'), `skin shard (${testSkin.itemDesc}): galerie skinu na sampiona`);
  const testChamp = S.items.find((i) => i.isTest && i.type === 'CHAMPION_RENTAL');
  await app.upgrade(testChamp.lootId);
  t.ok($('#modal-extra').innerHTML === '' && !$('#modal').classList.contains('is-wide'), 'champion shard: bez galerie');
  t.ok(env.posts.length === 0, 'nic se neposlalo');

  t.done();
})().catch(t.crash);
