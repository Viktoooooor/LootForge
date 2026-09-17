'use strict';

/*
 * Recepty a kategorizace na SKUTECNEM inventari. Potrebuje server a klienta.
 * Bedny a fragmenty hrac mit nemusi - pridame je jen do pameti appky a overime
 * telo POST requestu, ktery by se poslal. Nic se neodesle.
 */

const { createEnv, clientStatus, suite } = require('./harness');

const t = suite('recepty');

(async () => {
  const status = await clientStatus();
  if (!status.client) t.skip('potrebuje bezici server a prihlaseneho klienta');

  const env = createEnv();
  const app = env.load(['reel.js', 'simulator.js', 'app.js'], [
    'state', 'loadLoot', 'bucket', 'itemsIn', 'recipesFor', 'recipeOfType', 'recipeAppliesTo',
    'maxRepeats', 'fillSlots', 'cardHtml', 'alreadyOwned', 'nameOf', 'imgUrl', 'dropsFrom',
  ]);
  await app.loadLoot();
  const S = app.state;

  t.section('inventar');
  t.ok(S.connected, 'pripojeno ke klientovi');
  t.ok(S.items.length > 0, `nacteno ${S.items.filter((i) => !i.isTest).length} polozek`);
  t.ok(S.items.every((i) => i.lootId), 'zadna prazdna polozka bez lootId');

  t.section('klice a meny nejsou bedny');
  for (const id of ['MATERIAL_key', 'CURRENCY_champion', 'CURRENCY_cosmetic']) {
    const it = S.byId.get(id);
    if (!it) { t.info(`${id}: v inventari neni`); continue; }
    t.ok(app.bucket(it) === 'wallet' && app.recipesFor(id).length === 0,
      `${id}: penezenka, po filtru ${app.recipesFor(id).length} receptu`);
  }

  t.section('bedny a kovani (pridano jen do pameti)');
  const get = async (p) => (await fetch(p)).json();
  const fake = [
    { lootId: 'CHEST_224', lootName: 'CHEST_224', itemDesc: 'Masterwork Chest', count: 5, type: 'CHEST', rarity: 'DEFAULT', tilePath: '', disenchantValue: 0 },
    { lootId: 'MATERIAL_key_fragment', lootName: 'MATERIAL_key_fragment', itemDesc: 'Key Fragment', count: 7, type: 'MATERIAL', rarity: 'DEFAULT', tilePath: '', disenchantValue: 0 },
  ];
  for (const f of fake) {
    const all = await get('/lcu/lol-loot/v1/recipes/initial-item/' + f.lootId);
    S.items.push(f); S.byId.set(f.lootId, f);
    S.recipes.set(f.lootId, all.filter((r) => app.recipeAppliesTo(r, f)));
  }
  const keys = (S.byId.get('MATERIAL_key') || { count: 0 }).count;

  const open = app.recipeOfType('CHEST_224', 'OPEN');
  t.ok(!!open && app.bucket(fake[0]) === 'chests', `bedna: tab Bedny, recept ${open && open.recipeName}`);
  if (open) {
    t.ok(JSON.stringify(app.fillSlots(open, 'CHEST_224')) === '["CHEST_224","MATERIAL_key"]' || keys === 0,
      `telo POST: ${JSON.stringify(app.fillSlots(open, 'CHEST_224'))} (stejne jako posila klient)`);
    t.ok(app.maxRepeats(open, 'CHEST_224') === Math.min(5, keys), `otevrit lze ${app.maxRepeats(open, 'CHEST_224')}x (bedny 5, klice ${keys})`);
  }
  const forge = app.recipeOfType('MATERIAL_key_fragment', 'FORGE');
  t.ok(!!forge, `fragmenty: recept ${forge && forge.recipeName}`);
  if (forge) {
    t.ok(app.maxRepeats(forge, 'MATERIAL_key_fragment') === 2, 'ze 7 fragmentu 2 klice');
    t.ok(JSON.stringify(app.fillSlots(forge, 'MATERIAL_key_fragment')) === '["MATERIAL_key_fragment"]', 'telo POST pro kovani');
  }
  const keyAll = await get('/lcu/lol-loot/v1/recipes/initial-item/MATERIAL_key');
  const keyItem = S.byId.get('MATERIAL_key') || { lootId: 'MATERIAL_key', type: 'MATERIAL' };
  t.ok(keyAll.filter((r) => app.recipeAppliesTo(r, keyItem)).length === 0,
    `klic: z ${keyAll.length} receptu (vsechny bedny) nezbyde zadny`);

  t.section('karty');
  let crashed = 0;
  for (const it of S.items) {
    try { app.cardHtml(it, app.bucket(it)); } catch (_) { crashed++; }
  }
  t.ok(crashed === 0, `vsech ${S.items.length} karet se vykresli bez chyby`);

  const owned = S.items.filter((i) => !i.isTest && app.alreadyOwned(i));
  const offering = owned.filter((i) => app.cardHtml(i, app.bucket(i)).includes('Odemknout'));
  t.ok(offering.length === 0, `u ${owned.length} vlastnenych polozek se odemknuti nenabizi`);

  const shards = app.itemsIn('champs').concat(app.itemsIn('skins')).filter((i) => !i.isTest);

  const ownedShards = shards.filter((i) => /_RENTAL$/.test(i.type) && app.alreadyOwned(i));
  const newShards = shards.filter((i) => /_RENTAL$/.test(i.type) && !app.alreadyOwned(i));
  const perms = shards.filter((i) => !/_RENTAL$/.test(i.type));
  t.ok(ownedShards.every((i) => /is-owned/.test(app.cardHtml(i, app.bucket(i))) && /OWNED/.test(app.cardHtml(i, app.bucket(i)))),
    `${ownedShards.length} shardu vlastnenych veci ma zelenou pasku OWNED`);
  t.ok(newShards.every((i) => !/owned-ribbon/.test(app.cardHtml(i, app.bucket(i)))), `${newShards.length} nevlastnenych je bez pasky`);
  t.ok(perms.every((i) => !/owned-ribbon/.test(app.cardHtml(i, app.bucket(i)))), 'permanenty pasku nemaji (vlastnis je samozrejme)');
  t.ok(shards.every((i) => !/MAS HO/.test(app.cardHtml(i, app.bucket(i)))), 'stary text "MAS HO" je pryc');
  const badges = new Set(shards.map((i) => (app.cardHtml(i, app.bucket(i)).match(/card-badge is-(\w+)/) || [])[1]));
  t.ok(badges.has('shard') && [...badges].every((b) => b === 'shard' || b === 'perm'), `odznaky shard / permanent: ${[...badges].join(', ')}`);

  t.section('odpoved craftu');
  const sample = S.items.find((i) => !i.isTest && app.imgUrl(i));
  const drops = app.dropsFrom({ added: [{ deltaCount: 2, playerLoot: sample }], removed: [], redeemed: [] });
  t.ok(drops.length === 1 && drops[0].count === 2 && drops[0].name === app.nameOf(sample), `z added se vytahne: ${drops[0] && drops[0].name} x${drops[0] && drops[0].count}`);

  t.section('obrazky');
  const imgs = [...new Set(S.items.map(app.imgUrl).filter(Boolean))].slice(0, 12);
  let broken = 0;
  for (const u of imgs) { const r = await fetch(u, { method: 'HEAD' }); if (!r.ok) broken++; }
  t.ok(broken === 0, `${imgs.length} obrazku, rozbitych ${broken}`);

  t.ok(env.posts.length === 0, 'behem testu nesel zadny POST');
  t.done();
})().catch(t.crash);
