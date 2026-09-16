/* Hextech Gamba - klientska logika.
 *
 * Vsechno jde pres /lcu/* (proxy v server.js) do bezici League klienta.
 * Recepty si nevymyslime - tahame je z /lol-loot/v1/recipes/initial-item/{id},
 * takze appka funguje i na bedny a kapsle, ktere Riot prida az pozdeji.
 */

'use strict';

// --- stav ---------------------------------------------------------------

const state = {
  connected: false,
  items: [],                 // loot polozky s lootId a count > 0
  byId: new Map(),           // lootId -> polozka
  recipes: new Map(),        // lootId -> pole receptu
  selected: new Set(),       // lootId vybrane v aktualnim tabu
  scope: 'chests',           // aktivni tab
  busy: false,
  rerollMode: false,         // zasobnik se tremi sloty v tabu skinu
  shop: { stores: [], loadedAt: 0, error: null, loading: false },
  ownedSkins: {},            // championId -> [{ id, name, img, splash, rarity }], jen vlastnene
  champions: {},             // championId -> jmeno
};

// Originalni ikony z klienta. LCU je servíruje na /lol-game-data/assets/ASSETS/Loot/,
// zatimco cesty /fe/... z player-loot vraci 404 (viz CLAUDE.md).
const ART = '/lol-game-data/assets/ASSETS/Loot/';
const LOOT_ART = {
  CURRENCY_champion:     ART + 'currency_champion.png',
  CURRENCY_cosmetic:     ART + 'currency_cosmetic.png',
  CURRENCY_mythic:       ART + 'Mythic_Essence_490px.png',
  CURRENCY_RP:           ART + 'CURRENCY_RP_490px.png',
  MATERIAL_key:          ART + 'HextechKey_490x490eventshop.png',
  MATERIAL_key_fragment: ART + 'HextechKeyFragment_490x490.png',
};

const WALLET = [
  ['CURRENCY_champion',     'Modra esence'],
  ['CURRENCY_cosmetic',     'Oranzova esence'],
  ['CURRENCY_mythic',       'Mythic esence'],
  ['MATERIAL_key',          'Hextech klice'],
  ['MATERIAL_key_fragment', 'Fragmenty klicu'],
  ['CURRENCY_RP',           'RP'],
];

const RARITY_ORDER = ['DEFAULT', 'EPIC', 'LEGENDARY', 'MYTHIC', 'ULTIMATE', 'TRANSCENDENT', 'EXALTED'];

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- LCU volani ---------------------------------------------------------

async function lcu(path, opts) {
  const res = await fetch('/lcu' + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.message || j.error || detail; } catch (_) {}
    const err = new Error(`${res.status} ${detail}`);
    err.status = res.status;   // 502/503 = klient odpadl, ne chyba receptu
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Pusti `fn` nad vsemi polozkami, ale nejvys `limit` naraz. */
async function pool(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pomocnici nad loot polozkami ---------------------------------------

function nameOf(item) {
  if (!item) return 'Neznamy predmet';
  return item.itemDesc || item.localizedName || prettify(item.lootName || item.lootId || '');
}

function prettify(id) {
  return id
    .replace(/^(CHEST|MATERIAL|CURRENCY|CHAMPION_SKIN_RENTAL|CHAMPION_SKIN|CHAMPION_RENTAL|CHAMPION|SKIN)_/, '')
    .replace(/_/g, ' ')
    .trim() || id;
}

function imgUrl(item) {
  if (item && LOOT_ART[item.lootId]) return '/lcu' + LOOT_ART[item.lootId];
  const p = item && (item.tilePath || item.splashPath || item.shadowPath);
  // /fe/* jsou assety klientskeho frontendu - ty LCU pres HTTP neservíruje (404),
  // takze radsi nic nez rozbity obrazek. Splashe z /lol-game-data/* funguji.
  if (!p || p.startsWith('/fe/')) return '';
  return '/lcu' + p;
}

/** Nahrada za chybejici obrazek - prvni dve pismena nazvu. */
function glyph(item) {
  const n = nameOf(item).replace(/[^A-Za-z0-9]/g, '');
  return escapeHtml((n.slice(0, 2) || '??').toUpperCase());
}

/** Ikonky (klice, esence) nejsou 16:9 splashe - chteji jine vykresleni. */
function isIcon(item) {
  const p = (item && item.tilePath) || '';
  return p.includes('/lol-loot/assets/') || item.type === 'CURRENCY' || item.type === 'MATERIAL';
}

function countOf(lootId) {
  const it = state.byId.get(lootId);
  return it ? it.count : 0;
}

/**
 * Klicova vec: /recipes/initial-item/{id} vraci VSECHNY recepty, kde se polozka
 * kdekoliv objevi - u klice to jsou vsechny bedny, u modre esence vsechny emote
 * upgrady. Nas zajima jen recept, jehoz JE polozka hlavni surovinou.
 */
function recipeAppliesTo(recipe, item) {
  const slots = recipe.slots || [];
  const first = slots.find((s) => (s.slotNumber || 0) === 0) || slots[0];
  const ids = (first && first.lootIds) || [];
  if (ids.length) return ids.includes(item.lootId);

  // prazdny prvni slot -> klient do nej nemel co dat. Recept pak patri k polozce,
  // jen kdyz je po ni pojmenovany: CHEST_224 + "_open", ne MATERIAL_key + "_fragment_forge".
  const name = String(recipe.recipeName || '').toLowerCase();
  const prefix = item.lootId.toLowerCase() + '_';
  if (name.startsWith(prefix) && !name.slice(prefix.length).includes('_')) return true;

  // pojistka pro bedny s netypickym nazvem receptu
  return item.type === 'CHEST' && recipe.type === 'OPEN';
}

function recipesFor(lootId) {
  return state.recipes.get(lootId) || [];
}

function recipeOfType(lootId, type) {
  return recipesFor(lootId).find((r) => r.type === type) || null;
}

function isOpenable(item) {
  return recipesFor(item.lootId).some((r) => r.type === 'OPEN' || r.type === 'FORGE');
}

/** Shard je zapujcka (typ konci na _RENTAL); vsechno ostatni uz mas natrvalo. */
function isShard(item) {
  return /_RENTAL$/.test(item.type || '');
}

function alreadyOwned(item) {
  return item.redeemableStatus === 'ALREADY_OWNED' || item.itemStatus === 'OWNED';
}

/**
 * Nacpe do slotu receptu konkretni lootId, ktere hrac fakt ma.
 * `prefer` je polozka, na kterou hrac kliknul (aby se otevrela prave ta bedna).
 * Vraci pole lootId (jedno na slot) nebo null, kdyz na to nema.
 */
function fillSlots(recipe, prefer, extraUsed) {
  const used = Object.assign({}, extraUsed || {});
  const picked = [];

  for (const slot of recipe.slots || []) {
    const need = slot.quantity || 1;
    const ids = slotIds(slot, prefer);
    const free = (id) => countOf(id) - (used[id] || 0);

    let pick = (prefer && ids.includes(prefer) && free(prefer) >= need) ? prefer : null;
    if (!pick) pick = ids.find((id) => free(id) >= need) || null;
    if (!pick) return null;

    used[pick] = (used[pick] || 0) + need;
    picked.push(pick);
  }
  return picked;
}

/**
 * Klient necha slot.lootIds prazdny, kdyz do nej nic z inventare nesedi
 * (typicky slot na samotnou bednu). V tom pripade patri do slotu prave ta
 * polozka, na kterou hrac kliknul.
 */
function slotIds(slot, prefer) {
  const ids = slot.lootIds || [];
  if (ids.length) return ids;
  return prefer ? [prefer] : [];
}

/** Kolikrat po sobe jde recept spustit se soucasnym inventarem. */
function maxRepeats(recipe, prefer) {
  if (!recipe) return 0;
  let max = Infinity;
  const used = {};
  for (const slot of recipe.slots || []) {
    const need = slot.quantity || 1;
    const ids = slotIds(slot, prefer);
    const id = (prefer && ids.includes(prefer)) ? prefer : ids.find((x) => countOf(x) > 0);
    if (!id) return 0;
    used[id] = (used[id] || 0) + need;
    max = Math.min(max, Math.floor(countOf(id) / used[id]) || 0);
  }
  return max === Infinity ? 0 : Math.max(0, max);
}

/**
 * Jedina cesta, kterou appka neco vyrabi. Testovaci polozky se odchyti presne
 * tady - dal uz zadny request nepokracuje. Vsechno pred tim (potvrzeni, vyber,
 * actionbar) probehne uplne stejne jako naostro, takze to jde poradne otestovat.
 */
async function craft(recipeName, lootIds, repeat) {
  const items = lootIds.map((id) => state.byId.get(id));
  if (items.some((i) => i && i.isTest)) {
    if (!globalThis.TestChest) throw new Error('Testovaci polozka bez simulatoru.');
    return TestChest.simulateCraft(recipeName, items, repeat);
  }

  return lcu(`/lol-loot/v1/recipes/${encodeURIComponent(recipeName)}/craft?repeat=${repeat || 1}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lootIds),
  });
}

const isTestBatch = (ids) => ids.some((id) => (state.byId.get(id) || {}).isTest);

/** Michat testovaci a ostre polozky v jedne akci nedava smysl - a je to nebezpecne. */
function isMixedBatch(ids) {
  const flags = ids.map((id) => !!(state.byId.get(id) || {}).isTest);
  return flags.includes(true) && flags.includes(false);
}

/** Z odpovedi craftu vytahne, co hrac dostal. */
function dropsFrom(res) {
  const rows = [].concat(res && res.added || [], res && res.redeemed || []);
  return rows.map((row) => {
    const pl = row.playerLoot || row.lootItem || row;
    return {
      name: nameOf(pl),
      img: imgUrl(pl),
      splash: pl.splashPath && !String(pl.splashPath).startsWith('/fe/') ? '/lcu' + pl.splashPath : '',
      icon: isIcon(pl),
      rarity: pl.rarity || 'DEFAULT',
      type: pl.type || '',
      count: row.deltaCount || pl.count || 1,
      lootId: pl.lootId || '',
    };
  }).filter((d) => d.name && d.name !== 'Neznamy predmet');
}

// --- nacitani -----------------------------------------------------------

async function checkConnection() {
  try {
    const s = await (await fetch('/api/status')).json();
    setConnected(s.connected);
    return s.connected;
  } catch (_) {
    setConnected(false);
    return false;
  }
}

function setConnected(on) {
  const changed = state.connected !== on;
  state.connected = on;
  const el = $('#conn');
  el.className = 'conn ' + (on ? 'on' : 'off');
  el.querySelector('.conn-label').textContent = on ? 'klient pripojen' : 'klient nebezi';
  return changed;
}

async function loadLoot() {
  if (!await checkConnection()) { renderAll(); return; }

  const raw = await lcu('/lol-loot/v1/player-loot');
  state.items = (raw || []).filter((i) => i.lootId && i.count > 0);
  state.byId = new Map(state.items.map((i) => [i.lootId, i]));

  // recepty pro kazdou polozku - z nich plyne, co s ni jde delat
  const fresh = new Map();
  const skinsLoad = loadOwnedSkins();
  await pool(state.items, 6, async (item) => {
    try {
      const all = await lcu('/lol-loot/v1/recipes/initial-item/' + encodeURIComponent(item.lootId)) || [];
      fresh.set(item.lootId, all.filter((r) => recipeAppliesTo(r, item)));
    } catch (_) {
      fresh.set(item.lootId, []);
    }
  });
  state.recipes = fresh;
  await skinsLoad;

  // testovaci polozky ziji jen v prohlizeci - do klienta se nikdy nedostanou
  if (globalThis.TestChest) {
    const t = TestChest.item();
    if (!state.byId.has(t.lootId)) {
      state.items.push(t);
      state.byId.set(t.lootId, t);
      state.recipes.set(t.lootId, []);
    }

    try {
      if (!testShards) testShards = await TestChest.shards();
      for (const sh of testShards) {
        if (state.byId.has(sh.lootId)) continue;
        state.items.push(sh);
        state.byId.set(sh.lootId, sh);
        state.recipes.set(sh.lootId, TestChest.recipesFor(sh));
      }
    } catch (_) { /* bez dat z klienta testovaci shardy proste nebudou */ }
  }

  renderAll();
}

// --- kategorizace -------------------------------------------------------

function bucket(item) {
  if (item.isTest) return item.type === 'CHEST' ? 'chests' : (item.type === 'SKIN_RENTAL' ? 'skins' : 'champs');
  // poradi zalezi: fragmenty klicu jsou v penezence, ale zaroven se z nich
  // kuje klic - tak at maji kartu s tlacitkem v tabu Bedny
  if (isOpenable(item)) return 'chests';
  if (WALLET.some(([id]) => id === item.lootId)) return 'wallet';
  if (item.type === 'SKIN_RENTAL') return 'skins';
  if (item.type === 'CHAMPION_RENTAL' || item.type === 'CHAMPION') return 'champs';
  return 'other';
}

function itemsIn(scope) {
  return state.items.filter((i) => bucket(i) === scope);
}

// --- vykreslovani -------------------------------------------------------

function renderAll() {
  renderWallet();
  ['chests', 'skins', 'champs', 'other'].forEach((scope) => {
    const list = itemsIn(scope);
    const pill = $(`.pill[data-count="${scope}"]`);
    if (pill) pill.textContent = list.reduce((n, i) => n + i.count, 0);
    renderGrid(scope, list);
  });
  renderChestHeader();
  renderSession();
  renderActionbar();
  if (state.shop.loadedAt) renderShop();
}

function renderWallet() {
  $('#wallet').innerHTML = WALLET.map(([id, label]) => {
    const it = state.byId.get(id);
    if (!it) return '';
    return `<div class="w-item" title="${label}">
      ${LOOT_ART[id] ? `<img src="/lcu${LOOT_ART[id]}" alt="${label}">` : `<i class="w-dot"></i>`}
      <b>${it.count.toLocaleString('cs-CZ')}</b>
    </div>`;
  }).join('');
}

function renderChestHeader() {
  const chests = itemsIn('chests').filter((i) => !i.isTest);
  const total = chests.reduce((n, i) => n + Math.min(i.count, maxRepeats(recipeOfType(i.lootId, 'OPEN'), i.lootId)), 0);
  const btn = $('#open-all');
  btn.disabled = total === 0 || state.busy;
  btn.textContent = total > 0 ? `Otevrit vse (${total})` : 'Neni co otevirat';
  $('#chests-sub').textContent = chests.length
    ? `${chests.reduce((n, i) => n + i.count, 0)} kusu v inventari, ${total} jich jde otevrit hned ted.`
    : 'Zadne ostre bedny v inventari - zbyla jen testovaci na zkouseni animace.';
}

function renderGrid(scope, list) {
  const grid = $('#grid-' + scope);
  if (!grid) return;

  if (!state.connected) {
    grid.innerHTML = '<div class="empty">Spust League klienta - appka se pripoji sama.</div>';
    return;
  }
  if (!list.length) {
    grid.innerHTML = '<div class="empty">Tady je prazdno.</div>';
    return;
  }

  const sorted = list.slice().sort((a, b) => {
    if (!!a.isTest !== !!b.isTest) return a.isTest ? 1 : -1;
    const r = RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity);
    return r !== 0 ? r : nameOf(a).localeCompare(nameOf(b), 'cs');
  });

  // u sampionu a skinu je rozdil shard / permanent zasadni - at je videt na prvni pohled
  if (scope === 'champs' || scope === 'skins') {
    const shards = sorted.filter(isShard);
    const perms = sorted.filter((i) => !isShard(i));
    grid.innerHTML =
      groupHtml('Shardy', 'jeste je musis odemknout nebo rozlozit', shards, scope) +
      groupHtml('Permanenty', 'uz je mas natrvalo, jdou jen rozlozit', perms, scope);
    return;
  }

  grid.innerHTML = `<div class="grid">${sorted.map((item) => cardHtml(item, scope)).join('')}</div>`;
}

function groupHtml(title, note, list, scope) {
  if (!list.length) return '';
  const pieces = list.reduce((n, i) => n + i.count, 0);
  return `<section class="group group-${title.toLowerCase()}">
    <header class="group-head">
      <h3>${title} <span class="group-count">${pieces}</span></h3>
      <span class="group-note">${note}</span>
    </header>
    <div class="grid">${list.map((item) => cardHtml(item, scope)).join('')}</div>
  </section>`;
}

function cardHtml(item, scope) {
  if (item.isTest && item.type === 'CHEST') return testCardHtml(item);
  const id = item.lootId;
  const open  = recipeOfType(id, 'OPEN');
  const forge = recipeOfType(id, 'FORGE');
  const dis   = recipeOfType(id, 'DISENCHANT');
  const upg   = recipeOfType(id, 'UPGRADE');
  const selectable = scope === 'skins' || scope === 'champs';

  const canOpen = open ? maxRepeats(open, id) : 0;
  const upgCost = upg ? (item.upgradeEssenceValue || 0) : 0;
  // u testovaci polozky nas nezajima, jestli na to hrac ma - je to simulace
  const canUpgrade = item.isTest || (upg && upgCost > 0 && countOf(item.upgradeEssenceName || currencyForUpgrade(item)) >= upgCost);

  const actions = [];
  if (open) {
    actions.push(btn(`open:${id}:1`, 'Otevrit 1', canOpen < 1));
    if (item.count > 1) actions.push(btn(`open:${id}:${canOpen}`, `Otevrit vse (${canOpen})`, canOpen < 1));
  }
  if (forge) {
    const canForge = maxRepeats(forge, id);
    actions.push(btn(`forge:${id}:${Math.max(1, canForge)}`, `Vyrobit (${canForge})`, canForge < 1));
  }
  // co uz mas natrvalo, nema smysl odemykat - klient by to stejne odmitl
  if (upg && !alreadyOwned(item)) {
    actions.push(btn(`upgrade:${id}`, `Odemknout (${upgCost.toLocaleString('cs-CZ')})`, !canUpgrade));
  }
  if (dis) actions.push(btn(`disenchant:${id}`, `Rozlozit (+${(item.disenchantValue * item.count).toLocaleString('cs-CZ')})`, false));

  const shard = isShard(item);
  const meta = [];
  if (item.type) meta.push(typeLabel(item.type));
  if (item.rarity && item.rarity !== 'DEFAULT') meta.push(item.rarity.toLowerCase());

  const badge = item.isTest
    ? '<span class="card-badge is-test">SIMULACE</span>'
    : shard
      ? '<span class="card-badge is-shard">SHARD</span>'
      : '<span class="card-badge is-perm">PERMANENT</span>';

  // u shardu je "uz ho mas" dulezita informace (duplikat = kandidat na rozlozeni
  // nebo reroll), u permanentu je to samozrejme - tam ji nekreslime
  const owned = shard && alreadyOwned(item);

  return `<div class="card ${item.isTest ? 'card-test' : shard ? 'card-shard' : 'card-perm'} ${owned ? 'is-owned' : ''} ${state.selected.has(id) ? 'is-selected' : ''}" data-id="${id}" ${selectable ? 'data-selectable="1"' : ''} ${recipeOfType(id, 'REROLL') ? 'data-rr="1"' : ''} ${selectable && skinIdOf(item) ? 'data-detail="1"' : ''}>
    <div class="card-img ${isIcon(item) ? 'contain' : ''}">
      ${imgUrl(item) ? `<img src="${imgUrl(item)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="card-glyph">${glyph(item)}</span>`}
      ${item.count > 1 ? `<span class="card-count">x${item.count}</span>` : ''}
      ${owned ? '<span class="owned-ribbon" title="Tohle uz mas natrvalo"><i></i>VLASTNIS</span>' : ''}
      ${selectable ? `<button class="pick-box ${state.selected.has(id) ? 'is-on' : ''}" data-pick="${id}" title="Vybrat (hromadne rozlozeni)"><i></i></button>` : ''}
      ${item.isTest || scope === 'champs' || scope === 'skins' ? badge : ''}
      <span class="card-rarity r-${item.rarity || 'DEFAULT'}"></span>
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(nameOf(item))}</div>
      <div class="card-meta">${escapeHtml(meta.join(' &middot; ')).replace(/&amp;middot;/g, '&middot;')}</div>
      ${skinChampionOf(item) ? skinsChipHtml(skinChampionOf(item)) : ''}
      <div class="card-actions">${actions.join('')}</div>
    </div>
  </div>`;
}

/** Karta testovaci bedny - vizualne oddelena, at si ji nikdo nesplete s ostrou. */
function testCardHtml(item) {
  const id = item.lootId;
  return `<div class="card card-test" data-id="${id}">
    <div class="card-img contain">
      <span class="card-glyph">TEST</span>
      <span class="card-badge is-test">SIMULACE</span>
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(nameOf(item))}</div>
      <div class="card-meta">nesahne na ucet &middot; jen ladeni animace</div>
      <div class="card-actions">
        ${btn(`testopen:${id}:1`, 'Otevrit 1', false)}
        ${btn(`testopen:${id}:5`, 'Otevrit 5', false)}
        ${btn(`testopen:${id}:10`, 'Otevrit 10', false)}
        ${btn(`testjackpot:${id}:3`, 'Jackpot', false)}
      </div>
    </div>
  </div>`;
}

function btn(action, label, disabled) {
  return `<button data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
}

function currencyForUpgrade(item) {
  if (item.upgradeEssenceName) return item.upgradeEssenceName;
  return item.type === 'CHAMPION_RENTAL' ? 'CURRENCY_champion' : 'CURRENCY_cosmetic';
}

function typeLabel(type) {
  return {
    CHEST: 'bedna', SKIN_RENTAL: 'skin shard', CHAMPION_RENTAL: 'champion shard',
    CHAMPION: 'sampion', WARDSKIN_RENTAL: 'ward shard', EMOTE: 'emote',
    MATERIAL: 'material', CURRENCY: 'mena', COMPANION: 'little legend',
  }[type] || type.toLowerCase().replace(/_/g, ' ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- akce ---------------------------------------------------------------

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  renderChestHeader();
  try {
    await fn();
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    state.busy = false;
    await loadLoot();
  }
}

async function openChest(lootId, repeat) {
  const item = state.byId.get(lootId);
  const recipe = recipeOfType(lootId, 'OPEN');
  if (!item || !recipe) return toast('Tenhle predmet nejde otevrit.', true);

  const times = Math.max(1, Math.min(repeat || 1, maxRepeats(recipe, lootId)));
  const ids = fillSlots(recipe, lootId);
  if (!ids) return toast('Chybi klic nebo jina surovina.', true);

  await withBusy(async () => {
    showReveal(`Otevirani: ${nameOf(item)}`);
    const res = await craft(recipe.recipeName, ids, times);
    const drops = dropsFrom(res);
    await revealDrops(drops, null, { reel: true });
    bumpStats({ opened: times });
    logDrops(drops);
  });
}

/**
 * Otevre testovaci bednu. Nikam neposila zadny request - odmeny se losuji
 * v prohlizeci ze skutecnych dat klienta. Do statistik ani historie nejdou,
 * at zustanou poctive.
 */
async function openTestChest(count, onlyRare) {
  if (state.busy || !globalThis.TestChest) return;
  state.busy = true;
  try {
    showReveal(onlyRare ? 'TEST - jackpot' : `TEST - otevirani ${count}x`);
    const drops = await TestChest.roll(count, onlyRare);
    await revealDrops(drops, 'TEST - simulace, na uctu se nic nezmenilo', { reel: true });
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    state.busy = false;
  }
}

async function forgeItem(lootId, repeat) {
  const item = state.byId.get(lootId);
  const recipe = recipeOfType(lootId, 'FORGE');
  if (!item || !recipe) return;

  const times = Math.max(1, Math.min(repeat || 1, maxRepeats(recipe, lootId)));
  const ids = fillSlots(recipe, lootId);
  if (!ids) return toast('Na to nemas dost surovin.', true);

  await withBusy(async () => {
    showReveal(`Vyroba z: ${nameOf(item)}`);
    const res = await craft(recipe.recipeName, ids, times);
    const drops = dropsFrom(res);
    await revealDrops(drops, 'Vyrobeno');
    logDrops(drops);
  });
}

async function openEverything() {
  const chests = itemsIn('chests')
    .filter((i) => !i.isTest)
    .filter((i) => maxRepeats(recipeOfType(i.lootId, 'OPEN'), i.lootId) > 0);
  if (!chests.length) return;

  await withBusy(async () => {
    showReveal('Otevirani vseho…');
    const all = [];
    let opened = 0;
    let aborted = false;

    for (const item of chests) {
      const recipe = recipeOfType(item.lootId, 'OPEN');
      const times = maxRepeats(recipe, item.lootId);
      const ids = fillSlots(recipe, item.lootId);
      if (!ids || times < 1) continue;

      $('#reveal-title').textContent = `Otevirani: ${nameOf(item)} x${times}`;
      try {
        const res = await craft(recipe.recipeName, ids, times);
        all.push(...dropsFrom(res));
        opened += times;
      } catch (err) {
        // kdyz odpadne klient, nema smysl bouchat hlavou do zdi u kazde dalsi bedny
        if (err.status === 502 || err.status === 503) {
          aborted = true;
          toast(`Klient prestal odpovidat. Stihlo se otevrit ${opened}.`, true);
          break;
        }
        toast(`${nameOf(item)}: ${err.message}`, true);
      }
      // klient si to potrebuje srovnat, nezavalime ho
      await sleep(220);
      const fresh = await lcu('/lol-loot/v1/player-loot');
      state.items = (fresh || []).filter((i) => i.lootId && i.count > 0);
      state.byId = new Map(state.items.map((i) => [i.lootId, i]));
    }

    await revealDrops(all, aborted ? `Preruseno po ${opened} bednach` : `Otevreno ${opened}x`, { reel: true });
    bumpStats({ opened });
    logDrops(all);
  });
}

async function disenchant(lootIds) {
  const items = lootIds.map((id) => state.byId.get(id)).filter(Boolean);
  if (!items.length) return;

  if (isMixedBatch(lootIds)) return toast('Nemichej testovaci polozky s ostrymi.', true);
  const test = isTestBatch(lootIds);

  const total = items.reduce((n, i) => n + i.disenchantValue * i.count, 0);
  const pieces = items.reduce((n, i) => n + i.count, 0);
  const ok = await confirmModal(
    test ? 'TEST - rozlozit?' : 'Rozlozit natrvalo?',
    `Rozlozis ${pieces} ${pieces === 1 ? 'shard' : 'shardu'} za zhruba ${total.toLocaleString('cs-CZ')} esence. ` +
    (test ? 'Tohle je simulace - na uctu se nic nestane.' : 'Tohle nejde vzit zpet - shardy budou fuc.')
  );
  if (!ok) return;

  await withBusy(async () => {
    showReveal('Rozkladani…');
    const gained = [];
    let done = 0;
    for (const item of items) {
      const recipe = recipeOfType(item.lootId, 'DISENCHANT');
      if (!recipe) continue;
      const ids = fillSlots(recipe, item.lootId);
      if (!ids) continue;
      try {
        const res = await craft(recipe.recipeName, ids, item.count);
        gained.push(...dropsFrom(res));
        done += item.count;     // do statistik jen to, co fakt proslo
      } catch (err) {
        if (err.status === 502 || err.status === 503) {
          toast(`Klient prestal odpovidat. Rozlozeno ${done}.`, true);
          break;
        }
        toast(`${nameOf(item)}: ${err.message}`, true);
      }
      await sleep(180);
    }
    state.selected.clear();
    await revealDrops(gained, test ? 'TEST - rozlozeno, ucet beze zmeny' : 'Rozlozeno');
    if (!test && done) bumpStats({ disenchanted: done });
  });
}

async function upgrade(lootId) {
  const item = state.byId.get(lootId);
  const recipe = recipeOfType(lootId, 'UPGRADE');
  if (!item || !recipe) return;

  const test = isTestBatch([lootId]);
  const champId = skinChampionOf(item);
  const ok = await confirmModal(
    test ? 'TEST - odemknout?' : 'Odemknout natrvalo?',
    `Utratis ${(item.upgradeEssenceValue || 0).toLocaleString('cs-CZ')} esence a ${nameOf(item)} bude tvuj natrvalo.` +
    (test ? ' Tohle je simulace - na uctu se nic nestane.' : ''),
    // u sampiona ukazat, jake skiny na nej uz mas - casto je to duvod ho odemknout
    champId ? skinsGalleryHtml(champId, championName(champId) || nameOf(item), { current: skinIdOf(item) }) : ''
  );
  if (!ok) return;

  const ids = fillSlots(recipe, lootId);
  if (!ids) return toast('Nemas dost esence.', true);

  await withBusy(async () => {
    showReveal('Odemykani…');
    const res = await craft(recipe.recipeName, ids, 1);
    const drops = dropsFrom(res);
    await revealDrops(drops, test ? 'TEST - odemykani (simulace)' : 'Odemykani', { unlock: true });
    if (!test) logDrops(drops);
  });
}

async function rerollSelected() {
  const ids = Array.from(state.selected);
  const recipe = ids.map((id) => recipeOfType(id, 'REROLL')).find(Boolean);
  if (!recipe) return toast('Tyhle shardy rerollnout nejdou.', true);

  const need = (recipe.slots || []).length || 3;
  // presne tolik, kolik recept chce. Driv se pri vetsim vyberu vzalo
  // libovolnych prvnich N a v potvrzeni se ani nerekl, ktere.
  if (ids.length !== need) return toast(`Reroll bere presne ${need} shardy, vybranych je ${ids.length}.`, true);
  if (ids.some((id) => !recipeOfType(id, 'REROLL'))) return toast('Nektery z vybranych shardu do rerollu nejde.', true);
  if (isMixedBatch(ids)) return toast('Nemichej testovaci shardy s ostrymi.', true);
  const test = isTestBatch(ids);

  const items = ids.map((id) => state.byId.get(id));
  const ok = await confirmModal(
    test ? 'TEST - rerollnout?' : 'Rerollnout?',
    `Spotrebujes: ${items.map(nameOf).join(', ')}. Dostanes za ne jeden nahodny skin natrvalo. ` +
    (test ? 'Tohle je simulace - na uctu se nic nestane.' : 'Nevratne.')
  );
  if (!ok) return;

  // co se polozi na oltar v animaci
  const offered = items.map((it) => ({ name: nameOf(it), img: imgUrl(it), rarity: it.rarity || 'DEFAULT' }));

  await withBusy(async () => {
    showReveal(test ? 'TEST - reroll (simulace)' : 'Reroll');
    const res = await craft(recipe.recipeName, ids, 1);
    const drops = dropsFrom(res);
    state.selected.clear();
    await revealDrops(drops, test ? 'TEST - reroll, ucet beze zmeny' : 'Reroll', { reroll: offered });
    if (!test) logDrops(drops);
  });
}

/**
 * Rezim rerollu: dole se objevi zasobnik se tremi sloty, nepouzitelne karty
 * se potlaci a vyber je omezeny na tri kusy. Bez nej byl reroll schovany
 * v dolni liste a objevil se az po nahodnem vyberu tri shardu.
 */
function setRerollMode(on) {
  state.rerollMode = !!on;
  state.selected.clear();
  document.body.classList.toggle('rr-on', state.rerollMode);
  const panel = $('[data-panel="skins"]');
  if (panel) panel.classList.toggle('rr-active', state.rerollMode);
  $('#reroll-mode').classList.toggle('is-on', state.rerollMode);
  renderGrid('skins', itemsIn('skins'));
  renderActionbar();
}

/** Navrhne tri nejlevnejsi ostre shardy; duplikaty (skin uz mas) maji prednost. */
function suggestReroll() {
  const candidates = itemsIn('skins')
    .filter((i) => !i.isTest && isShard(i) && recipeOfType(i.lootId, 'REROLL'))
    .sort((a, b) => (alreadyOwned(b) - alreadyOwned(a)) || (a.disenchantValue - b.disenchantValue));

  if (candidates.length < 3) return toast('Na reroll potrebujes aspon 3 skin shardy.', true);

  state.selected = new Set(candidates.slice(0, 3).map((i) => i.lootId));
  renderGrid('skins', itemsIn('skins'));
  renderActionbar();
  toast('Navrzeny nejlevnejsi shardy, duplikaty maji prednost. Pred rerollem se jeste potvrzuje.');
}

function renderRerollTray() {
  const tray = $('#rr-tray');
  if (!state.rerollMode) { tray.hidden = true; return; }

  const ids = Array.from(state.selected);
  $('#rr-slots').innerHTML = [0, 1, 2].map((i) => {
    const it = state.byId.get(ids[i]);
    if (!it) return '<div class="rr-slot"></div>';
    const img = imgUrl(it);
    return `<div class="rr-slot is-filled" data-remove="${it.lootId}" title="${escapeHtml(nameOf(it))}">
      ${img ? `<img src="${img}" alt="">` : ''}
    </div>`;
  }).join('');

  const left = 3 - ids.length;
  $('#rr-hint').textContent = left > 0
    ? `Vyber jeste ${left} ${left === 1 ? 'skin shard' : 'skin shardy'} - dostanes za ne jeden nahodny skin natrvalo.`
    : 'Pripraveno: tri shardy za jeden nahodny skin.';
  $('#rr-go').disabled = ids.length !== 3;
  tray.hidden = false;
}

// --- vlastnene skiny na sampiona ------------------------------------------

async function loadOwnedSkins() {
  try {
    const res = await fetch('/api/owned-skins');
    if (!res.ok) return;
    const data = await res.json();
    state.ownedSkins = data.byChampion || {};
    state.champions = data.champions || {};
  } catch (_) { /* bez skinu appka funguje dal, jen je neukaze */ }
}

/**
 * Id sampiona z loot polozky nebo dropu. Ostre shardy ho maji ve storeItemId,
 * dropy z craftu jen v lootId (CHAMPION_RENTAL_110, CHAMPION_110), simulator
 * v TEST_CHAMPION_110.
 */
function championIdOf(x) {
  if (!x) return 0;
  const type = String(x.type || '');
  if (!/^CHAMPION(_RENTAL)?$/.test(type)) return 0;
  if (x.storeItemId > 0) return x.storeItemId;
  const m = String(x.lootId || '').match(/^(?:TEST_)?CHAMPION(?:_RENTAL)?_(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** Id skinu ze shardu nebo dropu: storeItemId, CHAMPION_SKIN(_RENTAL)_40066, TEST_SKIN_40066. */
function skinIdOf(x) {
  if (!x || !/SKIN/.test(String(x.type || ''))) return 0;
  if (x.storeItemId > 1000) return x.storeItemId;
  const m = String(x.lootId || '').match(/^(?:TEST_SKIN_|CHAMPION_SKIN(?:_RENTAL)?_)(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Sampion skinu (id skinu / 1000). Jen u skinu - u champion shardu skiny
 * neukazujeme: kdo sampiona nema, nemuze na nej mit ani skin.
 */
function skinChampionOf(x) {
  const skin = skinIdOf(x);
  return skin ? Math.floor(skin / 1000) : 0;
}

/**
 * Cely splash art. V lootu je jen "centered" (priblizeny, rozmazane pozadi);
 * "uncentered" je cela kresba. Odvozeni sedi u vsech 2149 skinu League
 * (overeno proti skins.json), takze nezavisi na serveru.
 */
function fullSplashOf(path) {
  return String(path || '').replace(/_splash_centered_/i, '_splash_uncentered_');
}

function championName(id) {
  return state.champions[id] || '';
}

function ownedSkinsFor(championId) {
  return state.ownedSkins[championId] || [];
}

const skinsWord = (n) => plural(n, 'skin', 'skiny', 'skinu');

/** Maly prehled na kartu: prekryvajici se kolecka a pocet. Nic, kdyz skin neni. */
function skinsChipHtml(championId) {
  const skins = ownedSkinsFor(championId);
  if (!skins.length) return '';
  const names = skins.map((sk) => sk.name).join(', ');
  return `<div class="skins-chip" title="${escapeHtml(names)}">
    <span class="skins-stack">${skins.slice(0, 4).map((sk) =>
      `<img src="/lcu${sk.img}" alt="" loading="lazy" onerror="this.style.display='none'">`).join('')}</span>
    <span><b>${skins.length}</b> ${skinsWord(skins.length)} na sampiona</span>
  </div>`;
}

/**
 * Galerie skinu - do potvrzeni pred odemknutim, do odhaleni a do detailu.
 * opts.current = id skinu, o kterem je rec (zvyrazni se, kdyz ho uz mas)
 * opts.clickable = v detailu jde kliknutim zobrazit splash daneho skinu
 * opts.max = kolik ukazat, zbytek jako "+N dalsich"
 */
function skinsGalleryHtml(championId, champName, opts) {
  const o = opts || {};
  const skins = ownedSkinsFor(championId);
  // jmeno bez sklonovani ("Janna: tvoje skiny") - "skiny na Janna" by nebylo cesky
  const name = escapeHtml(champName || championName(championId) || 'Sampion');
  if (!skins.length) {
    return `<div class="skins-owned"><div class="skins-none">${name}: zatim nemas zadny skin.</div></div>`;
  }
  const max = o.max || 12;
  const shown = skins.slice(0, max);
  return `<div class="skins-owned">
    <div class="skins-owned-title">${name}: tvoje skiny <span>${skins.length}</span></div>
    <div class="skins-owned-grid">
      ${shown.map((sk) => `<div class="skin-mini rare-${sk.rarity}${sk.id === o.current ? ' is-this' : ''}${sk.id === o.active ? ' is-active' : ''}"${o.clickable ? ` data-preview="${sk.id}" title="Zobrazit cely splash"` : ''}>
        <img class="skin-mini-img" src="/lcu${sk.img}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        ${sk.rarity !== 'DEFAULT' ? `<img class="skin-mini-gem" src="${Reel.GEM(sk.rarity)}" alt="${sk.rarity}">` : ''}
        <span>${escapeHtml(sk.name)}</span>
      </div>`).join('')}
      ${skins.length > max ? `<div class="skins-more">+${skins.length - max} dalsich</div>` : ''}
    </div>
  </div>`;
}

// --- detail: cely splash + skiny na sampiona -----------------------------

let detailCtx = null;
let lastDrops = [];   // dropy z posledniho odhaleni, at jde detail otevrit i z nich

/** Detail skin shardu z inventare (karta v tabu). */
function openDetail(lootId) {
  const item = state.byId.get(lootId);
  if (!item || !skinIdOf(item)) return null;
  return showDetail({
    item,
    skinId: skinIdOf(item),
    name: nameOf(item), rarity: item.rarity || 'DEFAULT',
    tile: imgUrl(item),
    centered: item.splashPath ? '/lcu' + item.splashPath : '',
    championId: skinChampionOf(item),
  });
}

/** Detail skinu z odhaleni - kdyz uz je v inventari, i s akcemi. */
function openDetailFromDrop(drop) {
  if (!drop || !skinIdOf(drop)) return null;
  if (drop.lootId && state.byId.get(drop.lootId)) return openDetail(drop.lootId);
  return showDetail({
    item: null,
    skinId: skinIdOf(drop),
    name: drop.name, rarity: drop.rarity || 'DEFAULT',
    tile: drop.img, centered: drop.splash || '',
    championId: skinChampionOf(drop),
  });
}

async function showDetail(ctx) {
  stopVideo();
  detailCtx = ctx;
  ctx.previewId = 0;
  ctx.splash = fullSplashOf(ctx.centered);
  // napred cely splash odvozeny z lootu, pak priblizeny; miniatura jen jako
  // posledni zachrana (a bez nafouknuti - viz .is-fallback)
  showArt([ctx.splash, ctx.centered], ctx.tile, ctx, null);
  renderDetail(ctx);
  $('#detail').hidden = false;
  document.body.classList.add('detail-open');

  try {
    const res = await fetch('/api/skin/' + ctx.skinId);
    if (!res.ok) return ctx;
    const art = await res.json();
    if (detailCtx !== ctx) return ctx;   // mezitim otevreny jiny detail
    ctx.championName = art.championName || '';
    if (!ctx.rarity || ctx.rarity === 'DEFAULT') ctx.rarity = art.rarity || 'DEFAULT';
    // drop bez splashPath (napr. ze simulatoru) - dozvime se ho az ze serveru
    if (!ctx.splash && art.splash) {
      ctx.splash = '/lcu' + art.splash;
      if (!ctx.previewId) showArt([ctx.splash], ctx.tile, ctx, null);
    }
    renderDetail(ctx);
  } catch (_) { /* jmeno sampiona bude chybet, obrazek uz je */ }
  return ctx;
}

/**
 * Zkusi zdroje popořadě a ukaze prvni, ktery se nacte. Do te doby je videt
 * rozmazana miniatura. Kdyz nic nevyjde, miniatura se ukaze bez roztazeni.
 */
function showArt(sources, tile, ctx, preview) {
  const img = $('#detail-img');
  const art = $('#detail-art');
  const rarity = preview ? preview.rarity : ctx.rarity;
  const rc = `var(--r-${String(rarity || 'DEFAULT').toLowerCase()}, var(--gold))`;
  art.style.setProperty('--rc', rc);
  $('#detail-box').style.setProperty('--rc', rc);
  $('#detail-caption').innerHTML = preview
    ? `<span class="detail-cap-label">Tvuj skin</span><span class="detail-cap-name">${escapeHtml(preview.name)}</span>
       <button class="ghost-btn" data-detail-back>Zpet na ${escapeHtml(ctx.name)}</button>`
    : '';

  const list = [...new Set(sources.filter(Boolean))];
  const token = {};
  art.loadToken = token;
  art.classList.remove('is-fallback');

  const useTile = () => {
    if (tile) img.src = tile; else img.removeAttribute('src');   // ne src = '' (dotaz na stranku)
    img.dataset.want = tile || '';
    art.classList.remove('is-loading');
    art.classList.add('is-fallback');
  };

  if (!list.length) return useTile();
  if (typeof Image !== 'function') {   // bez prohlizece (testy): rovnou prvni zdroj
    img.src = list[0];
    img.dataset.want = list[0];
    return;
  }

  if (tile) img.src = tile;
  art.classList.add('is-loading');
  (function tryNext(i) {
    if (art.loadToken !== token) return;
    if (i >= list.length) return useTile();
    const pre = new Image();
    pre.onload = () => {
      if (art.loadToken !== token) return;
      img.src = list[i];
      img.dataset.want = list[i];
      art.classList.remove('is-loading');
    };
    pre.onerror = () => tryNext(i + 1);
    pre.src = list[i];
  })(0);
}

// --- video prohlidka (SkinSpotlights) -------------------------------------

function stopVideo() {
  const box = $('#detail-video');
  if (box) box.innerHTML = '';   // odebrat iframe = zastavit prehravani
  $('#detail-art').classList.remove('is-video');
  if (detailCtx) detailCtx.videoOn = false;
}

async function toggleVideo() {
  const ctx = detailCtx;
  if (!ctx) return;
  if (ctx.videoOn) { stopVideo(); renderDetail(ctx); return; }

  // video skinu, ktery je prave videt (shard, nebo tvuj skin v nahledu)
  const shown = ctx.previewId ? ownedSkinsFor(ctx.championId).find((x) => x.id === ctx.previewId) : null;
  const name = shown ? shown.name : ctx.name;
  ctx.videoLoading = true;
  renderDetail(ctx);

  let data = null;
  try {
    const res = await fetch('/api/spotlight?name=' + encodeURIComponent(name));
    if (res.ok) data = await res.json();
  } catch (_) { /* nize nabidneme odkaz */ }
  if (detailCtx !== ctx) return;
  ctx.videoLoading = false;

  const box = $('#detail-video');
  const searchUrl = (data && data.searchUrl)
    || 'https://www.youtube.com/results?search_query=' + encodeURIComponent('SkinSpotlights ' + name);

  if (data && /^[\w-]{11}$/.test(data.videoId || '')) {
    box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${data.videoId}?autoplay=1&rel=0&modestbranding=1"
      title="${escapeHtml(data.title || name)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  } else {
    // nenaslo se nebo YouTube zrovna neodpovida - aspon odkaz, zadne vyskakovaci okno
    box.innerHTML = `<div class="detail-video-miss">
      <p>Video k "${escapeHtml(name)}" se nepodarilo najit.</p>
      <a class="big-btn" href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener">Hledat na YouTube</a>
    </div>`;
  }
  ctx.videoOn = true;
  $('#detail-art').classList.add('is-video');
  renderDetail(ctx);
}

function renderDetail(ctx) {
  const item = ctx.item;
  const rarity = ctx.rarity || 'DEFAULT';
  const champ = ctx.championName || championName(ctx.championId);
  const tags = [];
  if (item) {
    if (item.isTest) tags.push('<span class="is-test">SIMULACE</span>');
    tags.push(isShard(item) ? '<span class="is-shard">SHARD</span>' : '<span class="is-perm">PERMANENT</span>');
    if (isShard(item) && alreadyOwned(item)) tags.push('<span class="is-owned"><i></i>VLASTNIS</span>');
  }

  // akce jen u veci, ktere jsou v inventari
  const actions = [];
  if (item) {
    const id = item.lootId;
    const upg = recipeOfType(id, 'UPGRADE');
    const dis = recipeOfType(id, 'DISENCHANT');
    if (upg && !alreadyOwned(item)) {
      const cost = item.upgradeEssenceValue || 0;
      const enough = item.isTest || countOf(item.upgradeEssenceName || currencyForUpgrade(item)) >= cost;
      actions.push(`<button class="big-btn" data-action="upgrade:${id}" ${enough ? '' : 'disabled'}>Odemknout (${cost.toLocaleString('cs-CZ')})</button>`);
    }
    if (dis) actions.push(`<button class="ghost-btn" data-action="disenchant:${id}">Rozlozit (+${(item.disenchantValue * item.count).toLocaleString('cs-CZ')})</button>`);
  }

  const videoLabel = ctx.videoLoading ? 'Hledam video…' : ctx.videoOn ? 'Zpet na splash' : 'Video prohlidka';
  actions.unshift(`<button class="ghost-btn video-btn ${ctx.videoOn ? 'is-on' : ''}" data-video ${ctx.videoLoading ? 'disabled' : ''} title="Detailni prohlidka skinu od SkinSpotlights (YouTube)"><i></i>${videoLabel}</button>`);

  $('#detail-info').innerHTML = `
    <div class="detail-head">
      <div class="detail-name">
        ${rarity !== 'DEFAULT' ? `<img src="${Reel.GEM(rarity)}" alt="${rarity}" title="${rarity}">` : ''}
        <span>${escapeHtml(ctx.name)}</span>
      </div>
      <div class="detail-sub">${escapeHtml(champ)}${rarity !== 'DEFAULT' ? ` &middot; ${rarity.toLowerCase()}` : ''}</div>
      ${tags.length ? `<div class="detail-tags">${tags.join('')}</div>` : ''}
    </div>
    ${actions.length ? `<div class="detail-actions">${actions.join('')}</div>` : ''}`;

  $('#detail-skins').innerHTML = ctx.championId
    ? skinsGalleryHtml(ctx.championId, champ, { current: ctx.skinId, active: ctx.previewId, clickable: true, max: 999 })
    : '';
}

/** Klik na skin v galerii ukaze jeho splash; znovu (nebo Zpet) vrati puvodni. */
function previewSkin(skinId) {
  const ctx = detailCtx;
  if (!ctx) return;
  stopVideo();
  const sk = ownedSkinsFor(ctx.championId).find((x) => x.id === skinId);
  if (!sk || ctx.previewId === skinId || skinId === ctx.skinId) {
    ctx.previewId = 0;
    showArt([ctx.splash, ctx.centered], ctx.tile, ctx, null);
  } else {
    ctx.previewId = skinId;
    showArt([sk.splash ? '/lcu' + sk.splash : ''], '/lcu' + sk.img, ctx, sk);
  }
  renderDetail(ctx);
}

function closeDetail() {
  stopVideo();
  $('#detail').hidden = true;
  document.body.classList.remove('detail-open');
  detailCtx = null;
}

// --- mythic shop ---------------------------------------------------------

const ME_ICON = '/lcu' + ART + 'Mythic_Essence_490px.png';

const SHOP_KIND = { skin: 'Skin', chroma: 'Chroma', icon: 'Ikona', emote: 'Emote', other: 'Polozka' };

async function loadShop() {
  if (state.shop.loading) return;
  state.shop.loading = true;
  state.shop.error = null;
  renderShop();
  try {
    const res = await fetch('/api/mythic-shop');
    if (!res.ok) throw new Error(res.status === 503 ? 'Klient nebezi.' : `Obchod nejde nacist (${res.status}).`);
    const data = await res.json();
    state.shop.stores = data.stores || [];

    // testovaci nabidka, at jde nakup vyzkouset bez utraceni esence
    if (globalThis.TestChest) {
      try {
        if (!testOffer) testOffer = await TestChest.shopOffer();
        state.shop.stores = state.shop.stores.concat([{
          id: 'TEST_SHOP', label: 'Testovaci nabidka (simulace)', endTime: null, entries: [testOffer], isTest: true,
        }]);
      } catch (_) { /* bez dat z klienta testovaci nabidka nebude */ }
    }
    state.shop.loadedAt = Date.now();
  } catch (err) {
    state.shop.error = err.message || String(err);
  } finally {
    state.shop.loading = false;
    renderShop();
  }
}

function shopEntries() {
  return state.shop.stores.flatMap((st) => st.entries);
}

/** "konci za 2 d 5 h" / "konci za 3 h 12 min" */
function endsIn(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return 'konci';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const hrs = Math.floor((min % 1440) / 60);
  if (d) return `konci za ${d} d ${hrs} h`;
  if (hrs) return `konci za ${hrs} h ${min % 60} min`;
  return `konci za ${min} min`;
}

function renderShop() {
  const grid = $('#grid-shop');
  if (!grid) return;

  const me = countOf('CURRENCY_mythic');
  $('#shop-balance').innerHTML = `<img src="${ME_ICON}" alt=""><b>${me.toLocaleString('cs-CZ')}</b><span>mythic esence</span>`;

  const buyable = shopEntries().filter((e) => !e.owned && !e.isTest).length;
  const pill = $('.pill[data-count="shop"]');
  if (pill) pill.textContent = state.shop.loadedAt ? buyable : '-';

  if (state.shop.loading && !state.shop.stores.length) { grid.innerHTML = '<div class="empty">Nacitam obchod…</div>'; return; }
  if (state.shop.error) { grid.innerHTML = `<div class="empty">${escapeHtml(state.shop.error)}</div>`; return; }
  if (!state.shop.stores.length) { grid.innerHTML = '<div class="empty">V obchode ted nic neni.</div>'; return; }

  grid.innerHTML = state.shop.stores.map((st) => `
    <section class="group shop-group ${st.isTest ? 'is-test' : ''}">
      <header class="group-head">
        <h3>${escapeHtml(st.label)} <span class="group-count">${st.entries.length}</span></h3>
        <span class="group-note">${escapeHtml(endsIn(st.endTime))}</span>
      </header>
      <div class="grid">${st.entries.map(shopCardHtml).join('')}</div>
    </section>`).join('');
}

function shopCardHtml(e) {
  const me = countOf('CURRENCY_mythic');
  const enough = e.isTest || me >= e.price;
  const img = e.img ? '/lcu' + e.img : '';
  const contain = e.kind !== 'skin';

  let action;
  if (e.owned) action = '<button disabled>Uz vlastnis</button>';
  else if (!enough) action = `<button disabled>Chybi ${(e.price - me).toLocaleString('cs-CZ')} esence</button>`;
  else action = `<button data-action="buy:${escapeHtml(e.catalogEntryId)}">Koupit</button>`;

  return `<div class="card shop-card ${e.owned ? 'is-owned' : ''} ${e.isTest ? 'card-test' : ''}">
    <div class="card-img ${contain ? 'contain' : ''}">
      ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="card-glyph">${glyph({ itemDesc: e.name })}</span>`}
      ${e.rarity && e.rarity !== 'DEFAULT' ? `<img class="shop-gem" src="${Reel.GEM(e.rarity)}" alt="${e.rarity}" title="${e.rarity}">` : ''}
      ${e.owned ? '<span class="owned-ribbon" title="Tohle uz mas"><i></i>VLASTNIS</span>' : ''}
      ${e.isTest ? '<span class="card-badge is-test">SIMULACE</span>' : ''}
      <span class="card-rarity r-${e.rarity || 'DEFAULT'}"></span>
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(e.name)}</div>
      <div class="card-meta">${SHOP_KIND[e.kind] || 'Polozka'}</div>
      <div class="shop-price ${enough ? '' : 'is-short'}"><img src="${ME_ICON}" alt=""><b>${e.price}</b></div>
      <div class="card-actions">${action}</div>
    </div>
  </div>`;
}

/**
 * Druha (a posledni) cesta, kterou appka na uctu neco meni - vedle craft().
 * Testovaci nabidka se odchyti tady, driv nez cokoliv odejde. Na vysledek
 * nakupu se ceka, uspech se nehlasi naslepo: kdyby se nepotvrdil, hrac by
 * zkusil koupit znovu.
 */
async function purchase(entry) {
  if (entry.isTest) {
    if (!globalThis.TestChest) throw new Error('Testovaci nabidka bez simulatoru.');
    await sleep(400);
    return { status: 'Success', simulated: true };
  }

  const body = {
    storeId: entry.storeId,
    catalogEntryId: entry.catalogEntryId,
    quantity: 1,
    paymentOptions: [entry.paymentKey],
    // jednotka ze schematu klienta nevyplyva; 15000 je bezpecne v obou vykladech
    // (15 s v ms, nebo jen dlouha horni mez v s) - odpoved prijde, jakmile nakup dobehne
    purchaseTimeOut: 15000,
  };
  const created = await lcu('/lol-shoppefront/v1/purchases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const purchaseId = typeof created === 'string' ? created : (created && created.id);
  if (!purchaseId) throw new Error('Klient nevratil cislo nakupu - zkontroluj v klientovi, jestli probehl.');

  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const st = await lcu('/lol-shoppefront/v1/purchases/' + encodeURIComponent(purchaseId));
    const status = String((st && st.status) || '');
    if (/^(success|complete)/i.test(status)) return st;
    if (/^(failure|fail|error)/i.test(status)) throw new Error('Nakup se nepovedl, klient hlasi chybu. Esence ti zustala.');
    await sleep(400);
  }
  throw new Error('Nakup se do 20 s nepotvrdil. Nez to zkusis znovu, zkontroluj v klientovi, jestli neprobehl.');
}

async function buyOffer(catalogEntryId) {
  const entry = shopEntries().find((e) => e.catalogEntryId === catalogEntryId);
  if (!entry) return toast('Tahle nabidka uz v obchode neni.', true);
  if (entry.owned) return toast('Tohle uz vlastnis.', true);

  const me = countOf('CURRENCY_mythic');
  if (!entry.isTest && me < entry.price) return toast(`Chybi ti ${entry.price - me} mythic esence.`, true);

  const ok = await confirmModal(
    entry.isTest ? 'TEST - koupit?' : 'Koupit za mythic esenci?',
    `${entry.name} za ${entry.price} mythic esence` +
    (entry.isTest ? '. Tohle je simulace - na uctu se nic nestane.' : ` (zbyde ti ${me - entry.price}). Nakup nejde vratit.`)
  );
  if (!ok) return;

  await withBusy(async () => {
    showReveal(entry.isTest ? 'TEST - mythic shop (simulace)' : 'Mythic shop');
    await purchase(entry);
    const drop = {
      name: entry.name, img: entry.img ? '/lcu' + entry.img : '', icon: entry.kind !== 'skin',
      rarity: entry.rarity || 'DEFAULT', type: entry.kind.toUpperCase(), count: 1, lootId: entry.catalogEntryId,
    };
    // vis, co kupujes - obrad, zadne toceni
    await revealDrops([drop], entry.isTest ? 'TEST - koupeno, ucet beze zmeny' : 'Koupeno', { unlock: true });
  });
  loadShop();
}

// --- reveal -------------------------------------------------------------

let skipAnim = false;
let testShards = null;   // vylosuje se jednou za nacteni stranky
let testOffer = null;    // testovaci nabidka v mythic shopu
let gateTimer = null;

function showReveal(title) {
  skipAnim = false;
  const reveal = $('#reveal');
  reveal.classList.remove('is-cinematic', 'is-leaving');
  $('#reveal-title').textContent = title;
  $('#reveal-cards').innerHTML = '';
  $('#reveal-close').hidden = true;
  $('#reveal-skip').hidden = true;
  reveal.hidden = false;

  // brana se rozjede - at to nevyskoci jako obycejny popup. Behem te vteriny
  // stejne bezi craft, takze se ceka na klienta pod animaci.
  document.body.classList.add('reveal-open');   // pod odhalenim se nema rolovat
  reveal.classList.add('is-entering');
  clearTimeout(gateTimer);
  gateTimer = setTimeout(() => reveal.classList.remove('is-entering'), 900);
  if (globalThis.Reel) Reel.Sfx.gateOpen();
}

/** Zavre odhaleni branou, ne skokem. */
function closeReveal() {
  const reveal = $('#reveal');
  if (reveal.hidden) return;

  reveal.classList.remove('is-entering');
  reveal.classList.add('is-leaving');
  if (globalThis.Reel) Reel.Sfx.gateClose();

  clearTimeout(gateTimer);
  gateTimer = setTimeout(() => {
    reveal.hidden = true;
    reveal.classList.remove('is-leaving', 'is-cinematic');
    document.body.classList.remove('reveal-open');
  }, 360);
}

/**
 * Ukaze odmeny. Rezim se vybira podle toho, kolik toho padlo:
 *   1 vec        - jedna velka ruleta
 *   2-5 veci     - tolik pasu nad sebou, kazdy dojede o chvili pozdeji
 *   6+ veci      - kaskada: mrizka rubem nahoru, karty se postupne otaceji
 *   opts.unlock  - obrad odemknuti (nic se netoci, vysledek je predem jasny)
 * Bez `opts` se karty jen vysypou - to staci na hromadne rozkladani.
 */
async function revealDrops(drops, title, opts) {
  const wrap = $('#reveal-cards');
  if (title) $('#reveal-title').textContent = title;

  if (!drops.length) {
    wrap.innerHTML = '<div class="empty">Klient nevratil zadny obsah.</div>';
    $('#reveal-close').hidden = false;
    return;
  }

  wrap.innerHTML = '';

  if (opts && (opts.reel || opts.unlock || opts.reroll) && globalThis.Reel) {
    $('#reveal').classList.add('is-cinematic');

    const host = document.createElement('div');
    host.className = 'reel-host';
    wrap.appendChild(host);
    $('#reveal-skip').hidden = false;

    const best = drops.reduce((b, d) =>
      RARITY_ORDER.indexOf(d.rarity) > RARITY_ORDER.indexOf(b.rarity) ? d : b, drops[0]);

    let winner = best;
    if (opts.reroll) {
      winner = drops[0];
      await Reel.reroll(opts.reroll, winner, fillerPool(drops), host);
    } else if (opts.unlock) {
      winner = drops[0];
      await Reel.unlock(winner, host);
    } else if (drops.length === 1) {
      await Reel.play(drops[0], fillerPool(drops), host);
    } else if (drops.length <= Reel.MAX_ROWS) {
      await Reel.playMulti(drops, fillerPool(drops), host);
    } else {
      await Reel.cascade(drops, host);
    }

    // vic veci z beden: po chvilce misto animace prehledny souhrn vseho, co padlo
    if (opts.reel && drops.length > 1) {
      await sleep(skipAnim ? 0 : Reel.Motion.t(1200));
      $('#reveal-skip').hidden = true;
      host.classList.add('is-fading');
      await sleep(skipAnim ? 0 : 280);
      host.innerHTML = summaryHtml(drops);
      host.classList.remove('is-fading');
      $('#reveal-close').hidden = false;
      return;
    }

    $('#reveal-skip').hidden = true;
    wrap.insertAdjacentHTML('beforeend', Reel.bannerHtml(winner, ''));
    lastDrops = [winner];
    if (skinChampionOf(winner)) {
      wrap.insertAdjacentHTML('beforeend', '<button class="ghost-btn detail-open-btn" data-drop="0">Detail skinu</button>');
      wrap.insertAdjacentHTML('beforeend', skinsGalleryHtml(skinChampionOf(winner), championName(skinChampionOf(winner)), { current: skinIdOf(winner) }));
    }
    $('#reveal-close').hidden = false;
    return;
  }

  $('#reveal-skip').hidden = drops.length < 4;
  await popIn(drops, wrap);
  $('#reveal-skip').hidden = true;
  $('#reveal-close').hidden = false;
}

/** Cesky tvar podle poctu: 1 shard, 2 shardy, 5 shardu. */
function plural(n, one, few, many) {
  if (n === 1) return one;
  return n >= 2 && n <= 4 ? few : many;
}

/**
 * Souhrn vseho, co padlo. Stejne veci se slouci (esence z deseti beden =
 * jedna karta), serazene od nejvzacnejsiho. Nahore soucty podle druhu.
 */
function summaryHtml(drops) {
  const merged = new Map();
  for (const d of drops) {
    // podle nazvu, ne lootId: simulator dava vsem menam stejne lootId
    const key = `${d.type}|${d.name}|${d.rarity}`;
    const prev = merged.get(key);
    if (prev) prev.count += d.count || 1;
    else merged.set(key, { ...d, count: d.count || 1 });
  }
  const items = [...merged.values()].sort((a, b) =>
    (RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)) || a.name.localeCompare(b.name, 'cs'));

  const sum = (pred) => items.filter(pred).reduce((n, i) => n + i.count, 0);
  const totals = [];
  const skins = sum((i) => /SKIN/.test(i.type));
  const champs = sum((i) => /^CHAMPION/.test(i.type));
  if (skins) totals.push(`${skins} ${plural(skins, 'skin shard', 'skin shardy', 'skin shardu')}`);
  if (champs) totals.push(`${champs} ${plural(champs, 'champion shard', 'champion shardy', 'champion shardu')}`);
  for (const i of items.filter((x) => x.type === 'CURRENCY')) totals.push(`+${i.count.toLocaleString('cs-CZ')} ${i.name.toLowerCase()}`);
  for (const i of items.filter((x) => !/SKIN|^CHAMPION|^CURRENCY$/.test(x.type))) totals.push(`${i.count}&times; ${escapeHtml(i.name.toLowerCase())}`);

  const best = items[0];
  lastDrops = items;
  const cards = items.map((d, idx) => `
    <div class="sum-card rare-${d.rarity || 'DEFAULT'} ${d === best && RARITY_ORDER.indexOf(d.rarity) > 0 ? 'is-top' : ''}" ${skinIdOf(d) ? `data-drop="${idx}" title="Zobrazit detail"` : ''} style="animation-delay:${Math.min(idx * 45, 900)}ms">
      <div class="sum-img ${d.icon ? 'contain' : ''}">
        ${d.img ? `<img src="${d.img}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<span class="sum-glyph"></span>'}
        ${d.rarity && d.rarity !== 'DEFAULT' ? `<img class="sum-gem" src="${Reel.GEM(d.rarity)}" alt="${d.rarity}" title="${d.rarity}">` : ''}
        ${d.count > 1 ? `<span class="sum-count">&times;${d.count.toLocaleString('cs-CZ')}</span>` : ''}
      </div>
      <div class="sum-name">${escapeHtml(d.name)}</div>
      ${skinChampionOf(d) ? skinsChipHtml(skinChampionOf(d)) : ''}
      <div class="sum-type">${escapeHtml(typeLabel(d.type || ''))}</div>
    </div>`).join('');

  return `<div class="summary">
    <div class="summary-head">
      <span class="summary-title">CO TI PADLO</span>
      <span class="summary-count">${drops.length} ${plural(drops.length, 'predmet', 'predmety', 'predmetu')}</span>
    </div>
    <div class="summary-totals">${totals.map((t) => `<span>${t}</span>`).join('')}</div>
    <div class="summary-grid">${cards}</div>
  </div>`;
}

/** Postupne vysype karty do radku. */
async function popIn(drops, wrap) {
  const row = document.createElement('div');
  row.className = 'drop-row';
  wrap.appendChild(row);

  for (const d of drops) {
    const el = document.createElement('div');
    el.className = `drop rare-${d.rarity} ${d.icon ? 'icon' : ''}`;
    el.innerHTML = `
      ${d.img ? `<img src="${d.img}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="drop-name">${escapeHtml(d.name)}${d.count > 1 ? ` x${d.count}` : ''}</div>
      <div class="drop-type">${escapeHtml(typeLabel(d.type || ''))}</div>`;
    row.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    if (!skipAnim) await sleep(RARITY_ORDER.indexOf(d.rarity) > 0 ? 420 : 180);
  }
}

/**
 * Vypln pasu rulety. Bere hracuv vlastni loot, at kolem probihaji veci,
 * ktere zna - a doplni to tim, co prave padlo.
 */
function fillerPool(drops) {
  const mine = state.items
    .filter((i) => !i.isTest && imgUrl(i) && !isIcon(i))
    .map((i) => ({ name: nameOf(i), img: imgUrl(i), rarity: i.rarity || 'DEFAULT' }));

  // stejny obrazek jen jednou: sampion a jeho shard sdileji splash a na pasu
  // by se pak dva shodne kousky mohly potkat vedle sebe
  const seen = new Set();
  const pool = [];
  for (const tile of mine.concat(drops.map((d) => ({ name: d.name, img: d.img, rarity: d.rarity })))) {
    if (!tile.img || seen.has(tile.img)) continue;
    seen.add(tile.img);
    pool.push(tile);
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// --- session log --------------------------------------------------------

function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; }
}

function logDrops(drops) {
  if (!drops.length) return;
  const hist = readStore('gamba.history', []);
  const now = Date.now();
  hist.unshift(...drops.map((d) => ({ ...d, at: now })));
  localStorage.setItem('gamba.history', JSON.stringify(hist.slice(0, 400)));
  renderSession();
}

function bumpStats(delta) {
  const s = readStore('gamba.stats', { opened: 0, disenchanted: 0 });
  for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
  localStorage.setItem('gamba.stats', JSON.stringify(s));
  renderSession();
}

function renderSession() {
  const hist = readStore('gamba.history', []);
  const stats = readStore('gamba.stats', { opened: 0, disenchanted: 0 });

  const best = hist.reduce((b, d) => (RARITY_ORDER.indexOf(d.rarity) > RARITY_ORDER.indexOf(b.rarity || 'DEFAULT') ? d : b), {});
  const skins = hist.filter((d) => d.type === 'SKIN_RENTAL' || d.type === 'CHAMPION_SKIN').length;

  $('#stats').innerHTML = `
    <div class="stat"><b>${stats.opened || 0}</b><span>otevrenych beden</span></div>
    <div class="stat"><b>${hist.length}</b><span>ziskanych predmetu</span></div>
    <div class="stat"><b>${skins}</b><span>skin shardu</span></div>
    <div class="stat"><b>${stats.disenchanted || 0}</b><span>rozlozenych shardu</span></div>
    <div class="stat"><b>${best.rarity && best.rarity !== 'DEFAULT' ? best.rarity.toLowerCase() : '-'}</b><span>nejlepsi drop${best.name ? ': ' + escapeHtml(best.name) : ''}</span></div>`;

  $('#history').innerHTML = hist.slice(0, 120).map((d) => `
    <div class="h-row rare-${d.rarity}">
      ${d.img ? `<img src="${d.img}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <span class="h-name">${escapeHtml(d.name)}${d.count > 1 ? ` x${d.count}` : ''}</span>
      <span>${escapeHtml(typeLabel(d.type || ''))}</span>
      <span class="h-time">${new Date(d.at).toLocaleTimeString('cs-CZ')}</span>
    </div>`).join('') || '<div class="empty">Zatim nic. Otevri bednu.</div>';
}

// --- vyber shardu -------------------------------------------------------

function toggleSelect(lootId) {
  if (state.rerollMode && !state.selected.has(lootId)) {
    if (!recipeOfType(lootId, 'REROLL')) return toast('Tenhle shard do rerollu nejde.', true);
    if (state.selected.size >= 3) return toast('Reroll bere presne 3 shardy. Nejdriv nejaky vyndej.', true);
    if (isMixedBatch([...state.selected, lootId])) return toast('Nemichej testovaci shardy s ostrymi.', true);
  }
  if (state.selected.has(lootId)) state.selected.delete(lootId);
  else state.selected.add(lootId);
  renderGrid(state.scope, itemsIn(state.scope));
  renderActionbar();
}

function renderActionbar() {
  renderRerollTray();
  const bar = $('#actionbar');
  if (state.rerollMode) { bar.hidden = true; return; }
  const ids = Array.from(state.selected);
  if (!ids.length) { bar.hidden = true; return; }

  const items = ids.map((id) => state.byId.get(id)).filter(Boolean);
  const pieces = items.reduce((n, i) => n + i.count, 0);
  const value = items.reduce((n, i) => n + i.disenchantValue * i.count, 0);

  $('#ab-count').textContent = `${ids.length} vybrano (${pieces} ks)`;
  $('#ab-value').textContent = `+${value.toLocaleString('cs-CZ')} esence za rozlozeni`;
  bar.hidden = false;
}

// --- modal + toast ------------------------------------------------------

function confirmModal(title, text, extraHtml) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-extra').innerHTML = extraHtml || '';
    $('#modal').classList.toggle('is-wide', !!extraHtml);
    $('#modal').hidden = false;

    const done = (val) => {
      $('#modal').hidden = true;
      $('#modal-ok').onclick = null;
      $('#modal-cancel').onclick = null;
      resolve(val);
    };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

// --- eventy -------------------------------------------------------------

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  if (state.rerollMode) setRerollMode(false);
  $$('.tab-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === btn.dataset.tab));
  state.scope = btn.dataset.tab;
  state.selected.clear();
  renderActionbar();
  if (state.scope === 'shop') {
    // rotace a vlastnictvi se meni - po minute radsi nacist znovu
    if (Date.now() - state.shop.loadedAt > 60000) loadShop();
    else renderShop();
    return;
  }
  renderGrid(state.scope, itemsIn(state.scope));
});

document.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    e.stopPropagation();
    // akce z detailu: detail zavrit, at potvrzeni a odhaleni nejsou pod nim
    if (!$('#detail').hidden) closeDetail();
    const [what, id, arg] = actionBtn.dataset.action.split(':');
    if (what === 'open') openChest(id, Number(arg));
    if (what === 'forge') forgeItem(id, Number(arg));
    if (what === 'buy') buyOffer(id);
    if (what === 'testopen') openTestChest(Number(arg), false);
    if (what === 'testjackpot') openTestChest(Number(arg), true);
    if (what === 'disenchant') disenchant([id]);
    if (what === 'upgrade') upgrade(id);
    return;
  }

  // zaskrtavaci kolecko = vyber pro hromadne rozlozeni
  const pick = e.target.closest('[data-pick]');
  if (pick) { toggleSelect(pick.dataset.pick); return; }

  if (e.target.closest('[data-detail-back]')) { previewSkin(0); return; }
  if (e.target.closest('[data-video]')) { toggleVideo(); return; }

  const preview = e.target.closest('[data-preview]');
  if (preview && !$('#detail').hidden) { previewSkin(Number(preview.dataset.preview)); return; }

  const dropCard = e.target.closest('[data-drop]');
  if (dropCard) { openDetailFromDrop(lastDrops[Number(dropCard.dataset.drop)]); return; }

  const card = e.target.closest('.card[data-selectable]');
  if (card) {
    // v rezimu rerollu klik plni sloty; jinak otevre detail
    if (state.rerollMode || !card.dataset.detail) toggleSelect(card.dataset.id);
    else openDetail(card.dataset.id);
  }
});

$('#detail-close').addEventListener('click', closeDetail);
$('#detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDetail(); });

$('#open-all').addEventListener('click', openEverything);
$('#refresh').addEventListener('click', () => loadLoot().catch((err) => toast(err.message, true)));

$('#reveal-close').addEventListener('click', closeReveal);
$('#reveal-skip').addEventListener('click', skipAnimation);

function skipAnimation() {
  skipAnim = true;
  if (globalThis.Reel) Reel.skip();
  $('#reveal-skip').hidden = true;
}

// klik na tmave pozadi zavre odhaleni, ale az kdyz uz je co zavirat
$('#reveal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget && !$('#reveal-close').hidden) closeReveal();
});

document.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); $('#modal-cancel').click(); }
    if (e.key === 'Enter')  { e.preventDefault(); $('#modal-ok').click(); }
    return;
  }

  if (!$('#detail').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
    return;
  }

  if (!$('#reveal').hidden) {
    // dokud animace bezi, Esc i mezernik ji preskoci; potom zaviraji
    const running = $('#reveal-close').hidden;
    if (e.key === 'Escape' || e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (running) skipAnimation();
      else closeReveal();
    }
    return;
  }

  if (e.key === 'Escape' && state.rerollMode) setRerollMode(false);
});

$('#fast-toggle').addEventListener('click', (e) => {
  if (!globalThis.Reel) return;
  Reel.Motion.fast = !Reel.Motion.fast;
  e.currentTarget.classList.toggle('is-on', Reel.Motion.fast);
});

$('#sfx-toggle').addEventListener('click', (e) => {
  if (!globalThis.Reel) return;
  Reel.Sfx.enabled = !Reel.Sfx.enabled;
  e.currentTarget.classList.toggle('is-muted', !Reel.Sfx.enabled);
});

$('#ab-clear').addEventListener('click', () => { state.selected.clear(); renderGrid(state.scope, itemsIn(state.scope)); renderActionbar(); });
$('#ab-disenchant').addEventListener('click', () => disenchant(Array.from(state.selected)));
$('#reroll-mode').addEventListener('click', () => setRerollMode(!state.rerollMode));
$('#rr-cancel').addEventListener('click', () => setRerollMode(false));
$('#rr-suggest').addEventListener('click', suggestReroll);
$('#rr-go').addEventListener('click', rerollSelected);
$('#rr-slots').addEventListener('click', (e) => {
  const slot = e.target.closest('[data-remove]');
  if (!slot) return;
  state.selected.delete(slot.dataset.remove);
  renderGrid('skins', itemsIn('skins'));
  renderActionbar();
});

$('#clear-session').addEventListener('click', async () => {
  if (!await confirmModal('Vymazat historii?', 'Smaze jen lokalni zaznam v teto appce. Na tvuj ucet to nema vliv.')) return;
  localStorage.removeItem('gamba.history');
  localStorage.removeItem('gamba.stats');
  renderSession();
});

$$('[data-select]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const list = itemsIn(btn.dataset.scope);
    if (state.rerollMode) setRerollMode(false);   // "vybrat vse" do trislotoveho zasobniku nepatri
    state.selected.clear();
    const real = list.filter((i) => !i.isTest);
    if (btn.dataset.select === 'all') real.forEach((i) => state.selected.add(i.lootId));
    if (btn.dataset.select === 'owned') real.filter(alreadyOwned).forEach((i) => state.selected.add(i.lootId));
    renderGrid(btn.dataset.scope, list);
    renderActionbar();
  });
});

/**
 * Server drzi otevreny SSE kanal a hlasi, kdyz se loot v klientovi zmenil -
 * treba kdyz otevres bednu primo v klientovi. Vraci, jestli se to povedlo;
 * kdyz ne, zbyde puvodni pomale dotazovani.
 */
function connectLiveUpdates() {
  if (typeof EventSource !== 'function') return false;

  try {
    const stream = new EventSource('/api/events');

    stream.addEventListener('loot', () => {
      if (!state.busy) loadLoot().catch(() => {});
    });

    stream.addEventListener('status', (e) => {
      let connected = false;
      try { connected = !!JSON.parse(e.data).connected; } catch (_) {}
      if (state.busy) return;
      if (connected) loadLoot().catch(() => {});
      else { setConnected(false); renderAll(); }
    });

    return true;
  } catch (_) {
    return false;
  }
}

// --- start --------------------------------------------------------------

(async function boot() {
  // tlacitka musi na startu ukazovat, jak jsi to nechal minule
  if (globalThis.Reel) {
    $('#sfx-toggle').classList.toggle('is-muted', !Reel.Sfx.enabled);
    $('#fast-toggle').classList.toggle('is-on', Reel.Motion.fast);
  }
  renderSession();
  try { await loadLoot(); } catch (err) { toast(err.message, true); }

  const live = connectLiveUpdates();
  if (live) $('#conn').title = 'Zive aktualizace zapnute - loot se prekresli sam';

  // zaloha, kdyby SSE nesedlo; se zivym kanalem staci obcasna kontrola
  setInterval(async () => {
    if (state.busy) return;
    const was = state.connected;
    const now = await checkConnection();
    if (now && !was) loadLoot().catch(() => {});
    if (!now && was) renderAll();
  }, live ? 15000 : 5000);
})();
