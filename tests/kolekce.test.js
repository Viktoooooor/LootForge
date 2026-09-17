'use strict';

/*
 * Kolekce: prehled vlastnenych veci ze serveru (nezavisle proti inventari
 * klienta) a jeho vykresleni. Potrebuje server (novou verzi) a klienta.
 */

const { createEnv, clientStatus, suite, BASE } = require('./harness');

const t = suite('kolekce');
const KINDS = ['champions', 'skins', 'chromas', 'emotes', 'icons', 'wards', 'finishers'];

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  t.section('prehled ze serveru');
  const res = await fetch(BASE + '/api/collection');
  if (res.status === 404) t.skip('server bezi ve starsi verzi - restartuj node server.js');
  const raw = await res.text();
  const col = JSON.parse(raw);
  t.ok(res.ok && KINDS.every((k) => Array.isArray(col[k])), `GET /api/collection: ${res.status}, ${Math.round(raw.length / 1024)} kB`);
  t.ok(raw.length < 600000, 'do prohlizece jde prehled, ne megabajty hernich dat');
  t.info(KINDS.map((k) => `${k} ${col[k].length}/${col.totals[k]}`).join(', '));
  t.ok(KINDS.every((k) => col.totals[k] >= col[k].length), 'vlastnenych nikdy vic nez ve hre celkem');
  t.ok(KINDS.every((k) => col[k].every((x) => x.id != null && x.name)), 'kazda polozka ma id a jmeno');
  t.ok(KINDS.every((k) => col[k].every((x, i, a) => i === 0 || a[i - 1].at >= x.at)), 'serazene od nejnovejsiho');

  const owned = await (await fetch(BASE + '/api/owned-skins')).json();
  t.ok(col.skins.length === owned.total, `skiny sedi se seznamem skinu na sampiona (${col.skins.length} = ${owned.total})`);
  t.ok(col.skins.every((x) => x.championId < 1000 && x.id % 1000 !== 0), 'bez Jade a bez zakladnich skinu');
  t.ok(col.skins.every((x) => /uncentered/.test(x.splash)), 'skiny maji cely splash do detailu');

  const inv = await (await fetch(BASE + '/lcu/lol-inventory/v2/inventory/CHAMPION_SKIN')).json();
  const invOwned = new Set(inv.filter((i) => i.owned && i.ownershipType === 'OWNED').map((i) => i.itemId));
  t.ok(col.chromas.every((c) => invOwned.has(c.id) && c.skinId && Math.floor(c.skinId / 1000) === c.championId), 'chromy: vlastnene, se svym skinem a sampionem');
  t.ok(col.chromas.every((c) => c.colors.every((x) => /^#[0-9a-f]{3,8}$/i.test(x))), 'barvy chrom jen jako hex (jdou do stylu)');
  t.ok(!col.chromas.some((c) => col.skins.some((s) => s.id === c.id)), 'chromy a skiny se nemichaji');

  const champs = await (await fetch(BASE + '/lcu/lol-inventory/v2/inventory/CHAMPION')).json();
  const champsOwned = champs.filter((i) => i.owned && i.ownershipType === 'OWNED' && i.itemId < 1000).length;
  t.ok(col.champions.length === champsOwned, `sampioni sedi s inventarem (${champsOwned})`);
  const bySkins = {};
  for (const s of col.skins) bySkins[s.championId] = (bySkins[s.championId] || 0) + 1;
  t.ok(col.champions.every((c) => c.skins === (bySkins[c.id] || 0)), 'pocet skinu u sampiona');

  const emotes = await (await fetch(BASE + '/lcu/lol-inventory/v2/inventory/EMOTE')).json();
  t.ok(col.emotes.length <= emotes.filter((i) => i.owned).length && !col.wards.some((w) => w.id === 0), 'emoty bez F2P, wardy bez zakladniho');

  for (const k of KINDS) {
    const x = col[k].find((i) => i.img);
    if (!x) continue;
    const head = await fetch(BASE + '/lcu' + x.img, { method: 'HEAD' });
    t.ok(head.ok, `${k}: obrazek se nacte (${x.name})`);
  }

  t.section('vykresleni');
  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'loadCollection', 'renderCollection', 'setCollection', 'collectionItems',
    'openCollectionSkin', 'openCollectionChroma', 'closeDetail',
  ]);
  const $ = env.pick;
  env.mem['lootforge.fast'] = '1';
  await app.loadLoot();
  await app.loadCollection();
  const S = app.state;

  const kinds = $('#col-kinds').innerHTML;
  t.ok((kinds.match(/data-col-kind="/g) || []).length === 7, 'sedm druhu: skiny, sampioni, chromy, emoty, ikony, wardy, finishery');
  t.ok(new RegExp(`<b>${col.skins.length}</b>`).test(kinds) && /col-progress/.test(kinds), 'pocty a procenta sbirky');
  t.ok((($('#grid-collection').innerHTML.match(/class="col-card/g)) || []).length === col.skins.length, 'vychozi druh: vsechny skiny');
  t.ok(/>Rarity</.test($('#col-sort').innerHTML) && !$('#col-rarity').hidden, 'u skinu jde radit a filtrovat podle rarity');

  const rarity = (col.skins.find((s) => s.rarity !== 'DEFAULT') || {}).rarity;
  if (rarity) {
    app.setCollection('rarity', rarity);
    t.ok(app.collectionItems().every((s) => s.rarity === rarity) && /found \d+/.test($('#col-count').textContent), `jen ${rarity}`);
    app.setCollection('rarity', '');
  }
  app.setCollection('sort', 'name');
  const names = app.collectionItems().map((s) => s.name);
  t.ok(names.every((n, i) => i === 0 || names[i - 1].localeCompare(n, 'en') <= 0), 'razeni podle jmena');

  const champWithSkins = col.champions.find((c) => c.skins > 0);
  app.setCollection('kind', 'champions');
  t.ok($('#col-rarity').hidden && !/>Rarity</.test($('#col-sort').innerHTML), 'u sampionu rarita neni');
  t.ok(new RegExp(`data-col-champ="${champWithSkins.id}"`).test($('#grid-collection').innerHTML), 'sampion se skiny je klikaci');
  env.click({ '[data-col-champ]': { dataset: { colChamp: String(champWithSkins.id) } } });
  t.ok(S.collection.kind === 'skins' && app.collectionItems().length === champWithSkins.skins,
    `klik na ${champWithSkins.name}: jeho ${champWithSkins.skins} skinu`);

  // kratke jmeno, ktere je zaroven zacatkem jinych jmen ("Vi" -> Viego, Victorious)
  const shortChamp = col.champions.filter((c) => c.skins > 0 && col.skins.some((sk) => sk.championId !== c.id && sk.name.toLowerCase().includes(c.name.toLowerCase())))[0];
  if (shortChamp) {
    app.setCollection('q', shortChamp.name.toLowerCase());
    t.ok(app.collectionItems().length === shortChamp.skins, `presne jmeno "${shortChamp.name}": jen jeho skiny, ne podobne pojmenovane`);
  }
  app.setCollection('q', 'priserne-neexistujici');
  t.ok(/Nothing like that/.test($('#grid-collection').innerHTML), 'prazdne hledani ma hlasku');
  app.setCollection('q', '');

  t.section('detail z kolekce');
  const skin = col.skins[0];
  const ctx = await app.openCollectionSkin(skin.id);
  t.ok(ctx && !$('#detail').hidden && ctx.item === null, `${skin.name}: detail bez akci (neni v lootu)`);
  t.ok(/uncentered/.test($('#detail-img').dataset.want || $('#detail-img').src), 'cely splash');
  app.closeDetail();

  const chroma = col.chromas.find((c) => col.skins.some((s) => s.id === c.skinId));
  if (chroma) {
    const cctx = await app.openCollectionChroma(chroma.id);
    await cctx.chromaLoad;
    await new Promise((r) => setTimeout(r, 20));
    t.ok(cctx.skinId === chroma.skinId && cctx.chromaView === chroma.id && $('#detail-art').classList.contains('is-chroma'),
      `chroma ${chroma.name}: detail skinu s rozkliknutou chromou`);
    app.closeDetail();
  }

  t.ok(env.posts.length === 0, 'kolekce nic nezapisuje');
  t.done();
})().catch(t.crash);
