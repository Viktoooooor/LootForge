/* LootForge - klientska logika.
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
  app: null,                 // { version, repo } ze serveru - kvuli kontrole nove verze
  ownedSkins: {},            // championId -> [{ id, name, img, splash, rarity }], jen vlastnene
  champions: {},             // championId -> jmeno
  filters: {},               // scope -> { q, rarity, own, sort }
  collection: { data: null, loadedAt: 0, loading: false, error: null, kind: 'skins', q: '', sort: 'new', rarity: '' },
  cleanup: { rules: null, skip: new Set() },
};

const TABS = ['chests', 'skins', 'champs', 'other', 'shop', 'collection', 'session'];

// Originalni ikony z klienta. LCU je serviruje na /lol-game-data/assets/ASSETS/Loot/,
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
  ['CURRENCY_champion',     'Blue Essence'],
  ['CURRENCY_cosmetic',     'Orange Essence'],
  ['CURRENCY_mythic',       'Mythic Essence'],
  ['MATERIAL_key',          'Hextech Keys'],
  ['MATERIAL_key_fragment', 'Key Fragments'],
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
  if (!item) return 'Unknown item';
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
  // /fe/* jsou assety klientskeho frontendu - ty LCU pres HTTP neserviruje (404),
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
    if (!globalThis.TestChest) throw new Error('Test item without the simulator.');
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
  }).filter((d) => d.name && d.name !== 'Unknown item');
}

// --- nacitani -----------------------------------------------------------

async function checkConnection() {
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.app && !state.app) { state.app = s.app; checkForUpdates().catch(() => {}); }
    setConnected(s.connected);
    if (!s.connected) bootWaiting();
    return s.connected;
  } catch (_) {
    // neodpovida ani nas server - exe se zavrel (nebo spadl)
    setConnected(false);
    setBootPhase('stopped');
    return false;
  }
}

function setConnected(on) {
  const changed = state.connected !== on;
  state.connected = on;
  const el = $('#conn');
  el.className = 'conn ' + (on ? 'on' : 'off');
  el.querySelector('.conn-label').textContent = on ? 'client connected' : 'client not running';
  return changed;
}

/**
 * opts.quiet = nacteni po vlastni akci appky. Zmeny lootu se pak nehlasi -
 * co padlo, hrac prave videl v odhaleni.
 */
async function loadLoot(opts) {
  if (!await checkConnection()) { lootSnapshot = null; renderAll(); return; }

  const raw = await lcu('/lol-loot/v1/player-loot');
  state.items = (raw || []).filter((i) => i.lootId && i.count > 0);
  state.byId = new Map(state.items.map((i) => [i.lootId, i]));
  const previous = lootSnapshot;
  lootSnapshot = new Map(state.items.map((i) => [i.lootId, i.count]));

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

  // testovaci polozky ziji jen v prohlizeci - do klienta se nikdy nedostanou.
  // Ve verejne verzi jsou vypnute, zapinaji se v Nastaveni.
  if (globalThis.TestChest && testItemsOn()) {
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
  if (previous && !(opts && opts.quiet)) notifyLootChanges(previous);
  bootConnected();
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
  if (!$('#cleanup').hidden) renderCleanup();
}

let walletPrev = null;   // lootId -> pocet pri poslednim vykresleni

/** Penezenka. Zmena proti minule se kratce rozsviti (+450 / -1050). */
function renderWallet() {
  const now = new Map(WALLET.map(([id]) => [id, countOf(id)]));
  const prev = walletPrev;
  walletPrev = now;
  // beze zmeny nekreslit znovu - jinak by dalsi renderAll utnul probihajici zablesk
  if (prev && WALLET.every(([id]) => prev.get(id) === now.get(id)) && $('#wallet').innerHTML) return;

  $('#wallet').innerHTML = WALLET.map(([id, label]) => {
    const it = state.byId.get(id);
    if (!it) return '';
    const delta = prev ? it.count - (prev.get(id) || 0) : 0;
    return `<div class="w-item${delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ''}" title="${label}">
      ${LOOT_ART[id] ? `<img src="/lcu${LOOT_ART[id]}" alt="${label}">` : `<i class="w-dot"></i>`}
      <b>${it.count.toLocaleString('en-US')}</b>
      ${delta ? `<span class="w-delta">${delta > 0 ? '+' : ''}${delta.toLocaleString('en-US')}</span>` : ''}
    </div>`;
  }).join('');
}

// --- novy loot -------------------------------------------------------------

let lootSnapshot = null;   // lootId -> pocet z posledniho nacteni lootu

function lootLabel(item) {
  const known = WALLET.find(([id]) => id === item.lootId);
  return known ? known[1] : nameOf(item);
}

/** Co pribylo proti minulemu nacteni. Testovaci polozky se nepocitaji. */
function lootGains(previous, items) {
  return items
    .filter((i) => !i.isTest)
    .map((item) => ({ item, diff: item.count - (previous.get(item.lootId) || 0) }))
    .filter((g) => g.diff > 0)
    .sort((a, b) => (a.item.type === 'CURRENCY') - (b.item.type === 'CURRENCY')
      || RARITY_ORDER.indexOf(b.item.rarity) - RARITY_ORDER.indexOf(a.item.rarity)
      || b.diff - a.diff);
}

/**
 * Hrac dohral hru nebo neco dostal v klientovi - at to vi i tady.
 * Ubytek (bedna otevrena v klientovi) se nehlasi, to udelal sam.
 */
function notifyLootChanges(previous) {
  const gains = lootGains(previous, state.items);
  if (!gains.length) return;
  const parts = gains.map((g) => `+${g.diff.toLocaleString('en-US')} ${lootLabel(g.item)}`);
  const shown = parts.slice(0, 4).join(', ') + (parts.length > 4 ? ` and ${parts.length - 4} more` : '');
  toast(`New loot: ${shown}`);
}

function renderChestHeader() {
  const chests = itemsIn('chests').filter((i) => !i.isTest);
  const total = chests.reduce((n, i) => n + Math.min(i.count, maxRepeats(recipeOfType(i.lootId, 'OPEN'), i.lootId)), 0);
  const btn = $('#open-all');
  btn.disabled = total === 0 || state.busy;
  btn.textContent = total > 0 ? `Open all (${total})` : 'Nothing to open';
  $('#chests-sub').textContent = chests.length
    ? `${chests.reduce((n, i) => n + i.count, 0)} in your inventory, ${total} can be opened right now.`
    : 'No chests in your inventory.';
}

// --- filtry -------------------------------------------------------------

const FILTER_SCOPES = ['skins', 'champs', 'other'];

function filterOf(scope) {
  if (!state.filters[scope]) state.filters[scope] = { q: '', rarity: '', own: '', sort: 'rarity' };
  return state.filters[scope];
}

/** Hledani bez ohledu na diakritiku a velikost pismen. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function isFiltered(scope) {
  const f = state.filters[scope];
  return !!(f && (f.q || f.rarity || f.own));
}

/** Polozky tabu po filtru a v poradi, ve kterem se kresli. */
function visibleIn(scope, list) {
  const all = list || itemsIn(scope);
  if (!FILTER_SCOPES.includes(scope)) return all;
  const f = filterOf(scope);
  const q = fold(f.q).trim();

  const out = all.filter((i) => {
    if (q && !fold(nameOf(i)).includes(q) && !fold(championName(skinChampionOf(i))).includes(q)) return false;
    if (f.rarity && (i.rarity || 'DEFAULT') !== f.rarity) return false;
    if (f.own === 'owned' && !alreadyOwned(i)) return false;
    if (f.own === 'missing' && alreadyOwned(i)) return false;
    if (f.own === 'fav' && !isFavorite(i.lootId)) return false;
    return true;
  });

  const byRarity = (a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity);
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'en');
  const sorters = {
    rarity: (a, b) => byRarity(a, b) || byName(a, b),
    value: (a, b) => (b.disenchantValue * b.count - a.disenchantValue * a.count) || byName(a, b),
    count: (a, b) => (b.count - a.count) || byName(a, b),
    name: byName,
  };
  const sorter = sorters[f.sort] || sorters.rarity;
  // testovaci polozky vzdycky na konec, oblibene (hvezdicka) vzdycky napred
  return out.sort((a, b) => (!!a.isTest !== !!b.isTest ? (a.isTest ? 1 : -1) : 0)
    || (isFavorite(b.lootId) - isFavorite(a.lootId))
    || sorter(a, b));
}

function setFilter(scope, key, value) {
  filterOf(scope)[key] = value;
  renderGrid(scope, itemsIn(scope));
  saveUi();
}

function renderFilterCount(scope, shown, total) {
  const el = $('#fcount-' + scope);
  if (!el) return;
  el.textContent = isFiltered(scope) ? `showing ${shown} of ${total}` : '';
  const reset = $('#freset-' + scope);
  if (reset) reset.hidden = !isFiltered(scope);
}

function renderGrid(scope, list) {
  const grid = $('#grid-' + scope);
  if (!grid) return;

  if (!state.connected) {
    grid.innerHTML = '<div class="empty">Start the League client - the app connects automatically.</div>';
    return;
  }
  if (!list.length) {
    grid.innerHTML = '<div class="empty">Nothing here.</div>';
    renderFilterCount(scope, 0, 0);
    return;
  }

  const sorted = visibleIn(scope, list);
  renderFilterCount(scope, sorted.length, list.length);
  if (!sorted.length) {
    grid.innerHTML = '<div class="empty">Nothing matches the filter.</div>';
    return;
  }

  // u sampionu a skinu je rozdil shard / permanent zasadni - at je videt na prvni pohled
  if (scope === 'champs' || scope === 'skins') {
    const shards = sorted.filter(isShard);
    const perms = sorted.filter((i) => !isShard(i));
    grid.innerHTML =
      groupHtml('Shards', 'unlock or disenchant them', shards, scope) +
      groupHtml('Permanents', 'already yours, can only be disenchanted', perms, scope);
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
    actions.push(btn(`open:${id}:1`, 'Open 1', canOpen < 1));
    if (item.count > 1) actions.push(btn(`open:${id}:${canOpen}`, `Open all (${canOpen})`, canOpen < 1));
  }
  if (forge) {
    const canForge = maxRepeats(forge, id);
    actions.push(btn(`forge:${id}:${Math.max(1, canForge)}`, `Forge (${canForge})`, canForge < 1));
  }
  // co uz mas natrvalo, nema smysl odemykat - klient by to stejne odmitl
  if (upg && !alreadyOwned(item)) {
    actions.push(btn(`upgrade:${id}`, `Unlock (${upgCost.toLocaleString('en-US')})`, !canUpgrade));
  }
  if (dis) actions.push(btn(`disenchant:${id}`, `Disenchant (+${(item.disenchantValue * item.count).toLocaleString('en-US')})`, false));

  const shard = isShard(item);
  const meta = [];
  if (item.type) meta.push(typeLabel(item.type));
  if (item.rarity && item.rarity !== 'DEFAULT') meta.push(item.rarity.toLowerCase());

  const badge = item.isTest
    ? '<span class="card-badge is-test">SIMULATED</span>'
    : shard
      ? '<span class="card-badge is-shard">SHARD</span>'
      : '<span class="card-badge is-perm">PERMANENT</span>';

  // u shardu je "uz ho mas" dulezita informace (duplikat = kandidat na rozlozeni
  // nebo reroll), u permanentu je to samozrejme - tam ji nekreslime
  const owned = shard && alreadyOwned(item);

  return `<div class="card ${item.isTest ? 'card-test' : shard ? 'card-shard' : 'card-perm'} ${owned ? 'is-owned' : ''} ${isFavorite(id) ? 'is-fav' : ''} ${state.selected.has(id) ? 'is-selected' : ''}" data-id="${id}" ${selectable ? 'data-selectable="1"' : ''} ${recipeOfType(id, 'REROLL') ? 'data-rr="1"' : ''} ${selectable && skinIdOf(item) ? 'data-detail="1"' : ''}>
    <div class="card-img ${isIcon(item) ? 'contain' : ''}">
      ${imgUrl(item) ? `<img src="${imgUrl(item)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="card-glyph">${glyph(item)}</span>`}
      ${item.count > 1 ? `<span class="card-count">x${item.count}</span>` : ''}
      ${owned ? '<span class="owned-ribbon" title="You already own this"><i></i>OWNED</span>' : ''}
      ${selectable ? `<button class="pick-box ${state.selected.has(id) ? 'is-on' : ''}" data-pick="${id}" title="Select (bulk disenchant)"><i></i></button>` : ''}
      ${canFavorite(item) ? `<button class="fav-box ${isFavorite(id) ? 'is-on' : ''}" data-fav="${id}" title="${isFavorite(id) ? 'Starred - protected from clean up and Select all' : 'Star to protect from clean up and Select all'}">&#9733;</button>` : ''}
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
      <span class="card-badge is-test">SIMULATED</span>
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(nameOf(item))}</div>
      <div class="card-meta">never touches your account &middot; animation preview</div>
      <div class="card-actions">
        ${btn(`testopen:${id}:1`, 'Open 1', false)}
        ${btn(`testopen:${id}:5`, 'Open 5', false)}
        ${btn(`testopen:${id}:10`, 'Open 10', false)}
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
    CHEST: 'chest', SKIN_RENTAL: 'skin shard', CHAMPION_RENTAL: 'champion shard',
    CHAMPION: 'champion', WARDSKIN_RENTAL: 'ward shard', EMOTE: 'emote',
    MATERIAL: 'material', CURRENCY: 'currency', COMPANION: 'little legend',
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
    await loadLoot({ quiet: true });
  }
}

async function openChest(lootId, repeat) {
  const item = state.byId.get(lootId);
  const recipe = recipeOfType(lootId, 'OPEN');
  if (!item || !recipe) return toast('This item cannot be opened.', true);

  const times = Math.max(1, Math.min(repeat || 1, maxRepeats(recipe, lootId)));
  const ids = fillSlots(recipe, lootId);
  if (!ids) return toast('Missing a key or another ingredient.', true);

  await withBusy(async () => {
    showReveal(`Opening: ${nameOf(item)}`);
    const res = await craft(recipe.recipeName, ids, times);
    const drops = dropsFrom(res);
    await revealDrops(drops, null, { reel: true });
    recordChests(nameOf(item), times, drops);
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
    showReveal(onlyRare ? 'TEST - jackpot' : `TEST - opening ${count}x`);
    const drops = await TestChest.roll(count, onlyRare);
    await revealDrops(drops, 'TEST - simulated, nothing changed on your account', { reel: true });
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
  if (!ids) return toast('Not enough ingredients.', true);

  await withBusy(async () => {
    showReveal(`Forging: ${nameOf(item)}`);
    const res = await craft(recipe.recipeName, ids, times);
    const drops = dropsFrom(res);
    await revealDrops(drops, 'Forged');
    logDrops(drops);
  });
}

// Po kolika bednach se "Otevrit vse" posila. Mensi davky = jde to zastavit
// a ukazatel prubehu se hybe; vetsi = min requestu. 5 je rozumny kompromis.
const OPEN_CHUNK = 5;
let stopRequested = false;

function showProgress(done, total) {
  $('#reveal-progress').hidden = false;
  $('#reveal-progress-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('#reveal-progress-text').textContent = `${done} / ${total} chests`;
}

function requestStop() {
  stopRequested = true;
  const stop = $('#reveal-stop');
  stop.disabled = true;
  stop.textContent = 'Stopping…';
}

async function openEverything() {
  const plan = itemsIn('chests')
    .filter((i) => !i.isTest)
    .map((item) => ({ item, times: maxRepeats(recipeOfType(item.lootId, 'OPEN'), item.lootId) }))
    .filter((p) => p.times > 0);
  if (!plan.length) return;
  const total = plan.reduce((n, p) => n + p.times, 0);

  await withBusy(async () => {
    showReveal('Opening everything…');
    stopRequested = false;
    showProgress(0, total);
    $('#reveal-stop').hidden = false;
    const all = [];
    let opened = 0;
    let aborted = false;
    let stopped = false;

    chests: for (const { item, times } of plan) {
      const recipe = recipeOfType(item.lootId, 'OPEN');
      for (let done = 0; done < times;) {
        // zastavit jde jen mezi davkami - rozjeta davka uz na klientovi probehne
        if (stopRequested) { stopped = true; break chests; }
        const ids = fillSlots(recipe, item.lootId);
        const n = Math.min(OPEN_CHUNK, times - done, maxRepeats(recipe, item.lootId));
        if (!ids || n < 1) break;

        $('#reveal-title').textContent = `Opening: ${nameOf(item)}`;
        try {
          const res = await craft(recipe.recipeName, ids, n);
          const drops = dropsFrom(res);
          all.push(...drops);
          opened += n;
          done += n;
          recordChests(nameOf(item), n, drops);   // po kazde davce - kdyby pak klient odpadl
          showProgress(opened, total);
        } catch (err) {
          // kdyz odpadne klient, nema smysl bouchat hlavou do zdi u kazde dalsi bedny
          if (err.status === 502 || err.status === 503) {
            aborted = true;
            toast(`The client stopped responding. Opened ${opened} before that.`, true);
            break chests;
          }
          toast(`${nameOf(item)}: ${err.message}`, true);
          break;   // tahle bedna nejde, zkusit dalsi druh
        }
        // klient si to potrebuje srovnat, nezavalime ho
        await sleep(220);
        const fresh = await lcu('/lol-loot/v1/player-loot');
        state.items = (fresh || []).filter((i) => i.lootId && i.count > 0);
        state.byId = new Map(state.items.map((i) => [i.lootId, i]));
      }
    }

    $('#reveal-stop').hidden = true;
    $('#reveal-progress').hidden = true;
    const title = aborted ? `Client stopped responding after ${opened} chests`
      : stopped ? `Stopped after ${opened} of ${total} chests`
        : `Opened ${opened}x`;
    if (!all.length && stopped) {
      $('#reveal-title').textContent = title;
      $('#reveal-cards').innerHTML = '<div class="empty">Nothing was opened.</div>';
      $('#reveal-close').hidden = false;
      return;
    }
    await revealDrops(all, title, { reel: true });
    logDrops(all);
  });
}

async function disenchant(lootIds) {
  const items = lootIds.map((id) => state.byId.get(id)).filter(Boolean);
  if (!items.length) return;

  if (isMixedBatch(lootIds)) return toast('Don\'t mix test items with real ones.', true);
  const test = isTestBatch(lootIds);

  const total = items.reduce((n, i) => n + i.disenchantValue * i.count, 0);
  const pieces = items.reduce((n, i) => n + i.count, 0);
  const ok = await confirmModal(
    test ? 'TEST - disenchant?' : 'Disenchant permanently?',
    starredWarning(items) +
    `You will disenchant ${pieces} ${pieces === 1 ? 'item' : 'items'} for about ${total.toLocaleString('en-US')} essence. ` +
    (test ? 'This is a simulation - nothing happens to your account.' : 'This cannot be undone.')
  );
  if (!ok) return;

  await runDisenchant(items.map((item) => ({ item, count: item.count })), test ? 'TEST - disenchanted, account unchanged' : 'Disenchanted');
}

/**
 * Rozlozi `count` kusu z kazde polozky. Potvrzeni uz musi byt za nami.
 * Pocet muze byt mensi nez cely stack - uklid si nechava jeden kus.
 */
async function runDisenchant(entries, title) {
  const test = isTestBatch(entries.map((e) => e.item.lootId));
  await withBusy(async () => {
    showReveal('Disenchanting…');
    const gained = [];
    let done = 0;
    for (const { item, count } of entries) {
      const recipe = recipeOfType(item.lootId, 'DISENCHANT');
      if (!recipe || count < 1) continue;
      const ids = fillSlots(recipe, item.lootId);
      if (!ids) continue;
      try {
        const res = await craft(recipe.recipeName, ids, Math.min(count, item.count));
        const drops = dropsFrom(res);
        gained.push(...drops);
        done += Math.min(count, item.count);     // do statistik jen to, co fakt proslo
        if (!test) bumpStats({ disenchanted: Math.min(count, item.count), gained: currencyOf(drops) });
      } catch (err) {
        if (err.status === 502 || err.status === 503) {
          toast(`The client stopped responding. Disenchanted ${done} before that.`, true);
          break;
        }
        toast(`${nameOf(item)}: ${err.message}`, true);
      }
      await sleep(180);
    }
    state.selected.clear();
    await revealDrops(gained, title || 'Disenchanted');
  });
}

/** Meny z dropu jako { CURRENCY_champion: 1234 } - do statistik. */
function currencyOf(drops) {
  const out = {};
  for (const d of drops) {
    if (d.type !== 'CURRENCY' || !/^CURRENCY_/.test(d.lootId)) continue;
    out[d.lootId] = (out[d.lootId] || 0) + (d.count || 0);
  }
  return out;
}

async function upgrade(lootId) {
  const item = state.byId.get(lootId);
  const recipe = recipeOfType(lootId, 'UPGRADE');
  if (!item || !recipe) return;

  const test = isTestBatch([lootId]);
  const champId = skinChampionOf(item);
  const ok = await confirmModal(
    test ? 'TEST - unlock?' : 'Unlock permanently?',
    `You will spend ${(item.upgradeEssenceValue || 0).toLocaleString('en-US')} essence and ${nameOf(item)} will be yours permanently.` +
    (test ? ' This is a simulation - nothing happens to your account.' : ''),
    // u sampiona ukazat, jake skiny na nej uz mas - casto je to duvod ho odemknout
    champId ? skinsGalleryHtml(champId, championName(champId) || nameOf(item), { current: skinIdOf(item) }) : ''
  );
  if (!ok) return;

  const ids = fillSlots(recipe, lootId);
  if (!ids) return toast('Not enough essence.', true);

  await withBusy(async () => {
    showReveal('Unlocking…');
    const res = await craft(recipe.recipeName, ids, 1);
    const drops = dropsFrom(res);
    if (!test) bumpStats({ unlocked: 1, spent: { [currencyForUpgrade(item)]: item.upgradeEssenceValue || 0 } });
    await revealDrops(drops, test ? 'TEST - unlocking (simulated)' : 'Unlocking', { unlock: true });
    if (!test) logDrops(drops);
  });
}

async function rerollSelected() {
  const ids = Array.from(state.selected);
  const recipe = ids.map((id) => recipeOfType(id, 'REROLL')).find(Boolean);
  if (!recipe) return toast('These shards cannot be rerolled.', true);

  const need = (recipe.slots || []).length || 3;
  // presne tolik, kolik recept chce. Driv se pri vetsim vyberu vzalo
  // libovolnych prvnich N a v potvrzeni se ani nerekl, ktere.
  if (ids.length !== need) return toast(`A reroll takes exactly ${need} shards, ${ids.length} selected.`, true);
  if (ids.some((id) => !recipeOfType(id, 'REROLL'))) return toast('One of the selected shards cannot be rerolled.', true);
  if (isMixedBatch(ids)) return toast('Don\'t mix test shards with real ones.', true);
  const test = isTestBatch(ids);

  const items = ids.map((id) => state.byId.get(id));
  const ok = await confirmModal(
    test ? 'TEST - reroll?' : 'Reroll?',
    starredWarning(items) +
    `You will use up: ${items.map(nameOf).join(', ')}. You get one random permanent skin for them. ` +
    (test ? 'This is a simulation - nothing happens to your account.' : 'This cannot be undone.')
  );
  if (!ok) return;

  // co se polozi na oltar v animaci
  const offered = items.map((it) => ({ name: nameOf(it), img: imgUrl(it), rarity: it.rarity || 'DEFAULT' }));

  await withBusy(async () => {
    showReveal(test ? 'TEST - reroll (simulated)' : 'Reroll');
    const res = await craft(recipe.recipeName, ids, 1);
    const drops = dropsFrom(res);
    if (!test) bumpStats({ rerolls: 1 });
    state.selected.clear();
    await revealDrops(drops, test ? 'TEST - reroll, account unchanged' : 'Reroll', { reroll: offered });
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
    .filter((i) => !i.isTest && !isFavorite(i.lootId) && isShard(i) && recipeOfType(i.lootId, 'REROLL'))
    .sort((a, b) => (alreadyOwned(b) - alreadyOwned(a)) || (a.disenchantValue - b.disenchantValue));

  if (candidates.length < 3) return toast('You need at least 3 skin shards to reroll.', true);

  state.selected = new Set(candidates.slice(0, 3).map((i) => i.lootId));
  renderGrid('skins', itemsIn('skins'));
  renderActionbar();
  toast('Picked the cheapest shards, duplicates first. You still confirm before the reroll.');
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
    ? `Pick ${left} more ${left === 1 ? 'skin shard' : 'skin shards'} - you get one random permanent skin for them.`
    : 'Ready: three shards for one random skin.';
  $('#rr-go').disabled = ids.length !== 3;
  tray.hidden = false;
}

// --- oblibene (hvezdicka) ---------------------------------------------------

/*
 * Oznaceny shard je chraneny: nevezme ho uklid, "Select all", "Select owned"
 * ani "Suggest 3" u rerollu. Rucne vybrat (kolecko) ho jde porad - to je
 * vedome rozhodnuti, jen potvrzeni na hvezdicku upozorni. Klic je lootId,
 * ten je pro stejny shard stalny i po odemknuti dalsich kusu.
 */
let favorites = null;

function favSet() {
  if (!favorites) favorites = new Set(readStore('lootforge.favorites', []).filter((x) => typeof x === 'string'));
  return favorites;
}

function isFavorite(lootId) {
  return favSet().has(lootId);
}

/** Hvezdicku ma smysl dat jen tomu, o co jde prijit. */
function canFavorite(item) {
  return !item.isTest && !!(recipeOfType(item.lootId, 'DISENCHANT') || recipeOfType(item.lootId, 'REROLL'));
}

function toggleFavorite(lootId) {
  const set = favSet();
  if (set.has(lootId)) set.delete(lootId);
  else set.add(lootId);
  try { localStorage.setItem('lootforge.favorites', JSON.stringify([...set])); } catch (_) { /* jen pohodli */ }
  if (FILTER_SCOPES.includes(state.scope) || state.scope === 'chests') renderGrid(state.scope, itemsIn(state.scope));
  renderActionbar();
  if (!$('#cleanup').hidden) renderCleanup();
}

function starredWarning(items) {
  const starred = items.filter((i) => i && isFavorite(i.lootId));
  return starred.length ? `Includes starred: ${starred.map(nameOf).join(', ')}. ` : '';
}

/** "Select all" / "Select owned" - jen viditelne, ostre a bez hvezdicky. */
function selectIn(scope, mode) {
  const list = itemsIn(scope);
  if (state.rerollMode) setRerollMode(false);   // "vybrat vse" do trislotoveho zasobniku nepatri
  state.selected.clear();
  // jen to, co je po filtru videt - "vybrat vse" nesmi potichu vzit i skryte
  const real = visibleIn(scope, list).filter((i) => !i.isTest && !isFavorite(i.lootId));
  if (mode === 'all') real.forEach((i) => state.selected.add(i.lootId));
  if (mode === 'owned') real.filter(alreadyOwned).forEach((i) => state.selected.add(i.lootId));
  renderGrid(scope, list);
  renderActionbar();
}

// --- uklid inventare -------------------------------------------------------

/*
 * Pravidla, podle kterych se hromadne rozklada. Kazde vraci, kolik kusu z
 * polozky rozlozit (0 = nechat). Pravidla se neprekryvaji (vlastnene /
 * nevlastnene), takze zadny kus se nepocita dvakrat. Testovaci polozky a veci
 * bez receptu DISENCHANT do uklidu nikdy nejdou (cleanupPlan).
 */
const CLEANUP_RULES = [
  { id: 'champ-owned', on: true, title: 'Champion shards for champions you own',
    note: 'They cannot be unlocked anymore, only disenchanted.',
    pick: (i) => (i.type === 'CHAMPION_RENTAL' && alreadyOwned(i) ? i.count : 0) },
  { id: 'champ-perm', on: true, title: 'Champion permanents you already own',
    note: 'A permanent gives its full essence value.',
    pick: (i) => (i.type === 'CHAMPION' && alreadyOwned(i) ? i.count : 0) },
  { id: 'champ-extra', on: true, title: 'Extra champion shards',
    note: 'One shard is enough for a champion you don\'t own. One copy is kept.',
    pick: (i) => (i.type === 'CHAMPION_RENTAL' && !alreadyOwned(i) ? i.count - 1 : 0) },
  { id: 'other-owned', on: true, title: 'Wards, emotes and icons you own',
    note: 'Duplicate cosmetics other than skins.',
    pick: (i) => (bucket(i) === 'other' && alreadyOwned(i) ? i.count : 0) },
  { id: 'skin-owned', on: false, title: 'Skin shards for skins you own',
    note: 'Consider rerolling instead: 3 shards = a random permanent skin.',
    pick: (i) => (/^SKIN(_RENTAL)?$/.test(i.type) && alreadyOwned(i) ? i.count : 0) },
  { id: 'skin-extra', on: false, title: 'Duplicate skin shards',
    note: 'One copy is kept. Also good for rerolls.',
    pick: (i) => (i.type === 'SKIN_RENTAL' && !alreadyOwned(i) ? i.count - 1 : 0) },
];

const CURRENCY_NAME = { CURRENCY_champion: 'Blue Essence', CURRENCY_cosmetic: 'Orange Essence', CURRENCY_mythic: 'Mythic Essence' };

function cleanupRules() {
  if (!state.cleanup.rules) {
    const saved = readStore('lootforge.cleanup', {});
    state.cleanup.rules = Object.fromEntries(CLEANUP_RULES.map((r) => [r.id, typeof saved[r.id] === 'boolean' ? saved[r.id] : r.on]));
  }
  return state.cleanup.rules;
}

/** Co by uklid rozlozil: pravidla s polozkami, kusy a esenci. */
function cleanupPlan() {
  const rules = cleanupRules();
  const candidates = state.items.filter((i) => !i.isTest && !isFavorite(i.lootId) && recipeOfType(i.lootId, 'DISENCHANT'));
  const groups = CLEANUP_RULES.map((rule) => {
    const entries = candidates
      .map((item) => ({ item, count: Math.max(0, Math.min(item.count, rule.pick(item) || 0)) }))
      .filter((e) => e.count > 0)
      .map((e) => ({ ...e, value: (e.item.disenchantValue || 0) * e.count, skipped: state.cleanup.skip.has(e.item.lootId) }))
      .sort((a, b) => b.value - a.value || nameOf(a.item).localeCompare(nameOf(b.item), 'en'));
    return { rule, on: !!rules[rule.id], entries };
  });

  const chosen = groups.filter((g) => g.on).flatMap((g) => g.entries.filter((e) => !e.skipped));
  const totals = {};
  for (const e of chosen) {
    const cur = e.item.disenchantLootName || currencyForUpgrade(e.item);
    totals[cur] = (totals[cur] || 0) + e.value;
  }
  return { groups, chosen, pieces: chosen.reduce((n, e) => n + e.count, 0), totals };
}

function essenceHtml(totals) {
  const parts = Object.entries(totals).filter(([, n]) => n > 0).map(([cur, n]) =>
    `<span class="essence">${LOOT_ART[cur] ? `<img src="/lcu${LOOT_ART[cur]}" alt="">` : ''}+${n.toLocaleString('en-US')}</span>`);
  return parts.join('') || '<span class="essence is-zero">nothing</span>';
}

function openCleanup() {
  if (state.busy) return;
  state.cleanup.skip.clear();
  renderCleanup();
  $('#cleanup').hidden = false;
  document.body.classList.add('detail-open');
}

function closeCleanup() {
  $('#cleanup').hidden = true;
  document.body.classList.remove('detail-open');
}

function renderCleanup() {
  const plan = cleanupPlan();
  $('#cleanup-rules').innerHTML = plan.groups.map((g) => {
    const pieces = g.entries.filter((e) => !e.skipped).reduce((n, e) => n + e.count, 0);
    const totals = {};
    for (const e of g.entries) if (!e.skipped) {
      const cur = e.item.disenchantLootName || currencyForUpgrade(e.item);
      totals[cur] = (totals[cur] || 0) + e.value;
    }
    return `<section class="cl-rule ${g.on ? 'is-on' : ''} ${g.entries.length ? '' : 'is-empty'}">
      <label class="cl-head">
        <input type="checkbox" data-cl-rule="${g.rule.id}" ${g.on ? 'checked' : ''}>
        <span class="cl-title">${g.rule.title}<em>${g.rule.note}</em></span>
        <span class="cl-sum">${g.entries.length ? `${pieces} pcs ${essenceHtml(totals)}` : 'nothing like that'}</span>
      </label>
      ${g.entries.length ? `<div class="cl-items">${g.entries.map((e) => `
        <button class="cl-item ${e.skipped ? 'is-skipped' : ''}" data-cl-skip="${e.item.lootId}" title="${e.skipped ? 'Skipped - click to include again' : 'Click to keep this'}">
          ${imgUrl(e.item) ? `<img src="${imgUrl(e.item)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<i></i>'}
          <span>${escapeHtml(nameOf(e.item))}</span>
          <b>${e.count < e.item.count ? `${e.count} of ${e.item.count}` : `&times;${e.count}`}</b>
        </button>`).join('')}</div>` : ''}
    </section>`;
  }).join('');

  const starred = state.items.filter((i) => !i.isTest && isFavorite(i.lootId)).length;
  $('#cleanup-total').innerHTML = (plan.pieces
    ? `<b>${plan.pieces}</b> ${plural(plan.pieces, 'item', 'items', 'items')} ${essenceHtml(plan.totals)}`
    : 'Nothing to clean up with the selected rules.')
    + (starred ? `<span class="cl-starred">&#9733; ${starred} starred ${plural(starred, 'item is', 'items are', 'items are')} protected</span>` : '');
  $('#cleanup-go').disabled = !plan.pieces || state.busy;
}

function toggleCleanupRule(id, on) {
  const rules = cleanupRules();
  rules[id] = !!on;
  try { localStorage.setItem('lootforge.cleanup', JSON.stringify(rules)); } catch (_) { /* jen pohodli */ }
  renderCleanup();
}

function toggleCleanupSkip(lootId) {
  if (state.cleanup.skip.has(lootId)) state.cleanup.skip.delete(lootId);
  else state.cleanup.skip.add(lootId);
  renderCleanup();
}

async function runCleanup() {
  const plan = cleanupPlan();
  if (!plan.pieces) return;
  const sum = Object.entries(plan.totals).map(([cur, n]) => `${n.toLocaleString('en-US')} ${CURRENCY_NAME[cur] || cur}`).join(' and ');
  const ok = await confirmModal(
    'Clean up inventory?',
    `You will disenchant ${plan.pieces} ${plural(plan.pieces, 'item', 'items', 'items')} for about ${sum}. This cannot be undone.`,
    `<div class="cl-confirm">${plan.chosen.map((e) =>
      `<span>${escapeHtml(nameOf(e.item))}${e.count > 1 || e.count < e.item.count ? ` <b>&times;${e.count}</b>` : ''}</span>`).join('')}</div>`
  );
  if (!ok) return;
  closeCleanup();
  await runDisenchant(plan.chosen.map((e) => ({ item: e.item, count: e.count })), 'Cleaned up');
}

// --- vlastnene skiny na sampiona ------------------------------------------

async function loadOwnedSkins() {
  try {
    const res = await fetch('/api/owned-skins');
    if (!res.ok) return;
    const data = await res.json();
    state.ownedSkins = data.byChampion || {};
    state.champions = data.champions || {};
    chromaCache.clear();
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

const skinsWord = (n) => plural(n, 'skin', 'skins', 'skins');

/** Maly prehled na kartu: prekryvajici se kolecka a pocet. Nic, kdyz skin neni. */
function skinsChipHtml(championId) {
  const skins = ownedSkinsFor(championId);
  if (!skins.length) return '';
  const names = skins.map((sk) => sk.name).join(', ');
  return `<div class="skins-chip" title="${escapeHtml(names)}">
    <span class="skins-stack">${skins.slice(0, 4).map((sk) =>
      `<img src="/lcu${sk.img}" alt="" loading="lazy" onerror="this.style.display='none'">`).join('')}</span>
    <span><b>${skins.length}</b> ${skinsWord(skins.length)} for this champion</span>
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
  const name = escapeHtml(champName || championName(championId) || 'Champion');
  if (!skins.length) {
    return `<div class="skins-owned"><div class="skins-none">${name}: you don't own any skins yet.</div></div>`;
  }
  const max = o.max || 12;
  const shown = skins.slice(0, max);
  return `<div class="skins-owned">
    <div class="skins-owned-title">${name}: your skins <span>${skins.length}</span></div>
    <div class="skins-owned-grid">
      ${shown.map((sk) => `<div class="skin-mini rare-${sk.rarity}${sk.id === o.current ? ' is-this' : ''}${sk.id === o.active ? ' is-active' : ''}"${o.clickable ? ` data-preview="${sk.id}" title="Show the full splash art"` : ''}>
        <img class="skin-mini-img" src="/lcu${sk.img}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        ${sk.rarity !== 'DEFAULT' ? `<img class="skin-mini-gem" src="${Reel.GEM(sk.rarity)}" alt="${sk.rarity}">` : ''}
        <span>${escapeHtml(sk.name)}</span>
      </div>`).join('')}
      ${skins.length > max ? `<div class="skins-more">+${skins.length - max} more</div>` : ''}
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
  refreshChromas(ctx);
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
  await ctx.chromaLoad;
  return ctx;
}

/**
 * Zkusi zdroje poporade a ukaze prvni, ktery se nacte. Do te doby je videt
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
    ? `<span class="detail-cap-label">Your skin</span><span class="detail-cap-name">${escapeHtml(preview.name)}</span>
       <button class="ghost-btn" data-detail-back>Back to ${escapeHtml(ctx.name)}</button>`
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
  if (!youtubeKey()) return;   // bez klice je tlacitko obycejny odkaz na YouTube
  closeChroma(ctx);

  const name = shownSkinName(ctx);
  ctx.videoLoading = true;
  renderDetail(ctx);

  let data = null;
  let failure = '';
  try {
    data = await findSpotlight(name);
  } catch (err) {
    failure = err.status === 400 || err.status === 403
      ? 'YouTube rejected the API key, or its daily quota is used up.'
      : 'YouTube is not reachable right now.';
  }
  if (detailCtx !== ctx) return;
  ctx.videoLoading = false;

  const box = $('#detail-video');
  if (data && /^[\w-]{11}$/.test(data.videoId || '')) {
    box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${data.videoId}?autoplay=1&rel=0&modestbranding=1"
      title="${escapeHtml(data.title || name)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  } else {
    // nenaslo se nebo API odmitlo - aspon odkaz, zadne vyskakovaci okno
    box.innerHTML = `<div class="detail-video-miss">
      <p>${escapeHtml(failure || `No SkinSpotlights video found for "${name}".`)}</p>
      <a class="big-btn" href="${escapeHtml(spotlightSearchUrl(name))}" target="_blank" rel="noopener">Search on YouTube</a>
    </div>`;
  }
  ctx.videoOn = true;
  $('#detail-art').classList.add('is-video');
  renderDetail(ctx);
}

/** Jmeno skinu, ktery je prave videt (shard, nebo tvuj skin v nahledu). */
function shownSkinName(ctx) {
  const shown = ctx.previewId ? ownedSkinsFor(ctx.championId).find((x) => x.id === ctx.previewId) : null;
  return shown ? shown.name : ctx.name;
}

/*
 * Video prohlidky od SkinSpotlights. Stranky YouTube se NESTAHUJI (podminky
 * YouTube to zakazuji). Bez klice je tlacitko odkaz na hledani, s vlastnim
 * klicem hrace se hleda pres oficialni YouTube Data API primo z prohlizece.
 * Klic ani jmeno skinu nejdou nikam jinam nez Googlu.
 */

const SPOTLIGHT_CHANNEL = 'UC0NwzCHb8Fg89eTB5eYX17Q';   // SkinSpotlights (id kanalu, ne jmeno)
const SPOTLIGHT_TTL = 30 * 86400000;                     // podminky API: data z API max. 30 dni

function youtubeKey() {
  try { return String(localStorage.getItem('lootforge.ytKey') || '').trim(); } catch (_) { return ''; }
}

function spotlightSearchUrl(name) {
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`SkinSpotlights ${name} skin spotlight`);
}

function normalizeTitle(text) {
  return String(text || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Z nalezenych videi vybere prohlidku daneho skinu: jen kanal SkinSpotlights,
 * nazev musi obsahovat jmeno skinu a "skin spotlight". Hotovy skin ma prednost
 * pred PBE nahledem (pre-release), ten byva nedodelany.
 */
function pickSpotlight(videos, skinName) {
  const want = normalizeTitle(skinName);
  if (!want) return null;
  const candidates = (videos || []).filter((v) => {
    const title = normalizeTitle(v.title);
    return v.channelId === SPOTLIGHT_CHANNEL && title.includes(want) && title.includes('skin spotlight');
  });
  const preRelease = (v) => (/pre release|pbe/.test(normalizeTitle(v.title)) ? 1 : 0);
  candidates.sort((a, b) => preRelease(a) - preRelease(b));
  return candidates[0] || null;
}

/** API vraci titulky s HTML entitami ("Kai&#39;Sa"). */
function decodeEntities(s) {
  return String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function findSpotlight(skinName) {
  const key = youtubeKey();
  if (!key) return null;
  const cacheKey = normalizeTitle(skinName);
  const cache = readStore('lootforge.ytCache', {});
  const hit = cache[cacheKey];
  if (hit && Date.now() - hit.at < SPOTLIGHT_TTL) return hit;

  const params = new URLSearchParams({
    part: 'snippet', type: 'video', maxResults: '10', channelId: SPOTLIGHT_CHANNEL, q: `${skinName} skin spotlight`, key,
  });
  const res = await fetch('https://www.googleapis.com/youtube/v3/search?' + params);
  if (!res.ok) { const err = new Error('youtube ' + res.status); err.status = res.status; throw err; }
  const data = await res.json();
  const videos = (data.items || []).map((it) => ({
    id: it.id && it.id.videoId,
    title: decodeEntities(it.snippet && it.snippet.title),
    channelId: it.snippet && it.snippet.channelId,
  }));

  const pick = pickSpotlight(videos, skinName);
  if (!pick) return { videoId: null };   // neuspech se nepamatuje - skin muze dostat video pozdeji
  const result = { videoId: pick.id, title: pick.title, at: Date.now() };
  // jen uspechy a jen 30 dni; kazde hledani stoji 100 jednotek z denni kvoty
  cache[cacheKey] = result;
  const keep = Object.entries(cache)
    .filter(([, v]) => v && Date.now() - v.at < SPOTLIGHT_TTL)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 300);
  try { localStorage.setItem('lootforge.ytCache', JSON.stringify(Object.fromEntries(keep))); } catch (_) { /* jen cache */ }
  return result;
}

function renderDetail(ctx) {
  const item = ctx.item;
  const rarity = ctx.rarity || 'DEFAULT';
  const champ = ctx.championName || championName(ctx.championId);
  const tags = [];
  if (item) {
    if (item.isTest) tags.push('<span class="is-test">SIMULATED</span>');
    tags.push(isShard(item) ? '<span class="is-shard">SHARD</span>' : '<span class="is-perm">PERMANENT</span>');
    if (isShard(item) && alreadyOwned(item)) tags.push('<span class="is-owned"><i></i>OWNED</span>');
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
      actions.push(`<button class="big-btn" data-action="upgrade:${id}" ${enough ? '' : 'disabled'}>Unlock (${cost.toLocaleString('en-US')})</button>`);
    }
    if (dis) actions.push(`<button class="ghost-btn" data-action="disenchant:${id}">Disenchant (+${(item.disenchantValue * item.count).toLocaleString('en-US')})</button>`);
  }

  if (youtubeKey()) {
    const videoLabel = ctx.videoLoading ? 'Searching…' : ctx.videoOn ? 'Back to splash' : 'Video preview';
    actions.unshift(`<button class="ghost-btn video-btn ${ctx.videoOn ? 'is-on' : ''}" data-video ${ctx.videoLoading ? 'disabled' : ''} title="Skin spotlight by SkinSpotlights (YouTube)"><i></i>${videoLabel}</button>`);
  } else {
    // bez API klice obycejny odkaz do nove zalozky - YouTube se nestahuje
    actions.unshift(`<a class="ghost-btn video-btn" href="${escapeHtml(spotlightSearchUrl(shownSkinName(ctx)))}" target="_blank" rel="noopener" title="Skin spotlight by SkinSpotlights - opens YouTube"><i></i>Video preview</a>`);
  }

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

  $('#detail-chromas').innerHTML = chromasHtml(ctx);

  $('#detail-skins').innerHTML = ctx.championId
    ? skinsGalleryHtml(ctx.championId, champ, { current: ctx.skinId, active: ctx.previewId, clickable: true, max: 999 })
    : '';
}

// --- chromy ------------------------------------------------------------

let summonerId = 0;
const chromaCache = new Map();   // skinId -> [chroma]

/**
 * Chromy skinu i s vlastnictvim - primo od klienta, jednim dotazem na skin
 * (/lol-champions/v1/inventories/{summoner}/champions/{champ}/skins/{skin}/chromas).
 * Overeno: vlastnictvi sedi s inventarem, bez pujcenych.
 */
async function loadChromas(skinId) {
  if (chromaCache.has(skinId)) return chromaCache.get(skinId);
  if (!summonerId) summonerId = (await lcu('/lol-summoner/v1/current-summoner')).summonerId;
  const champId = Math.floor(skinId / 1000);
  const raw = await lcu(`/lol-champions/v1/inventories/${summonerId}/champions/${champId}/skins/${skinId}/chromas`) || [];
  const list = raw.map((c) => {
    const o = c.ownership || {};
    return {
      id: c.id,
      // "Victorious Twisted Fate (Bronze)" -> "Bronze"
      name: (String(c.name || '').match(/\(([^)]+)\)\s*$/) || [])[1] || c.name,
      fullName: c.name,
      img: c.chromaPath ? '/lcu' + c.chromaPath : '',
      // barvy jdou do atributu style - pustit jen skutecne hex barvy
      colors: (c.colors || []).filter((x) => /^#[0-9a-f]{3,8}$/i.test(x)),
      owned: !!o.owned && !(o.rental && o.rental.rented) && !o.loyaltyReward,
      obtainable: c.stillObtainable !== false,
    };
  });
  chromaCache.set(skinId, list);
  return list;
}

/** Nacte chromy prave zobrazeneho skinu (shard, nebo tvuj skin v nahledu). */
function refreshChromas(ctx) {
  const skinId = ctx.previewId || ctx.skinId;
  ctx.chromaSkin = skinId;
  ctx.chromas = null;   // null = nacita se
  closeChroma(ctx);
  const load = loadChromas(skinId)
    .then((list) => list, () => [])
    .then((list) => {
      if (detailCtx !== ctx || ctx.chromaSkin !== skinId) return;
      ctx.chromas = list;
      renderDetail(ctx);
    });
  ctx.chromaLoad = load;
  return load;
}

function swatchCss(colors) {
  if (!colors || !colors.length) return 'var(--line)';
  const a = colors[0];
  const b = colors[1] || colors[0];
  return a === b ? a : `linear-gradient(135deg, ${a} 50%, ${b} 50%)`;
}

function chromasHtml(ctx) {
  const list = ctx.chromas;
  if (list === null) return '<div class="chromas"><div class="skins-none">Loading chromas…</div></div>';
  if (!list || !list.length) return '';
  const owned = list.filter((c) => c.owned).length;
  return `<div class="chromas">
    <div class="skins-owned-title">Chromas <span>${owned} / ${list.length}</span> <em>owned</em></div>
    <div class="chroma-grid">
      ${list.map((c) => `<div class="chroma ${c.owned ? 'is-owned' : ''} ${ctx.chromaView === c.id ? 'is-active' : ''}" data-chroma="${c.id}" title="${escapeHtml(c.fullName)}">
        <div class="chroma-img">
          ${c.img ? `<img src="${c.img}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
          ${c.owned ? '<span class="chroma-check" title="Owned"><i></i></span>' : ''}
        </div>
        <div class="chroma-name"><span class="swatch" style="background:${swatchCss(c.colors)}"></span>${escapeHtml(c.name)}</div>
        ${!c.owned && !c.obtainable ? '<div class="chroma-note">no longer available</div>' : ''}
      </div>`).join('')}
    </div>
  </div>`;
}

/** Klik na chromu: model v puvodni velikosti nad ztlumenym splashem (obrazky maji jen 270x303). */
function showChroma(chromaId) {
  const ctx = detailCtx;
  if (!ctx || !ctx.chromas) return;
  const c = ctx.chromas.find((x) => x.id === chromaId);
  if (!c || ctx.chromaView === chromaId) { closeChroma(ctx); renderDetail(ctx); return; }
  stopVideo();
  ctx.chromaView = chromaId;
  $('#detail-chroma').innerHTML = `<div class="chroma-stage" style="--swatch:${escapeHtml(c.colors[0] || 'transparent')}">
    ${c.img ? `<img src="${c.img}" alt="">` : ''}
    <div class="chroma-stage-name">
      <span class="swatch" style="background:${swatchCss(c.colors)}"></span>
      <b>${escapeHtml(c.name)}</b>
      <span class="${c.owned ? 'is-owned' : 'is-missing'}">${c.owned ? 'OWNED' : 'NOT OWNED'}</span>
    </div>
    <button class="ghost-btn" data-chroma-close>Back to splash</button>
  </div>`;
  $('#detail-art').classList.add('is-chroma');
  renderDetail(ctx);
}

function closeChroma(ctx) {
  if (ctx) ctx.chromaView = 0;
  const box = $('#detail-chroma');
  if (box) box.innerHTML = '';
  $('#detail-art').classList.remove('is-chroma');
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
  refreshChromas(ctx);
  renderDetail(ctx);
  return ctx.chromaLoad;
}

function closeDetail() {
  stopVideo();
  closeChroma(detailCtx);
  $('#detail').hidden = true;
  document.body.classList.remove('detail-open');
  detailCtx = null;
}

// --- mythic shop ---------------------------------------------------------

const ME_ICON = '/lcu' + ART + 'Mythic_Essence_490px.png';

const SHOP_KIND = { skin: 'Skin', chroma: 'Chroma', icon: 'Icon', emote: 'Emote', other: 'Item' };

async function loadShop() {
  if (state.shop.loading) return;
  state.shop.loading = true;
  state.shop.error = null;
  renderShop();
  try {
    const res = await fetch('/api/mythic-shop');
    if (!res.ok) throw new Error(res.status === 503 ? 'The client is not running.' : `Could not load the shop (${res.status}).`);
    const data = await res.json();
    state.shop.stores = data.stores || [];

    // testovaci nabidka, at jde nakup vyzkouset bez utraceni esence
    if (globalThis.TestChest && testItemsOn()) {
      try {
        if (!testOffer) testOffer = await TestChest.shopOffer();
        state.shop.stores = state.shop.stores.concat([{
          id: 'TEST_SHOP', label: 'Test offer (simulated)', endTime: null, entries: [testOffer], isTest: true,
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
  if (!(ms > 0)) return 'ending';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const hrs = Math.floor((min % 1440) / 60);
  if (d) return `ends in ${d} d ${hrs} h`;
  if (hrs) return `ends in ${hrs} h ${min % 60} min`;
  return `ends in ${min} min`;
}

function renderShop() {
  const grid = $('#grid-shop');
  if (!grid) return;

  const me = countOf('CURRENCY_mythic');
  $('#shop-balance').innerHTML = `<img src="${ME_ICON}" alt=""><b>${me.toLocaleString('en-US')}</b><span>Mythic Essence</span>`;

  const buyable = shopEntries().filter((e) => !e.owned && !e.isTest).length;
  const pill = $('.pill[data-count="shop"]');
  if (pill) pill.textContent = state.shop.loadedAt ? buyable : '-';

  if (state.shop.loading && !state.shop.stores.length) { grid.innerHTML = '<div class="empty">Loading the shop…</div>'; return; }
  if (state.shop.error) { grid.innerHTML = `<div class="empty">${escapeHtml(state.shop.error)}</div>`; return; }
  if (!state.shop.stores.length) { grid.innerHTML = '<div class="empty">The shop is empty right now.</div>'; return; }

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
  if (e.owned) action = '<button disabled>Owned</button>';
  else if (!enough) action = `<button disabled>Need ${(e.price - me).toLocaleString('en-US')} more</button>`;
  else action = `<button data-action="buy:${escapeHtml(e.catalogEntryId)}">Buy</button>`;

  return `<div class="card shop-card ${e.owned ? 'is-owned' : ''} ${e.isTest ? 'card-test' : ''}">
    <div class="card-img ${contain ? 'contain' : ''}">
      ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="card-glyph">${glyph({ itemDesc: e.name })}</span>`}
      ${e.rarity && e.rarity !== 'DEFAULT' ? `<img class="shop-gem" src="${Reel.GEM(e.rarity)}" alt="${e.rarity}" title="${e.rarity}">` : ''}
      ${e.owned ? '<span class="owned-ribbon" title="You already own this"><i></i>OWNED</span>' : ''}
      ${e.isTest ? '<span class="card-badge is-test">SIMULATED</span>' : ''}
      <span class="card-rarity r-${e.rarity || 'DEFAULT'}"></span>
    </div>
    <div class="card-body">
      <div class="card-name">${escapeHtml(e.name)}</div>
      <div class="card-meta">${SHOP_KIND[e.kind] || 'Item'}</div>
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
    if (!globalThis.TestChest) throw new Error('Test offer without the simulator.');
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
  if (!purchaseId) throw new Error('The client did not return a purchase id - check in the client whether the purchase went through.');

  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const st = await lcu('/lol-shoppefront/v1/purchases/' + encodeURIComponent(purchaseId));
    const status = String((st && st.status) || '');
    if (/^(success|complete)/i.test(status)) return st;
    if (/^(failure|fail|error)/i.test(status)) throw new Error('The purchase failed, the client reported an error. Your essence was not spent.');
    await sleep(400);
  }
  throw new Error('The purchase was not confirmed within 20 s. Check in the client whether it went through before trying again.');
}

async function buyOffer(catalogEntryId) {
  const entry = shopEntries().find((e) => e.catalogEntryId === catalogEntryId);
  if (!entry) return toast('This offer is no longer in the shop.', true);
  if (entry.owned) return toast('You already own this.', true);

  const me = countOf('CURRENCY_mythic');
  if (!entry.isTest && me < entry.price) return toast(`You need ${entry.price - me} more Mythic Essence.`, true);

  const ok = await confirmModal(
    entry.isTest ? 'TEST - buy?' : 'Buy with Mythic Essence?',
    `${entry.name} for ${entry.price} Mythic Essence` +
    (entry.isTest ? '. This is a simulation - nothing happens to your account.' : ` (${me - entry.price} left afterwards). Purchases cannot be refunded.`)
  );
  if (!ok) return;

  await withBusy(async () => {
    showReveal(entry.isTest ? 'TEST - Mythic Shop (simulated)' : 'Mythic Shop');
    await purchase(entry);
    if (!entry.isTest) bumpStats({ purchases: 1, spent: { CURRENCY_mythic: entry.price } });
    const drop = {
      name: entry.name, img: entry.img ? '/lcu' + entry.img : '', icon: entry.kind !== 'skin',
      splash: entry.splash ? '/lcu' + entry.splash : '',
      rarity: entry.rarity || 'DEFAULT', type: entry.kind.toUpperCase(), count: 1, lootId: entry.catalogEntryId,
    };
    // vis, co kupujes - obrad, zadne toceni
    await revealDrops([drop], entry.isTest ? 'TEST - bought, account unchanged' : 'Purchased', { unlock: true });
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
  $('#reveal-progress').hidden = true;
  const stop = $('#reveal-stop');
  stop.hidden = true;
  stop.disabled = false;
  stop.textContent = 'Stop after this batch';
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
    wrap.innerHTML = '<div class="empty">The client returned nothing.</div>';
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
      wrap.insertAdjacentHTML('beforeend', '<button class="ghost-btn detail-open-btn" data-drop="0">Skin details</button>');
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
    (RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)) || a.name.localeCompare(b.name, 'en'));

  const sum = (pred) => items.filter(pred).reduce((n, i) => n + i.count, 0);
  const totals = [];
  const skins = sum((i) => /SKIN/.test(i.type));
  const champs = sum((i) => /^CHAMPION/.test(i.type));
  if (skins) totals.push(`${skins} ${plural(skins, 'skin shard', 'skin shards', 'skin shards')}`);
  if (champs) totals.push(`${champs} ${plural(champs, 'champion shard', 'champion shards', 'champion shards')}`);
  for (const i of items.filter((x) => x.type === 'CURRENCY')) totals.push(`+${i.count.toLocaleString('en-US')} ${i.name.toLowerCase()}`);
  for (const i of items.filter((x) => !/SKIN|^CHAMPION|^CURRENCY$/.test(x.type))) totals.push(`${i.count}&times; ${escapeHtml(i.name.toLowerCase())}`);

  const best = items[0];
  lastDrops = items;
  const cards = items.map((d, idx) => `
    <div class="sum-card rare-${d.rarity || 'DEFAULT'} ${d === best && RARITY_ORDER.indexOf(d.rarity) > 0 ? 'is-top' : ''}" ${skinIdOf(d) ? `data-drop="${idx}" title="Show details"` : ''} style="animation-delay:${Math.min(idx * 45, 900)}ms">
      <div class="sum-img ${d.icon ? 'contain' : ''}">
        ${d.img ? `<img src="${d.img}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<span class="sum-glyph"></span>'}
        ${d.rarity && d.rarity !== 'DEFAULT' ? `<img class="sum-gem" src="${Reel.GEM(d.rarity)}" alt="${d.rarity}" title="${d.rarity}">` : ''}
        ${d.count > 1 ? `<span class="sum-count">&times;${d.count.toLocaleString('en-US')}</span>` : ''}
      </div>
      <div class="sum-name">${escapeHtml(d.name)}</div>
      ${skinChampionOf(d) ? skinsChipHtml(skinChampionOf(d)) : ''}
      <div class="sum-type">${escapeHtml(typeLabel(d.type || ''))}</div>
    </div>`).join('');

  return `<div class="summary">
    <div class="summary-head">
      <span class="summary-title">YOUR DROPS</span>
      <span class="summary-count">${drops.length} ${plural(drops.length, 'item', 'items', 'items')}</span>
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
  const hist = readStore('lootforge.history', []);
  const now = Date.now();
  hist.unshift(...drops.map((d) => ({ ...d, at: now })));
  localStorage.setItem('lootforge.history', JSON.stringify(hist.slice(0, 400)));
  renderSession();
}

/*
 * Statistiky ziji jen v localStorage tohohle prohlizece ("gamba.stats").
 * Cisla se prictou, objekty (esence, rarity, bedny) se prictou po klicich.
 * Starsi zaznam { opened, disenchanted } se nacte beze ztraty.
 * Testovaci polozky sem nikdy nezapisuji - volajici to hlidaji.
 */
const STATS_MAPS = ['chests', 'rarity', 'kinds', 'gained', 'spent'];

function readStats() {
  const s = readStore('lootforge.stats', {});
  const out = { since: s.since || 0 };
  for (const k of ['opened', 'disenchanted', 'rerolls', 'unlocked', 'purchases']) out[k] = Number(s[k]) || 0;
  for (const k of STATS_MAPS) out[k] = (s[k] && typeof s[k] === 'object') ? s[k] : {};
  return out;
}

function bumpStats(delta) {
  const s = readStats();
  if (!s.since) s.since = Date.now();
  for (const [k, v] of Object.entries(delta)) {
    if (v && typeof v === 'object') {
      s[k] = s[k] || {};
      for (const [kk, n] of Object.entries(v)) s[k][kk] = (s[k][kk] || 0) + (Number(n) || 0);
    } else {
      s[k] = (s[k] || 0) + (Number(v) || 0);
    }
  }
  try { localStorage.setItem('lootforge.stats', JSON.stringify(s)); } catch (_) { /* plny storage */ }
  renderSession();
}

/** Druh dropu do statistik. */
function kindOf(d) {
  const type = String(d.type || '');
  if (/SKIN/.test(type) && !/WARD/.test(type)) return 'skin';
  if (/^CHAMPION/.test(type)) return 'champion';
  if (type === 'CURRENCY') return 'currency';
  if (/WARD/.test(type)) return 'ward';
  if (/EMOTE/.test(type)) return 'emote';
  if (/ICON/.test(type)) return 'icon';
  return 'other';
}

const KIND_LABEL = {
  skin: 'skin shards', champion: 'champion shards', currency: 'essence & currency',
  ward: 'ward shards', emote: 'emotes', icon: 'icons', other: 'other',
};

/** Otevrene bedny do statistik: kolik, jake, a co z nich padlo. */
function recordChests(chestName, times, drops) {
  const rarity = {};
  const kinds = {};
  for (const d of drops) {
    const kind = kindOf(d);
    // u men je count mnozstvi esence, ne pocet dropu
    const n = kind === 'currency' ? 1 : (d.count || 1);
    kinds[kind] = (kinds[kind] || 0) + n;
    if (kind === 'skin') rarity[d.rarity || 'DEFAULT'] = (rarity[d.rarity || 'DEFAULT'] || 0) + n;
  }
  bumpStats({ opened: times, chests: { [chestName]: times }, kinds, rarity, gained: currencyOf(drops) });
}

function renderSession() {
  const hist = readStore('lootforge.history', []);
  const s = readStats();
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  const best = hist.reduce((b, d) => (RARITY_ORDER.indexOf(d.rarity) > RARITY_ORDER.indexOf(b.rarity || 'DEFAULT') ? d : b), {});
  const skinDrops = s.kinds.skin || 0;
  const perChest = s.opened ? (skinDrops / s.opened) : 0;

  const tile = (value, label, extra) => `<div class="stat"><b>${value}</b><span>${label}</span>${extra ? `<em>${extra}</em>` : ''}</div>`;
  const cur = (map, id) => `<span class="essence">${LOOT_ART[id] ? `<img src="/lcu${LOOT_ART[id]}" alt="">` : ''}${fmt(map[id])}</span>`;

  $('#stats-since').textContent = s.since ? `counted since ${new Date(s.since).toLocaleDateString('en-US')}` : 'nothing counted yet';

  $('#stats').innerHTML = [
    tile(fmt(s.opened), 'chests opened'),
    tile(fmt(skinDrops), 'skin shards from chests', s.opened ? `${perChest.toFixed(2)} per chest` : ''),
    tile(fmt(s.disenchanted), 'items disenchanted'),
    tile(fmt(s.unlocked), 'unlocked permanently'),
    tile(fmt(s.rerolls), 'rerolls'),
    tile(fmt(s.purchases), 'Mythic Shop purchases'),
    `<div class="stat stat-wide"><div class="stat-flow">${cur(s.gained, 'CURRENCY_champion')}${cur(s.gained, 'CURRENCY_cosmetic')}</div><span>essence gained (chests + disenchanting)</span></div>`,
    `<div class="stat stat-wide"><div class="stat-flow">${cur(s.spent, 'CURRENCY_champion')}${cur(s.spent, 'CURRENCY_cosmetic')}${cur(s.spent, 'CURRENCY_mythic')}</div><span>essence spent (unlocks + shop)</span></div>`,
    tile(best.rarity && best.rarity !== 'DEFAULT' ? best.rarity.toLowerCase() : '-', 'best drop', best.name ? escapeHtml(best.name) : ''),
  ].join('');

  $('#stats-charts').innerHTML = rarityChartHtml(s.rarity) + kindsChartHtml(s.kinds) + chestsChartHtml(s.chests);

  $('#history').innerHTML = hist.slice(0, 120).map((d) => `
    <div class="h-row rare-${d.rarity}">
      ${d.img ? `<img src="${d.img}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <span class="h-name">${escapeHtml(d.name)}${d.count > 1 ? ` x${d.count}` : ''}</span>
      <span>${escapeHtml(typeLabel(d.type || ''))}</span>
      <span class="h-time">${new Date(d.at).toLocaleTimeString('en-US')}</span>
    </div>`).join('') || '<div class="empty">Nothing yet. Open a chest.</div>';
}

function pct(n, total) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

/** Rarity skin shardu z beden: pruh slozeny z barev rarit + legenda. */
function rarityChartHtml(rarity) {
  const rows = RARITY_ORDER.map((r) => [r, rarity[r] || 0]).filter(([, n]) => n > 0);
  const total = rows.reduce((n, [, x]) => n + x, 0);
  if (!total) return '';
  return `<section class="chart">
    <h3>Skin shard rarity <span>${total}</span></h3>
    <div class="rbar">${rows.map(([r, n]) => `<i class="r-${r}" style="flex-grow:${n}" title="${r.toLowerCase()}: ${n}"></i>`).join('')}</div>
    <div class="chart-legend">${rows.map(([r, n]) => `
      <span>${r !== 'DEFAULT' ? `<img src="${Reel.GEM(r)}" alt="">` : '<i class="r-DEFAULT"></i>'}${r === 'DEFAULT' ? 'no rarity' : r.toLowerCase()} <b>${n}</b> <em>${pct(n, total).toLocaleString('en-US')}%</em></span>`).join('')}
    </div>
  </section>`;
}

function barsHtml(title, rows) {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  const total = rows.reduce((n, [, x]) => n + x, 0);
  if (!total) return '';
  return `<section class="chart">
    <h3>${title} <span>${total.toLocaleString('en-US')}</span></h3>
    <div class="bars">${rows.map(([label, n]) => `
      <div class="bar-row"><span class="bar-label">${escapeHtml(label)}</span>
        <span class="bar-track"><i style="width:${Math.max(2, (n / max) * 100)}%"></i></span>
        <b>${n.toLocaleString('en-US')}</b></div>`).join('')}
    </div>
  </section>`;
}

function kindsChartHtml(kinds) {
  const rows = Object.keys(KIND_LABEL).map((k) => [KIND_LABEL[k], kinds[k] || 0]).filter(([, n]) => n > 0);
  return barsHtml('What chests drop', rows.sort((a, b) => b[1] - a[1]));
}

function chestsChartHtml(chests) {
  const rows = Object.entries(chests).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return barsHtml('Chests opened', rows);
}

/** Stahne statistiky a historii jako JSON (appka bezi lokalne, stahovani funguje). */
function exportStats() {
  const data = { exported: new Date().toISOString(), stats: readStats(), history: readStore('lootforge.history', []) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lootforge-stats-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// --- kolekce -------------------------------------------------------------

const COLLECTION_KINDS = [
  ['skins', 'Skins', 'skins'],
  ['champions', 'Champions', 'champions'],
  ['chromas', 'Chromas', 'chromas'],
  ['emotes', 'Emotes', 'emotes'],
  ['icons', 'Icons', 'icons'],
  ['wards', 'Wards', 'wards'],
  ['finishers', 'Finishers', 'finishers'],
];

async function loadCollection() {
  const col = state.collection;
  if (col.loading) return;
  col.loading = true;
  col.error = null;
  renderCollection();
  try {
    const res = await fetch('/api/collection');
    if (res.status === 404) throw new Error('The server is outdated - restart `node server.js`.');
    if (!res.ok) throw new Error(res.status === 503 ? 'The client is not running.' : `Could not load the collection (${res.status}).`);
    col.data = await res.json();
    col.loadedAt = Date.now();
  } catch (err) {
    col.error = err.message || String(err);
  } finally {
    col.loading = false;
    renderCollection();
  }
}

function setCollection(key, value) {
  state.collection[key] = value;
  if (key === 'kind') { state.collection.rarity = ''; if (value !== 'skins' && state.collection.sort === 'rarity') state.collection.sort = 'new'; }
  renderCollection();
  saveUi();
}

/** Polozky zvoleneho druhu po hledani a razeni. */
function collectionItems() {
  const col = state.collection;
  const data = col.data;
  if (!data) return [];
  const names = data.championNames || {};
  const q = fold(col.q).trim();
  // presne jmeno sampiona = jen jeho veci ("Vi" nema vratit Viega ani Victorious skiny)
  const champId = q && col.kind !== 'champions'
    ? Number(Object.keys(names).find((id) => fold(names[id]) === q)) || 0
    : 0;
  const list = (data[col.kind] || []).filter((x) => {
    if (col.rarity && (x.rarity || 'DEFAULT') !== col.rarity) return false;
    if (champId && x.championId != null) return x.championId === champId;
    if (!q) return true;
    return fold(x.name).includes(q) || fold(names[x.championId]).includes(q) || fold(x.skinName).includes(q);
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'en');
  const sorters = {
    new: (a, b) => b.at - a.at,
    old: (a, b) => (a.at || Infinity) - (b.at || Infinity),
    name: byName,
    rarity: (a, b) => (RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)) || byName(a, b),
    champion: (a, b) => String(names[a.championId] || '').localeCompare(String(names[b.championId] || ''), 'en') || byName(a, b),
    skins: (a, b) => (b.skins - a.skins) || byName(a, b),
  };
  return list.slice().sort(sorters[col.sort] || sorters.new);
}

function renderCollection() {
  const grid = $('#grid-collection');
  if (!grid) return;
  const col = state.collection;
  const data = col.data;

  $('#col-kinds').innerHTML = COLLECTION_KINDS.map(([kind, label]) => {
    const have = data ? (data[kind] || []).length : 0;
    const total = data && data.totals ? data.totals[kind] || 0 : 0;
    const p = pct(have, total);
    return `<button class="col-kind ${col.kind === kind ? 'is-active' : ''}" data-col-kind="${kind}">
      <span class="col-kind-label">${label}</span>
      <b>${data ? have.toLocaleString('en-US') : '–'}</b>
      <em>${total ? `of ${total.toLocaleString('en-US')} &middot; ${p.toLocaleString('en-US')}%` : '&nbsp;'}</em>
      <i class="col-progress"><i style="width:${Math.min(100, p)}%"></i></i>
    </button>`;
  }).join('');

  // razeni a rarita jen tam, kde davaji smysl
  const sortSel = $('#col-sort');
  const opts = [['new', 'Newest'], ['old', 'Oldest'], ['name', 'Name']];
  if (col.kind === 'skins') opts.push(['rarity', 'Rarity']);
  if (col.kind === 'skins' || col.kind === 'chromas') opts.push(['champion', 'Champion']);
  if (col.kind === 'champions') opts.push(['skins', 'Most skins']);
  sortSel.innerHTML = opts.map(([v, l]) => `<option value="${v}" ${col.sort === v ? 'selected' : ''}>${l}</option>`).join('');
  $('#col-rarity').hidden = col.kind !== 'skins';

  if (col.error) { grid.innerHTML = `<div class="empty">${escapeHtml(col.error)}</div>`; return; }
  if (!data) { grid.innerHTML = `<div class="empty">${state.connected || col.loading ? 'Loading your collection…' : 'Start the League client - the app connects automatically.'}</div>`; return; }

  const items = collectionItems();
  const label = (COLLECTION_KINDS.find(([k]) => k === col.kind) || [])[2] || 'items';
  $('#col-count').textContent = col.q || col.rarity ? `found ${items.length} ${label}` : '';
  if (!items.length) { grid.innerHTML = '<div class="empty">Nothing like that in your collection.</div>'; return; }

  const names = data.championNames || {};
  const wide = col.kind === 'skins' || col.kind === 'finishers';
  grid.innerHTML = `<div class="col-grid ${wide ? 'is-wide' : ''} kind-${col.kind}">${items.map((x) => collectionCardHtml(x, col.kind, names)).join('')}</div>`;
}

function collectionCardHtml(x, kind, names) {
  const date = x.at ? new Date(x.at).toLocaleDateString('en-US') : '';
  let sub = date ? `since ${date}` : '';
  let attrs = '';
  if (kind === 'skins') { sub = names[x.championId] || ''; attrs = `data-col-skin="${x.id}" title="Skin details"`; }
  if (kind === 'chromas') { sub = x.skinName || names[x.championId] || ''; attrs = `data-col-chroma="${x.id}" title="Show on the skin"`; }
  if (kind === 'champions') { sub = x.skins ? `${x.skins} ${skinsWord(x.skins)}` : 'no skins'; attrs = x.skins ? `data-col-champ="${x.id}" title="Show skins"` : ''; }
  const name = kind === 'chromas' ? ((String(x.name).match(/\(([^)]+)\)\s*$/) || [])[1] || x.name) : x.name;

  return `<div class="col-card rare-${x.rarity || 'DEFAULT'}" ${attrs}>
    <div class="col-img">
      ${x.img ? `<img src="/lcu${x.img}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="card-glyph">${glyph({ itemDesc: x.name })}</span>`}
      ${x.rarity && x.rarity !== 'DEFAULT' ? `<img class="col-gem" src="${Reel.GEM(x.rarity)}" alt="${x.rarity}">` : ''}
    </div>
    <div class="col-name">${kind === 'chromas' ? `<span class="swatch" style="background:${swatchCss(x.colors)}"></span>` : ''}${escapeHtml(name)}</div>
    ${sub ? `<div class="col-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

/** Detail skinu z kolekce - stejny jako u shardu, jen bez akci. */
function openCollectionSkin(skinId, chromaId) {
  const data = state.collection.data;
  const sk = data && data.skins.find((x) => x.id === skinId);
  const ctx = sk
    ? { item: null, skinId, name: sk.name, rarity: sk.rarity, tile: '/lcu' + sk.img, centered: sk.splash ? '/lcu' + sk.splash : '', championId: sk.championId }
    : null;
  if (!ctx) return null;
  const opened = showDetail(ctx);
  if (chromaId) ctx.chromaLoad.then(() => { if (detailCtx === ctx) showChroma(chromaId); });
  return opened;
}

/** Chroma z kolekce: detail rodicovskeho skinu s rozkliknutou chromou. */
function openCollectionChroma(chromaId) {
  const data = state.collection.data;
  const ch = data && data.chromas.find((x) => x.id === chromaId);
  if (!ch) return null;
  if (data.skins.some((x) => x.id === ch.skinId)) return openCollectionSkin(ch.skinId, chromaId);
  toast('You own this chroma but not its skin - details are only available for owned skins.');
  return null;
}

// --- vyber shardu -------------------------------------------------------

function toggleSelect(lootId) {
  if (state.rerollMode && !state.selected.has(lootId)) {
    if (!recipeOfType(lootId, 'REROLL')) return toast('This shard cannot be rerolled.', true);
    if (state.selected.size >= 3) return toast('A reroll takes exactly 3 shards. Remove one first.', true);
    if (isMixedBatch([...state.selected, lootId])) return toast('Don\'t mix test shards with real ones.', true);
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

  $('#ab-count').textContent = `${ids.length} selected (${pieces} pcs)`;
  $('#ab-value').textContent = `+${value.toLocaleString('en-US')} essence for disenchanting`;
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

// --- nastaveni a uvodni upozorneni ---------------------------------------

// --- kontrola nove verze ------------------------------------------------------

/*
 * Jednou za 12 hodin se prohlizec zepta GitHubu na posledni release (verejne
 * API, bez prihlaseni, umi CORS). Server s internetem nemluvi. Jde vypnout
 * v Nastaveni. Dokud v package.json neni skutecne repo, server posle
 * repo: null a nic se nekontroluje.
 */
const UPDATE_EVERY = 12 * 3600000;

function updatesOn() {
  try { return localStorage.getItem('lootforge.updates') !== '0'; } catch (_) { return true; }
}

/** 1.10.0 > 1.9.2; "v" na zacatku a pripona (-beta) se ignoruji. */
function isNewerVersion(latest, current) {
  const parts = (v) => String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => Number(x) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdates(force) {
  const app = state.app;
  if (!app || !app.repo || !/^[\w.-]+\/[\w.-]+$/.test(app.repo) || (!force && !updatesOn())) return null;

  let info = readStore('lootforge.update', null);
  const fresh = info && info.repo === app.repo && Date.now() - info.checked < UPDATE_EVERY;
  if (force || !fresh) {
    const res = await fetch(`https://api.github.com/repos/${app.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('github ' + res.status);
    const rel = await res.json();
    const releases = `https://github.com/${app.repo}/releases`;
    info = {
      repo: app.repo,
      checked: Date.now(),
      latest: String(rel.tag_name || '').replace(/^v/i, ''),
      // odkaz jen do vlastniho repa - nic, co by podstrcila odpoved
      url: String(rel.html_url || '').startsWith(releases + '/') ? rel.html_url : releases + '/latest',
    };
    try { localStorage.setItem('lootforge.update', JSON.stringify(info)); } catch (_) { /* priste znovu */ }
  }
  renderUpdate(info);
  return info;
}

function renderUpdate(info) {
  const el = $('#update');
  const newer = !!(info && state.app && isNewerVersion(info.latest, state.app.version));
  el.hidden = !newer;
  if (!newer) return;
  el.href = info.url;
  el.textContent = `v${info.latest} available`;
  el.title = `You have v${state.app.version}. Download LootForge v${info.latest} from GitHub.`;
}

function testItemsOn() {
  try { return localStorage.getItem('lootforge.testItems') === '1'; } catch (_) { return false; }
}

function openSettings() {
  $('#yt-key').value = youtubeKey();
  $('#test-items').checked = testItemsOn();
  $('#show-welcome').checked = !welcomeAccepted();
  $('#update-check').checked = updatesOn();
  renderKeyStatus();
  renderUpdateStatus();
  $('#settings').hidden = false;
  document.body.classList.add('detail-open');
}

function renderUpdateStatus() {
  const el = $('#update-status');
  const app = state.app;
  if (!app) { el.textContent = ''; return; }
  if (!app.repo) { el.textContent = `You have v${app.version}. This build has no release page to check.`; return; }
  const info = readStore('lootforge.update', null);
  el.textContent = info && info.repo === app.repo
    ? (isNewerVersion(info.latest, app.version)
      ? `v${info.latest} is available (you have v${app.version}).`
      : `You have the latest version (v${app.version}).`)
    : `You have v${app.version}.`;
}

function closeSettings() {
  $('#settings').hidden = true;
  document.body.classList.remove('detail-open');
}

function renderKeyStatus() {
  $('#yt-key-status').textContent = youtubeKey()
    ? 'Key saved - videos play inside LootForge.'
    : 'No key - Video preview opens YouTube in a new tab.';
}

function saveYoutubeKey(value) {
  const key = String(value || '').trim();
  try {
    if (key) localStorage.setItem('lootforge.ytKey', key);
    else localStorage.removeItem('lootforge.ytKey');
  } catch (_) { /* bez localStorage klic nepujde ulozit */ }
  $('#yt-key').value = key;
  renderKeyStatus();
  if (detailCtx) renderDetail(detailCtx);
}

async function setTestItems(on) {
  try { localStorage.setItem('lootforge.testItems', on ? '1' : '0'); } catch (_) { /* jen pohodli */ }
  state.shop.loadedAt = 0;   // testovaci nabidka v obchode taky
  if (!on) {
    // vyhodit hned, ne az pri dalsim nacteni
    state.items = state.items.filter((i) => !i.isTest);
    state.byId = new Map(state.items.map((i) => [i.lootId, i]));
    for (const id of [...state.selected]) if (!state.byId.has(id)) state.selected.delete(id);
  }
  if (!state.busy) await loadLoot().catch(() => {});
  if (state.scope === 'shop') loadShop();
}

function welcomeAccepted() {
  try { return localStorage.getItem('lootforge.welcome') === '1'; } catch (_) { return false; }
}

function acceptWelcome() {
  try { localStorage.setItem('lootforge.welcome', '1'); } catch (_) { /* ukaze se znovu, nevadi */ }
  $('#welcome').hidden = true;
}

// --- eventy -------------------------------------------------------------

// --- zapamatovany stav UI ----------------------------------------------------

/*
 * Posledni tab, filtry (bez hledaneho textu - ten by po navratu jen matl)
 * a nastaveni kolekce. Reroll rezim ani vyber se neukladaji schvalne.
 */
function saveUi() {
  const filters = {};
  for (const scope of FILTER_SCOPES) {
    const f = state.filters[scope];
    if (f) filters[scope] = { rarity: f.rarity, own: f.own, sort: f.sort };
  }
  const col = state.collection;
  try {
    localStorage.setItem('lootforge.ui', JSON.stringify({
      tab: state.scope, filters, collection: { kind: col.kind, sort: col.sort, rarity: col.rarity },
    }));
  } catch (_) { /* jen pohodli */ }
}

function restoreUi() {
  const ui = readStore('lootforge.ui', null);
  if (!ui || typeof ui !== 'object') return;
  const str = (v) => (typeof v === 'string' ? v : '');

  for (const scope of FILTER_SCOPES) {
    const saved = ui.filters && ui.filters[scope];
    if (!saved) continue;
    const f = filterOf(scope);
    f.rarity = str(saved.rarity);
    f.own = str(saved.own);
    f.sort = str(saved.sort) || 'rarity';
  }
  // pole ve strance musi ukazovat totez, co filtr
  $$('[data-f][data-scope]').forEach((el) => {
    const f = state.filters[el.dataset.scope];
    if (f && el.dataset.f !== 'q') el.value = f[el.dataset.f] || (el.dataset.f === 'sort' ? 'rarity' : '');
  });

  const c = ui.collection || {};
  if (COLLECTION_KINDS.some(([k]) => k === c.kind)) state.collection.kind = c.kind;
  if (str(c.sort)) state.collection.sort = c.sort;
  state.collection.rarity = str(c.rarity);
  $('#col-rarity').value = state.collection.rarity;

  if (TABS.includes(ui.tab) && ui.tab !== state.scope) switchTab(ui.tab);
}

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  if (state.rerollMode) setRerollMode(false);
  $$('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
  state.scope = tab;
  state.selected.clear();
  saveUi();
  renderActionbar();
  if (state.scope === 'shop') {
    // rotace a vlastnictvi se meni - po minute radsi nacist znovu
    if (Date.now() - state.shop.loadedAt > 60000) loadShop();
    else renderShop();
    return;
  }
  if (state.scope === 'collection') {
    if (Date.now() - state.collection.loadedAt > 60000) loadCollection();
    else renderCollection();
    return;
  }
  if (state.scope === 'session') { renderSession(); return; }
  renderGrid(state.scope, itemsIn(state.scope));
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (btn) switchTab(btn.dataset.tab);
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

  const fav = e.target.closest('[data-fav]');
  if (fav) { toggleFavorite(fav.dataset.fav); return; }

  if (e.target.closest('[data-detail-back]')) { previewSkin(0); return; }
  if (e.target.closest('[data-video]')) { toggleVideo(); return; }
  if (e.target.closest('[data-chroma-close]')) { closeChroma(detailCtx); if (detailCtx) renderDetail(detailCtx); return; }
  const chroma = e.target.closest('[data-chroma]');
  if (chroma) { showChroma(Number(chroma.dataset.chroma)); return; }

  const preview = e.target.closest('[data-preview]');
  if (preview && !$('#detail').hidden) { previewSkin(Number(preview.dataset.preview)); return; }

  const dropCard = e.target.closest('[data-drop]');
  if (dropCard) { openDetailFromDrop(lastDrops[Number(dropCard.dataset.drop)]); return; }

  // uklid
  const clSkip = e.target.closest('[data-cl-skip]');
  if (clSkip) { toggleCleanupSkip(clSkip.dataset.clSkip); return; }

  // kolekce
  const colKind = e.target.closest('[data-col-kind]');
  if (colKind) { setCollection('kind', colKind.dataset.colKind); return; }
  const colSkin = e.target.closest('[data-col-skin]');
  if (colSkin) { openCollectionSkin(Number(colSkin.dataset.colSkin)); return; }
  const colChroma = e.target.closest('[data-col-chroma]');
  if (colChroma) { openCollectionChroma(Number(colChroma.dataset.colChroma)); return; }
  const colChamp = e.target.closest('[data-col-champ]');
  if (colChamp) {
    // sampion -> jeho skiny
    const names = (state.collection.data && state.collection.data.championNames) || {};
    state.collection.q = names[colChamp.dataset.colChamp] || '';
    $('#col-search').value = state.collection.q;
    setCollection('kind', 'skins');
    return;
  }

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
  if (!$('#welcome').hidden) {
    if (e.key === 'Enter') { e.preventDefault(); acceptWelcome(); }
    return;
  }

  if (!$('#settings').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    return;
  }

  if (!$('#modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); $('#modal-cancel').click(); }
    if (e.key === 'Enter')  { e.preventDefault(); $('#modal-ok').click(); }
    return;
  }

  if (!$('#detail').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
    return;
  }

  if (!$('#cleanup').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeCleanup(); }
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

$('#settings-open').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });
$('#yt-key-save').addEventListener('click', () => saveYoutubeKey($('#yt-key').value));
$('#yt-key-clear').addEventListener('click', () => saveYoutubeKey(''));
$('#test-items').addEventListener('change', (e) => setTestItems(e.target.checked));
$('#update-check').addEventListener('change', (e) => {
  try { localStorage.setItem('lootforge.updates', e.target.checked ? '1' : '0'); } catch (_) { /* jen pohodli */ }
  if (e.target.checked) checkForUpdates().then(renderUpdateStatus, renderUpdateStatus);
  else $('#update').hidden = true;
});
$('#show-welcome').addEventListener('change', (e) => {
  try { localStorage.setItem('lootforge.welcome', e.target.checked ? '0' : '1'); } catch (_) { /* jen pohodli */ }
});
$('#welcome-ok').addEventListener('click', acceptWelcome);
$('#cleanup-open').addEventListener('click', openCleanup);
$('#cleanup-close').addEventListener('click', closeCleanup);
$('#cleanup-go').addEventListener('click', runCleanup);
$('#cleanup').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeCleanup(); });
$('#export-stats').addEventListener('click', exportStats);

// filtry a nastaveni: pole se nekresli znovu, takze neprijdou o fokus
function onFieldChange(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  const f = t.closest('[data-f]');
  if (f) { setFilter(f.dataset.scope, f.dataset.f, f.value); return; }
  const rule = t.closest('[data-cl-rule]');
  if (rule && e.type === 'change') { toggleCleanupRule(rule.dataset.clRule, rule.checked); return; }
  const col = t.closest('[data-col]');
  if (col) setCollection(col.dataset.col, col.value);
}
document.addEventListener('input', onFieldChange);
document.addEventListener('change', onFieldChange);

$$('[data-freset]').forEach((btn) => btn.addEventListener('click', () => {
  const scope = btn.dataset.freset;
  state.filters[scope] = null;
  $$(`[data-f][data-scope="${scope}"]`).forEach((el) => { el.value = el.tagName === 'SELECT' ? el.options[0].value : ''; });
  renderGrid(scope, itemsIn(scope));
  saveUi();
}));

$('#reveal-stop').addEventListener('click', requestStop);

$('#clear-session').addEventListener('click', async () => {
  if (!await confirmModal('Clear statistics?', 'Deletes the statistics and history stored in this browser. Your account is not affected.')) return;
  localStorage.removeItem('lootforge.history');
  localStorage.removeItem('lootforge.stats');
  renderSession();
});

$$('[data-select]').forEach((btn) => {
  btn.addEventListener('click', () => selectIn(btn.dataset.scope, btn.dataset.select));
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
      else { setConnected(false); renderAll(); bootWaiting(); }
    });

    // spojeni se serverem spadlo: bud exe skoncilo, nebo se jen restartuje.
    // EventSource se znovu pripojuje sam, tady jen zjistit, co se deje.
    stream.addEventListener('error', () => {
      if (!state.busy) checkConnection().then((ok) => { if (ok) loadLoot().catch(() => {}); });
    });

    return true;
  } catch (_) {
    return false;
  }
}

// --- uvodni obrazovka: pripojovani ke klientovi -------------------------

/*
 * Pres celou appku, dokud neni klient pripojeny a loot nacteny. Faze:
 *   searching - prave hledame (prvni vterina)
 *   waiting   - klient nebezi, poradime, co udelat
 *   connected - animace pripojeni se jmenem hrace, pak zmizi
 *   stopped   - neodpovida ani nas server (exe se zavrel)
 * Kdyz klient pozdeji odpadne, obrazovka se vrati. Behem akce (state.busy)
 * se neukazuje - to resi hromadne smycky samy.
 */
const BOOT_TEXT = {
  searching: 'Looking for the League client…',
  waiting: 'Waiting for the League client',
  connected: 'Connected',
  stopped: 'LootForge has stopped',
};
// cele nazvy trid (ne 'is-' + faze) - css.test.js kontroluje, ze kazda ma pravidlo
const BOOT_CLASS = { searching: 'is-searching', waiting: 'is-waiting', connected: 'is-connected', stopped: 'is-stopped' };
const bootScreen = { phase: 'searching', since: Date.now(), timer: null, leaving: null };

function setBootPhase(phase) {
  const el = $('#boot');
  if (!el || (phase !== 'connected' && state.busy)) return;
  if (bootScreen.phase === phase && !el.hidden && !el.classList.contains('is-leaving')) return;
  clearTimeout(bootScreen.timer);
  clearTimeout(bootScreen.leaving);
  if (el.hidden || bootScreen.phase === 'connected') bootScreen.since = Date.now();
  bootScreen.phase = phase;
  el.hidden = false;
  el.classList.remove('is-searching', 'is-waiting', 'is-connected', 'is-stopped', 'is-leaving');
  el.classList.add(BOOT_CLASS[phase]);
  document.body.classList.add('boot-open');
  $('#boot-status').textContent = BOOT_TEXT[phase];
  if (phase !== 'connected') $('#boot-name').textContent = '';
  const hint = $('#boot-hint');
  hint.hidden = phase !== 'waiting' && phase !== 'stopped';
  hint.innerHTML = phase === 'stopped'
    ? 'Start <b>LootForge</b> again to continue. This page reconnects by itself.'
    : 'Start <b>League of Legends</b> and log in. LootForge connects as soon as the client is ready.';
}

/** Klient nebezi: prvni vterinu jeste "hledame", pak poradime. */
function bootWaiting() {
  const el = $('#boot');
  if (!el || state.busy) return;
  if (el.hidden || bootScreen.phase === 'connected') setBootPhase('searching');
  if (bootScreen.phase !== 'searching') { setBootPhase('waiting'); return; }
  clearTimeout(bootScreen.timer);
  const left = Math.max(0, 1200 - (Date.now() - bootScreen.since));
  bootScreen.timer = setTimeout(() => { if (bootScreen.phase === 'searching' && !state.connected) setBootPhase('waiting'); }, left);
}

/** Klient je tu a loot nacteny: animace pripojeni a pryc s obrazovkou. */
async function bootConnected() {
  const el = $('#boot');
  if (!el || el.hidden || bootScreen.phase === 'connected') return;
  const reduced = !!(globalThis.Reel && Reel.Motion.reduced);
  // at je hledani aspon chvili videt - okamzite probliknuti vypada jako chyba
  const shown = Date.now() - bootScreen.since;
  bootScreen.phase = 'connected';
  if (!reduced && shown < 700) await sleep(700 - shown);

  let name = '';
  try {
    const me = await lcu('/lol-summoner/v1/current-summoner');
    name = me.gameName ? `${me.gameName}#${me.tagLine}` : (me.displayName || '');
  } catch (_) { /* jmeno je jen ozdoba */ }
  if (!state.connected) return;   // mezitim odpadl
  bootScreen.phase = '';
  setBootPhase('connected');
  $('#boot-name').textContent = name ? `Welcome, ${name}` : '';

  bootScreen.leaving = setTimeout(() => {
    el.classList.add('is-leaving');
    bootScreen.leaving = setTimeout(() => {
      if (bootScreen.phase !== 'connected') return;   // mezitim se klient odpojil
      el.hidden = true;
      el.classList.remove('is-leaving');
      document.body.classList.remove('boot-open');
    }, reduced ? 50 : 650);
  }, reduced ? 300 : 1700);
}

// --- start --------------------------------------------------------------

(async function boot() {
  // tlacitka musi na startu ukazovat, jak jsi to nechal minule
  if (globalThis.Reel) {
    $('#sfx-toggle').classList.toggle('is-muted', !Reel.Sfx.enabled);
    $('#fast-toggle').classList.toggle('is-on', Reel.Motion.fast);
  }
  if (!welcomeAccepted()) $('#welcome').hidden = false;
  restoreUi();
  renderSession();
  try { await loadLoot(); } catch (err) { toast(err.message, true); }

  const live = connectLiveUpdates();
  if (live) $('#conn').title = 'Live updates on - loot refreshes automatically';

  // zaloha, kdyby SSE nesedlo; se zivym kanalem staci obcasna kontrola
  setInterval(async () => {
    if (state.busy) return;
    const was = state.connected;
    const now = await checkConnection();
    if (now && !was) loadLoot().catch(() => {});
    if (!now && was) renderAll();
  }, live ? 15000 : 5000);
})();
