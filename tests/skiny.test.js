'use strict';

/*
 * Skins for a champion and the skin details. Needs the server and the client.
 *  - the list of owned skins (checked independently against the client, no Jade)
 *  - skin shard details: the FULL splash (uncentered), the gallery, preview, video
 *  - champion shards have neither details nor skins (no champion, no skin)
 * The video is searched on YouTube once per run (the result is remembered).
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

  // ------------------------------------------------------------------ the app
  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'itemsIn', 'cardHtml', 'championIdOf', 'skinIdOf', 'skinChampionOf', 'fullSplashOf',
    'ownedSkinsFor', 'upgrade', 'revealDrops', 'showReveal', 'openDetail', 'openDetailFromDrop', 'previewSkin',
    'closeDetail', 'toggleVideo', 'setRerollMode', 'showChroma', 'loadChromas', 'pickSpotlight', 'findSpotlight', 'saveYoutubeKey',
  ]);
  const $ = env.pick;
  env.mem['lootforge.fast'] = '1';
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
  if (n) t.ok(new RegExp(`<b>${n}</b> skins? for this champion`).test(shardCard), `${shard.itemDesc}: "${n} ... na sampiona"`);
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
  // the first image is set right away, without waiting for the server
  t.ok($('#detail-img').src === expected, `hned cely splash z lootu, bez serveru: ${expected.split('/').pop()}`);
  t.ok(!/_tile_|_centered_/.test($('#detail-img').src), 'ne ctvercovy vyrez ani priblizena verze');
  const ctx = await pending;
  t.ok($('#detail-img').src === expected, 'po odpovedi serveru se nezmeni');
  t.ok(app.openDetail(champ.lootId) === null, 'champion shard detail neotevre');

  t.section('detail - skiny na sampiona');
  const mySkins = app.ownedSkinsFor(ctx.championId);
  const gallery = $('#detail-skins').innerHTML;
  t.ok(mySkins.length
    ? (gallery.match(/data-preview="/g) || []).length === mySkins.length && gallery.includes(`${ctx.championName}: your skins`)
    : /you don't own any skins yet/.test(gallery),
    mySkins.length ? `vsech ${mySkins.length} tvych skinu na ${ctx.championName}` : `${ctx.championName}: zatim zadny skin`);
  if (mySkins.length) {
    const other = mySkins[0];
    app.previewSkin(other.id);
    t.ok($('#detail-img').src === '/lcu' + other.splash && /uncentered/.test(other.splash), `nahled ${other.name}: jeho cely splash`);
    t.ok(/Your skin/.test($('#detail-caption').innerHTML), 'popisek "Your skin"');
    env.click({ '[data-detail-back]': {} });
    t.ok($('#detail-img').src === expected, 'zpet na shard');
  }

  t.section('detail - video prohlidka');
  // YouTube is never scraped. Without a key a plain link, with a key the official API.
  const shardName = ctx.name;
  const info0 = $('#detail-info').innerHTML;
  t.ok(!/data-video/.test(info0) && /<a class="ghost-btn video-btn" href="https:\/\/www\.youtube\.com\/results\?search_query=SkinSpotlights/.test(info0)
    && /target="_blank"/.test(info0), 'bez API klice: Video preview je odkaz na hledani (nova zalozka)');
  await app.toggleVideo();
  t.ok($('#detail-video').innerHTML === '', 'bez klice se nic nehleda ani nevklada');

  const realFetch = global.fetch;
  const ytCalls = [];
  let ytReply = null;
  global.fetch = (url, init) => {
    if (String(url).startsWith('https://www.googleapis.com/')) { ytCalls.push(String(url)); return Promise.resolve(ytReply()); }
    if (/^https?:/.test(String(url))) return Promise.reject(new Error('jiny externi dotaz: ' + url));
    return realFetch(url, init);
  };
  const ytOk = (items) => ({ ok: true, status: 200, json: async () => ({ items }) });
  const CH = 'UC0NwzCHb8Fg89eTB5eYX17Q';

  app.saveYoutubeKey('TEST-KEY-123');
  t.ok(/data-video/.test($('#detail-info').innerHTML) && /Video preview/.test($('#detail-info').innerHTML), 's klicem: tlacitko Video preview');
  ytReply = () => ytOk([
    { id: { videoId: 'pbePreview1' }, snippet: { channelId: CH, title: `${shardName} Skin Spotlight - Pre-Release - PBE Preview` } },
    { id: { videoId: 'finalVideo1' }, snippet: { channelId: CH, title: `${shardName.replace(/'/g, '&#39;')} Skin Spotlight - League of Legends` } },
  ]);
  await app.toggleVideo();
  const video = $('#detail-video').innerHTML;
  const q = new URL(ytCalls[0] || 'http://x').searchParams;
  t.ok(ytCalls.length === 1 && q.get('key') === 'TEST-KEY-123' && q.get('channelId') === CH && q.get('part') === 'snippet',
    'hleda se pres YouTube Data API: klic hrace, kanal SkinSpotlights');
  t.ok(/youtube-nocookie\.com\/embed\/finalVideo1\?autoplay=1/.test(video), 'vlozeno hotove video (ne PBE nahled), entity v nazvu nevadi');
  t.ok($('#detail-art').classList.contains('is-video') && /Back to splash/.test($('#detail-info').innerHTML), 'misto splashe video, tlacitko Back to splash');
  await app.toggleVideo();
  await app.toggleVideo();
  t.ok(ytCalls.length === 1, 'podruhe z cache - kvota se neplytva');
  t.ok(JSON.parse(env.mem['lootforge.ytCache'] || '{}')[Object.keys(JSON.parse(env.mem['lootforge.ytCache'] || '{}'))[0]].videoId === 'finalVideo1', 'cache v localStorage (jen uspechy)');
  await app.toggleVideo();

  delete env.mem['lootforge.ytCache'];
  ytReply = () => ({ ok: false, status: 403, json: async () => ({}) });
  await app.toggleVideo();
  t.ok(/rejected the API key/.test($('#detail-video').innerHTML) && /Search on YouTube/.test($('#detail-video').innerHTML), 'spatny klic / kvota: srozumitelna hlaska a odkaz');
  await app.toggleVideo();
  ytReply = () => ytOk([{ id: { videoId: 'cizikanal01' }, snippet: { channelId: 'UCkopie', title: `${shardName} Skin Spotlight` } }]);
  await app.toggleVideo();
  t.ok(/No SkinSpotlights video found/.test($('#detail-video').innerHTML) && !env.mem['lootforge.ytCache'], 'jiny kanal neprojde, neuspech se nepamatuje');
  await app.toggleVideo();

  t.section('vyber videa SkinSpotlights');
  const v = (id, title, ch) => ({ id, title, channelId: ch || CH });
  const list = [
    v('pbe', 'Dawnbringer Janna Skin Spotlight - Pre-Release - PBE Preview - League of Legends'),
    v('cmp', 'Dawnbringer Janna VS Bewitching Janna', 'UCjiny'),
    v('cizi', 'Dawnbringer Janna Skin Spotlight', 'UCkopie'),
    v('final', 'Dawnbringer Janna Skin Spotlight - League of Legends'),
  ];
  t.ok((app.pickSpotlight(list, 'Dawnbringer Janna') || {}).id === 'final', 'hotovy skin ma prednost pred PBE nahledem');
  t.ok((app.pickSpotlight(list.slice(0, 3), 'Dawnbringer Janna') || {}).id === 'pbe', 'kdyz hotove video neni, vezme PBE');
  t.ok(app.pickSpotlight([v('x', 'Coven Janna Skin Spotlight')], 'Dawnbringer Janna') === null, 'jiny skin neprojde');
  t.ok((app.pickSpotlight([v('kda', 'K/DA ALL OUT Ahri Skin Spotlight - League of Legends')], 'K/DA ALL OUT Ahri') || {}).id === 'kda', 'lomitka a velka pismena nevadi');
  t.ok((app.pickSpotlight([v('ks', "Star Guardian Kai'Sa Skin Spotlight")], "Star Guardian Kai'Sa") || {}).id === 'ks', 'apostrof nevadi');
  t.ok(app.pickSpotlight(list, '') === null, 'prazdne jmeno = nic');

  app.saveYoutubeKey('');
  global.fetch = realFetch;
  await app.toggleVideo();
  t.ok(!$('#detail-art').classList.contains('is-video'), 'klic odebran: zpet k odkazu');
  app.saveYoutubeKey('TEST-KEY-123');
  ytReply = () => ytOk([]);
  global.fetch = (url, init) => (String(url).startsWith('https://www.googleapis.com/') ? Promise.resolve(ytReply()) : realFetch(url, init));
  await app.toggleVideo();
  await app.toggleVideo();
  t.ok($('#detail-video').innerHTML === '' && !$('#detail-art').classList.contains('is-video'), 'zpet: iframe pryc (prehravani se zastavi)');
  await app.toggleVideo();
  app.closeDetail();
  t.ok($('#detail-video').innerHTML === '', 'zavreni detailu video zastavi');

  // after createEnv() fetch adds the server address itself - relative paths only here
  t.section('chromy');
  // a skin whose chromas the player at least partly owns - found via the client's inventory
  const inventory = await (await fetch('/lcu/lol-inventory/v2/inventory/CHAMPION_SKIN')).json();
  const invIds = new Set(inventory.map((i) => i.itemId));
  const withChromas = Object.values(skinsJson)
    .filter((sk) => Math.floor(sk.id / 1000) < 1000 && (sk.chromas || []).some((c) => invIds.has(c.id)))
    .sort((a, b) => b.chromas.filter((c) => invIds.has(c.id)).length - a.chromas.filter((c) => invIds.has(c.id)).length)[0];

  if (!withChromas) {
    t.info('hrac nevlastni zadnou chromu - kontrola preskocena');
  } else {
    const champOfSkin = Math.floor(withChromas.id / 1000);
    const lcuChromas = await (await fetch(`/lcu/lol-champions/v1/inventories/${me.summonerId}/champions/${champOfSkin}/skins/${withChromas.id}/chromas`)).json();
    const lcuOwned = lcuChromas.filter((c) => c.ownership && c.ownership.owned).length;

    const drop = { name: withChromas.name, img: '/lcu' + withChromas.tilePath, rarity: 'DEFAULT', count: 1,
      type: 'SKIN', lootId: `CHAMPION_SKIN_${withChromas.id}`, splash: '/lcu' + withChromas.splashPath };
    const cctx = await app.openDetailFromDrop(drop);
    const html = $('#detail-chromas').innerHTML;
    t.ok((html.match(/data-chroma="/g) || []).length === lcuChromas.length, `${withChromas.name}: vsech ${lcuChromas.length} chrom`);
    t.ok(new RegExp(`<span>${lcuOwned} / ${lcuChromas.length}</span>`).test(html), `vlastnis ${lcuOwned} z ${lcuChromas.length} (sedi s klientem)`);
    t.ok((html.match(/class="chroma is-owned/g) || []).length === lcuOwned && (html.match(/chroma-check/g) || []).length === lcuOwned, 'vlastnene maji fajfku');
    t.ok(lcuOwned === lcuChromas.filter((c) => invIds.has(c.id)).length, 'vlastnictvi z endpointu sedi s inventarem');
    t.ok(!/chroma-name">[^<]*\(/.test(html.replace(/<span class="swatch"[^>]*><\/span>/g, '')), 'jmena bez nazvu skinu ("Bronze", ne "Victorious TF (Bronze)")');
    t.ok(cctx.chromas.every((c) => c.colors.every((x) => /^#[0-9a-f]{3,8}$/i.test(x))), 'barvy do stylu jen jako hex');

    const firstOwned = cctx.chromas.find((c) => c.owned);
    app.showChroma(firstOwned.id);
    t.ok($('#detail-art').classList.contains('is-chroma') && $('#detail-chroma').innerHTML.includes(firstOwned.img) && /OWNED/.test($('#detail-chroma').innerHTML),
      `klik na ${firstOwned.name}: model nad ztlumenym splashem, OWNED`);
    app.showChroma(firstOwned.id);
    t.ok(!$('#detail-art').classList.contains('is-chroma') && $('#detail-chroma').innerHTML === '', 'druhy klik nahled zavre');

    app.showChroma(firstOwned.id);
    await app.toggleVideo();
    t.ok(!$('#detail-art').classList.contains('is-chroma'), 'video a nahled chromy se vylucuji');
    await app.toggleVideo();
    app.saveYoutubeKey('');
    global.fetch = realFetch;

    // previewing another owned skin = its chromas
    const otherOwned = app.ownedSkinsFor(champOfSkin).find((sk) => sk.id !== withChromas.id);
    if (otherOwned) {
      await app.previewSkin(otherOwned.id);
      const other = await (await fetch(`/lcu/lol-champions/v1/inventories/${me.summonerId}/champions/${champOfSkin}/skins/${otherOwned.id}/chromas`)).json();
      const n2 = ($('#detail-chromas').innerHTML.match(/data-chroma="/g) || []).length;
      t.ok(cctx.chromaSkin === otherOwned.id && n2 === other.length, `nahled ${otherOwned.name}: jeho chromy (${other.length})`);
    }
    app.closeDetail();
    t.ok($('#detail-chroma').innerHTML === '', 'zavreni detailu nahled chromy uklidi');
  }

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
