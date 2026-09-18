#!/usr/bin/env node
'use strict';

/**
 * LootForge - the local bridge between the browser and the League client (LCU).
 *
 * The browser cannot reach the LCU on its own: it runs on a random port, has a
 * self-signed certificate and wants Basic auth with a token only the running
 * client knows. This server finds those credentials, keeps them to itself and
 * proxies /lcu/* through.
 *
 * No dependencies. `node server.js` and that is it.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

/*
 * As LootForge.exe (a Node single executable application) public/ and
 * package.json are bundled inside the exe and read through node:sea, not from
 * disk. `require('./package.json')` does not work there - the exe can only
 * require built-in modules.
 */
const sea = (() => {
  try { const s = require('node:sea'); return s.isSea() ? s : null; } catch (_) { return null; }
})();

/** An app file by its slash path ("public/app.js") - from the exe, or from disk. */
function readAppFile(rel) {
  if (sea) return Buffer.from(sea.getAsset(rel));
  return fs.readFileSync(path.join(__dirname, ...rel.split('/')));
}

/*
 * The exe runs without a console (the build switches the subsystem to Windows
 * GUI). Its output therefore goes to %LOCALAPPDATA%\LootForge\lootforge.log -
 * without it there would be no way to find out why something failed.
 */
const LOG_FILE = sea ? path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'LootForge', 'lootforge.log') : null;
if (LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const log = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    const { format } = require('util');
    const write = (...args) => log.write(`[${new Date().toISOString()}] ${format(...args)}\n`);
    console.log = write;
    console.error = write;
  } catch (_) { /* it will run without the log too */ }
}

const PORT = Number(process.env.PORT) || 4545;
const PKG = JSON.parse(readAppFile('package.json').toString('utf8'));
const VERSION = PKG.version;
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * "owner/repo" from package.json for the update check. While the placeholder
 * name (YOUR-GITHUB-NAME) is there it returns null and nothing is checked.
 */
function releaseRepo() {
  const url = String((PKG.repository && PKG.repository.url) || PKG.repository || '');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (!m || /^YOUR-/i.test(m[1])) return null;
  return `${m[1]}/${m[2]}`;
}

// Paths through path.join, not as a string: 'C:\Riot Games' is "C:Riot Games" in JS
// (\R is not an escape) - it used to be written that way and the lockfile fallback quietly never worked.
const LOCKFILES = [
  path.join('C:', path.sep, 'Riot Games', 'League of Legends', 'lockfile'),
  path.join('D:', path.sep, 'Riot Games', 'League of Legends', 'lockfile'),
  path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'League of Legends', 'lockfile'),
];

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// Game images do not change between patches, but the LCU sends `no-cache` with them.
// Without overriding it the browser would revalidate them on every spin of the
// roulette - and that builds 58 tiles per reel.
const GAME_ASSETS = /^\/lol-game-data\/assets\//i;

let creds = null;          // { port, token, source }
let discovering = null;    // a discovery promise in flight (so it does not run five times in parallel)

// --- finding the credentials -------------------------------------------

function fromLockfile() {
  for (const file of LOCKFILES) {
    if (!file) continue;
    try {
      const parts = fs.readFileSync(file, 'utf8').trim().split(':');
      if (parts.length >= 4 && parts[2] && parts[3]) {
        return { port: Number(parts[2]), token: parts[3], source: file };
      }
    } catch (_) { /* not there, try the next one */ }
  }
  return null;
}

function fromProcessList() {
  return new Promise((resolve) => {
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine",
    ], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const port = /--app-port=\"?(\d+)\"?/.exec(stdout);
      const token = /--remoting-auth-token=\"?([\w-]+)\"?/.exec(stdout);
      if (port && token) {
        resolve({ port: Number(port[1]), token: token[1], source: 'LeagueClientUx.exe' });
      } else {
        resolve(null);
      }
    });
  });
}

/** Checks that the credentials really work (the client may have crashed since). */
function ping(c) {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: c.port, path: '/lol-summoner/v1/current-summoner',
      method: 'GET', agent,
      headers: { Authorization: basic(c) },
      timeout: 4000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function basic(c) {
  return 'Basic ' + Buffer.from('riot:' + c.token).toString('base64');
}

async function getCreds() {
  if (creds && await ping(creds)) return creds;
  creds = null;
  if (discovering) return discovering;

  discovering = (async () => {
    // the lockfile is cheap, the process scan reliable - try them in that order
    let found = fromLockfile();
    if (!found || !(await ping(found))) found = await fromProcessList();
    if (found && !(await ping(found))) found = null;
    creds = found;
    discovering = null;
    if (found) console.log(`[lcu] connected on port ${found.port} (${found.source})`);
    return found;
  })();

  return discovering;
}

// --- proxy --------------------------------------------------------------

function proxyToLcu(req, res, c) {
  const target = req.url.slice(4) || '/';   // cuts off "/lcu"
  const headers = { Authorization: basic(c), Accept: req.headers.accept || 'application/json' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  const upstream = https.request({
    host: '127.0.0.1', port: c.port, path: target, method: req.method, headers, agent,
  }, (up) => {
    const out = {};
    for (const h of ['content-type', 'content-length', 'etag']) {
      if (up.headers[h]) out[h] = up.headers[h];
    }
    out['cache-control'] = GAME_ASSETS.test(target)
      ? 'public, max-age=21600'
      : (up.headers['cache-control'] || 'no-store');
    res.writeHead(up.statusCode, out);
    up.pipe(res);
  });

  upstream.on('error', (err) => {
    creds = null;   // the next request will fetch new ones
    sendJson(res, 502, { error: 'lcu_unreachable', detail: err.message });
  });

  req.pipe(upstream);
}

// --- live updates -------------------------------------------------------

/**
 * The browser keeps an SSE channel open and the server tells it when the loot
 * changed. The change is found with a short request to the client every two
 * seconds.
 *
 * Why not a WebSocket on the LCU event stream: Node has no built-in WS client
 * and a hand-written RFC6455 (handshake, masking, frame parsing) would be by
 * far the most fragile piece of this project. A request to localhost costs
 * nothing and the result is the same for the user.
 */

const sseClients = new Set();
let pollTimer = null;
let lastFingerprint = null;
let lastConnected = null;

function lcuGetJson(path) {
  return new Promise((resolve, reject) => {
    getCreds().then((c) => {
      if (!c) return reject(new Error('client_not_running'));
      const req = https.request({
        host: '127.0.0.1', port: c.port, path, method: 'GET', agent,
        headers: { Authorization: basic(c), Accept: 'application/json' }, timeout: 6000,
      }, (up) => {
        let body = '';
        up.setEncoding('utf8');
        up.on('data', (d) => { body += d; });
        up.on('end', () => {
          if (up.statusCode >= 400) return reject(new Error('status ' + up.statusCode));
          try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    }, reject);
  });
}

/** A cheap fingerprint of the inventory - it is enough to know something changed. */
function fingerprint(loot) {
  return (loot || [])
    .filter((i) => i.lootId)
    .map((i) => i.lootId + ':' + i.count)
    .sort()
    .join('|');
}

function sseSend(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

async function pollOnce() {
  let loot = null;
  try { loot = await lcuGetJson('/lol-loot/v1/player-loot'); } catch (_) { /* the client is not running */ }

  const connected = Array.isArray(loot);
  if (connected !== lastConnected) {
    lastConnected = connected;
    sseSend('status', { connected });
  }
  if (!connected) { lastFingerprint = null; return; }

  const fp = fingerprint(loot);
  if (lastFingerprint !== null && fp !== lastFingerprint) sseSend('loot', { changed: true });
  lastFingerprint = fp;
}

function startPolling() {
  if (pollTimer || !sseClients.size) return;
  lastFingerprint = null;
  lastConnected = null;
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, 2000);
  pollOnce().catch(() => {});
}

function stopPollingIfIdle() {
  if (!sseClients.size && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/*
 * Without a console there is nothing to close. The exe therefore quits by
 * itself when no LootForge tab is open (each one holds an SSE connection):
 * IDLE_EXIT_MS after the last one closes, and START_GRACE_MS after startup in
 * case the browser never opened at all. Reloading the page only interrupts the
 * connection for a moment - that is what the grace period is for.
 * `node server.js` keeps running as before (LOOTFORGE_AUTO_EXIT=1 turns it on).
 */
const AUTO_EXIT = sea ? process.env.LOOTFORGE_STAY !== '1' : process.env.LOOTFORGE_AUTO_EXIT === '1';
const IDLE_EXIT_MS = Number(process.env.LOOTFORGE_IDLE_EXIT_MS) || 30000;
const START_GRACE_MS = Math.max(IDLE_EXIT_MS, 90000);
let idleTimer = null;

function scheduleIdleExit(ms) {
  if (!AUTO_EXIT) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sseClients.size) return;
    console.log('[app] no LootForge tab is open - quitting');
    process.exit(0);
  }, ms);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': pripojeno\n\n');

  sseClients.add(res);
  clearTimeout(idleTimer);
  startPolling();

  const beat = setInterval(() => { try { res.write(': .\n\n'); } catch (_) {} }, 20000);
  req.on('close', () => {
    clearInterval(beat);
    sseClients.delete(res);
    stopPollingIfIdle();
    if (!sseClients.size) scheduleIdleExit(IDLE_EXIT_MS);
  });
}

// --- Mythic Shop ----------------------------------------------------------

/*
 * The Mythic Shop is not in the loot recipes - it lives in Riot's newer store
 * system (lol-shoppefront) as MYTHIC_SHOPPE_* stores (featured, biweekly,
 * weekly and daily rotations). The entries have no images there, only a
 * contentId, which is matched against game data (skins, chromas, icons, emotes).
 *
 * The stores are ~1 MB and the game data ~8.5 MB. Only a small summary goes to
 * the browser and the game data stays in the server's memory until the client
 * restarts (a different port).
 */

let shopIndex = null;   // { port, byContent: Map }

async function gameIndex(port) {
  if (shopIndex && shopIndex.port === port) return shopIndex.byContent;

  const [skins, icons, emotes, champions, wards, finishers] = await Promise.all([
    lcuGetJson('/lol-game-data/assets/v1/skins.json'),
    lcuGetJson('/lol-game-data/assets/v1/summoner-icons.json'),
    lcuGetJson('/lol-game-data/assets/v1/summoner-emotes.json'),
    lcuGetJson('/lol-game-data/assets/v1/champion-summary.json'),
    lcuGetJson('/lol-game-data/assets/v1/ward-skins.json').catch(() => []),
    lcuGetJson('/lol-game-data/assets/v1/nexusfinishers.json').catch(() => []),
  ]);

  const byContent = new Map();
  const skinById = new Map();
  const championNames = {};
  const add = (cid, value) => { if (cid) byContent.set(String(cid).toLowerCase(), value); };

  // for the collection: a name and an image for every id from the inventory
  const meta = { chroma: new Map(), icon: new Map(), emote: new Map(), ward: new Map(), finisher: new Map() };

  for (const ch of champions || []) if (ch.id > 0 && ch.id < 1000) championNames[ch.id] = ch.name;   // without Jade (60001+)

  for (const sk of Object.values(skins || {})) {
    // uncentered = the whole original splash art (1215x717). "splashPath" is the
    // zoomed one with a blurred background and "tilePath" only a square crop.
    skinById.set(sk.id, {
      id: sk.id,
      name: sk.isBase ? championNames[Math.floor(sk.id / 1000)] || sk.name : sk.name,
      championId: Math.floor(sk.id / 1000),
      rarity: SKIN_RARITY[sk.rarity] || 'DEFAULT',
      splash: sk.uncenteredSplashPath || sk.splashPath || '',
      tile: sk.tilePath || '',
      isBase: !!sk.isBase,
    });
    add(sk.contentId, {
      kind: 'skin', img: sk.tilePath || sk.splashPath || '',
      rarity: SKIN_RARITY[sk.rarity] || 'DEFAULT',
      splash: sk.uncenteredSplashPath || '',   // the full artwork for the ceremony after a purchase
      skinId: sk.id,                           // so the shop can open a preview
    });
    for (const ch of sk.chromas || []) {
      // for a chroma the skin it belongs to is the key part: without it the chroma is useless
      add(ch.contentId, {
        kind: 'chroma', img: ch.chromaPath || ch.tilePath || '', rarity: 'DEFAULT',
        chromaId: ch.id, skinId: sk.id,
        skinName: sk.isBase ? (championNames[Math.floor(sk.id / 1000)] || sk.name) : sk.name,
      });
      meta.chroma.set(ch.id, {
        name: ch.name, img: ch.chromaPath || ch.tilePath || '', skinId: sk.id,
        colors: (ch.colors || []).filter((x) => /^#[0-9a-f]{3,8}$/i.test(x)),
      });
    }
  }
  for (const ic of icons || []) {
    add(ic.contentId, { kind: 'icon', img: ic.imagePath || '', rarity: 'DEFAULT' });
    meta.icon.set(ic.id, { name: ic.title || `Ikona ${ic.id}`, img: ic.imagePath || '' });
  }
  for (const em of emotes || []) {
    add(em.contentId, { kind: 'emote', img: em.inventoryIcon || '', rarity: 'DEFAULT' });
    // a few emotes have no image ("/lol-game-data/assets/") - better none than a 404
    if (em.name) meta.emote.set(em.id, { name: em.name, img: /\.(png|jpe?g)$/i.test(em.inventoryIcon || '') ? em.inventoryIcon : '' });
  }
  for (const w of wards || []) meta.ward.set(w.id, { name: w.name, img: w.wardImagePath || '' });
  for (const f of finishers || []) meta.finisher.set(f.itemId, { name: f.translatedName || f.name, img: f.iconPath || '', splash: f.splashPath || '' });

  shopIndex = { port, byContent, skinById, championNames, meta };
  return byContent;
}

const SKIN_RARITY = {
  kNoRarity: 'DEFAULT', kRare: 'DEFAULT', kEpic: 'EPIC', kLegendary: 'LEGENDARY',
  kMythic: 'MYTHIC', kUltimate: 'ULTIMATE', kTranscendent: 'TRANSCENDENT', kExalted: 'EXALTED',
};

// the order and the label of each rotation; a store is recognised by its name
const SHOP_ROTATIONS = [
  [/FEATURED/i, 'Featured'],
  [/BIWEEKLY/i, 'Biweekly rotation'],
  [/WEEKLY/i, 'Weekly rotation'],
  [/DAILY/i, 'Daily rotation'],
];

function rotationOf(storeName) {
  const i = SHOP_ROTATIONS.findIndex(([re]) => re.test(storeName));
  return i === -1 ? { order: 99, label: storeName } : { order: i, label: SHOP_ROTATIONS[i][1] };
}

async function mythicShop(creds) {
  const [raw, index] = await Promise.all([lcuGetJson('/lol-shoppefront/v1/stores'), gameIndex(creds.port)]);
  const now = Date.now();

  const stores = ((raw && raw.data) || [])
    .filter((st) => /^MYTHIC_SHOPPE/.test(st.name || ''))
    .filter((st) => !st.endTime || Date.parse(st.endTime) > now)
    .filter((st) => !st.startTime || Date.parse(st.startTime) <= now)
    .map((st) => {
      const rot = rotationOf(st.name);
      const entries = (st.catalogEntries || []).map((e) => {
        const unit = (e.purchaseUnits || [])[0] || {};
        const f = unit.fulfillment || {};
        // Mythic Essence payments only - other currencies are out of scope here
        const option = (unit.paymentOptions || []).find((o) =>
          (o.payments || []).some((pay) => pay.name === 'lol_mythic_essence'));
        if (!option) return null;
        const pay = option.payments.find((x) => x.name === 'lol_mythic_essence');
        const meta = index.get(String(f.itemId || '').toLowerCase()) || { kind: 'other', img: '', rarity: 'DEFAULT' };
        return {
          storeId: st.id,
          catalogEntryId: e.id,
          name: f.name || 'Unknown item',
          kind: meta.kind,
          img: meta.img,
          ...(meta.splash ? { splash: meta.splash } : {}),
          ...(meta.skinId ? { skinId: meta.skinId } : {}),
          ...(meta.chromaId ? { chromaId: meta.chromaId } : {}),
          ...(meta.skinName ? { skinName: meta.skinName } : {}),
          rarity: meta.rarity,
          price: pay.finalDelta != null ? pay.finalDelta : pay.delta,
          paymentKey: option.key,
          owned: (f.ownedQuantity || 0) >= (f.maxQuantity || 1),
        };
      }).filter(Boolean);
      return { id: st.id, name: st.name, label: rot.label, order: rot.order, endTime: st.endTime, entries };
    })
    .filter((st) => st.entries.length)
    .sort((a, b) => a.order - b.order);

  return { stores };
}

// --- owned skins ----------------------------------------------------------

/*
 * Which skins the player owns, grouped by champion. The source is
 * /lol-champions/v1/inventories/{summonerId}/skins-minimal (~1.7 MB, every skin
 * in the game with ownership). Checked against the client's inventory: no
 * chromas, no rentals, loyalty or Xbox skins. The base skin does not count.
 *
 * Ownership is not cached (a reroll, an unlock or a purchase changes it), only
 * the summonerId and the rarities from game data are.
 */

let summonerCache = null;   // { port, id }

async function ownedSkins(creds) {
  if (!summonerCache || summonerCache.port !== creds.port) {
    const me = await lcuGetJson('/lol-summoner/v1/current-summoner');
    summonerCache = { port: creds.port, id: me.summonerId };
  }
  await gameIndex(creds.port);   // for the rarities
  const all = await lcuGetJson(`/lol-champions/v1/inventories/${summonerCache.id}/skins-minimal`);

  const rank = ['DEFAULT', 'EPIC', 'LEGENDARY', 'MYTHIC', 'ULTIMATE', 'TRANSCENDENT', 'EXALTED'];
  const byChampion = {};
  let total = 0;
  for (const sk of all || []) {
    const o = sk.ownership || {};
    const rental = o.rental || {};
    if (!o.owned || sk.isBase || rental.rented || o.loyaltyReward || o.xboxGPReward) continue;
    // The "Jade" versions (project_jade, champions Jade_Annie with id 60001+) come
    // from another Riot product with a shared inventory - mostly duplicates of the
    // normal skins. League champions have ids below 1000.
    if (sk.championId >= 1000) continue;
    const art = shopIndex.skinById.get(sk.id);
    (byChampion[sk.championId] = byChampion[sk.championId] || []).push({
      id: sk.id,
      name: sk.name,
      img: sk.tilePath || sk.splashPath || '',
      splash: (art && art.splash) || sk.splashPath || '',
      rarity: (art && art.rarity) || 'DEFAULT',
    });
    total++;
  }
  for (const list of Object.values(byChampion)) {
    list.sort((a, b) => (rank.indexOf(b.rarity) - rank.indexOf(a.rarity)) || a.name.localeCompare(b.name));
  }
  return { total, byChampion, champions: shopIndex.championNames };
}

// --- collection -----------------------------------------------------------

/*
 * Everything the player owns: champions, skins, chromas, icons, emotes, wards
 * and Nexus Finishers. The source is the client's inventory
 * (/lol-inventory/v2/inventory/{type}), the names and images come from game
 * data. Only what is really owned counts (owned + ownershipType OWNED): no F2P
 * rotation, no loyalty rewards, no rentals. Skins and chromas share the single
 * CHAMPION_SKIN type in the inventory - only game data tells them apart. Jade
 * (champions 1000+) is left out as everywhere else.
 */

const COLLECTION_TYPES = ['CHAMPION', 'CHAMPION_SKIN', 'SUMMONER_ICON', 'EMOTE', 'WARD_SKIN', 'NEXUS_FINISHER'];

/** "20241215T162409.000Z" -> ms; an empty date -> 0 */
function inventoryDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

async function collection(creds) {
  await gameIndex(creds.port);
  const { skinById, championNames, meta } = shopIndex;
  const inv = await Promise.all(COLLECTION_TYPES.map((t) => lcuGetJson('/lol-inventory/v2/inventory/' + t)));
  const owned = (list) => (list || []).filter((i) => i.owned && i.ownershipType === 'OWNED' && !i.rental);
  const [champs, skinsAndChromas, icons, emotes, wards, finishers] = inv.map(owned);

  const out = { champions: [], skins: [], chromas: [], icons: [], emotes: [], wards: [], finishers: [] };
  const skinCount = {};

  for (const i of skinsAndChromas) {
    const at = inventoryDate(i.purchaseDate);
    const sk = skinById.get(i.itemId);
    if (sk) {
      if (sk.isBase || sk.championId >= 1000) continue;
      skinCount[sk.championId] = (skinCount[sk.championId] || 0) + 1;
      out.skins.push({ id: sk.id, name: sk.name, img: sk.tile, splash: sk.splash, rarity: sk.rarity, championId: sk.championId, at });
      continue;
    }
    const ch = meta.chroma.get(i.itemId);
    if (!ch || Math.floor(ch.skinId / 1000) >= 1000) continue;
    const parent = skinById.get(ch.skinId);
    out.chromas.push({ id: i.itemId, name: ch.name, img: ch.img, colors: ch.colors, skinId: ch.skinId,
      skinName: parent ? parent.name : '', championId: Math.floor(ch.skinId / 1000), at });
  }
  for (const i of champs) {
    if (!championNames[i.itemId]) continue;
    out.champions.push({ id: i.itemId, name: championNames[i.itemId], img: `/lol-game-data/assets/v1/champion-icons/${i.itemId}.png`,
      at: inventoryDate(i.purchaseDate) });
  }
  const simple = (list, map, kind) => {
    for (const i of list) {
      const m = map.get(i.itemId);
      if (m) out[kind].push({ id: i.itemId, name: m.name, img: m.img, ...(m.splash ? { splash: m.splash } : {}), at: inventoryDate(i.purchaseDate) });
    }
  };
  simple(icons, meta.icon, 'icons');
  simple(emotes, meta.emote, 'emotes');
  simple(wards.filter((i) => i.itemId !== 0), meta.ward, 'wards');   // 0 = the default ward
  simple(finishers, meta.finisher, 'finishers');
  for (const c of out.champions) c.skins = skinCount[c.id] || 0;

  // how much of it there is in the game - for the collection percentages
  let skinTotal = 0;
  let chromaTotal = 0;
  for (const sk of skinById.values()) if (!sk.isBase && sk.championId < 1000) skinTotal++;
  for (const ch of meta.chroma.values()) if (Math.floor(ch.skinId / 1000) < 1000) chromaTotal++;
  const totals = {
    champions: Object.keys(championNames).length, skins: skinTotal, chromas: chromaTotal,
    icons: meta.icon.size, emotes: meta.emote.size, wards: Math.max(0, meta.ward.size - 1), finishers: meta.finisher.size,
  };

  for (const list of Object.values(out)) list.sort((a, b) => b.at - a.at);
  return { totals, ...out, championNames };
}

// --- the guard ------------------------------------------------------------

/*
 * The server listens on 127.0.0.1 only, but that is not enough: any page open
 * in the browser can send a request to localhost. A POST with Content-Type
 * text/plain is a "simple request" for the browser - it goes through without a
 * CORS preflight - and the proxy would dutifully pass it to the client. A
 * foreign site could disenchant loot blindly that way.
 *
 *  - the Host must be our address -> stops DNS rebinding (a foreign domain pointed at 127.0.0.1)
 *  - writes only from our page     -> browsers always send Origin on a POST, and a foreign site cannot forge it
 *  - writes only as JSON           -> JSON forces a preflight, so a simple request no longer gets through
 */

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

function guard(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    sendJson(res, 403, { error: 'forbidden_host' });
    return false;
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;

  if (!ALLOWED_ORIGINS.has(String(req.headers.origin || ''))) {
    sendJson(res, 403, { error: 'forbidden_origin' });
    return false;
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    sendJson(res, 415, { error: 'json_required' });
    return false;
  }
  return true;
}

// --- static files ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel));
  // with the separator: startsWith(PUBLIC_DIR) alone would also allow a "public-anything" folder
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  let data;
  try {
    // only after the path check; an asset key in the exe, a file on disk otherwise
    data = readAppFile(path.relative(__dirname, file).split(path.sep).join('/'));
  } catch (_) {
    return sendJson(res, 404, { error: 'not_found', path: rel });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// --- the server -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (!guard(req, res)) return;

  if (req.url === '/api/status') {
    const c = await getCreds();
    const app = { version: VERSION, repo: releaseRepo() };
    return sendJson(res, 200, c ? { connected: true, port: c.port, source: c.source, app } : { connected: false, app });
  }

  if (req.url === '/api/events') return handleEvents(req, res);

  // the licence inside the exe too, where no file sits next to it - the app's footer links to it
  if (req.url === '/LICENSE') {
    const body = readAppFile('LICENSE');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }

  // details of a single skin (a base one = the champion): full splash, name, rarity
  const skinMatch = /^\/api\/skin\/(\d{1,7})$/.exec(req.url);
  if (skinMatch) {
    const c = await getCreds();
    if (!c) return sendJson(res, 503, { error: 'client_not_running' });
    try {
      await gameIndex(c.port);
      const art = shopIndex.skinById.get(Number(skinMatch[1]));
      if (!art) return sendJson(res, 404, { error: 'unknown_skin' });
      return sendJson(res, 200, { ...art, championName: shopIndex.championNames[art.championId] || '' });
    } catch (err) {
      return sendJson(res, 502, { error: 'skin_unavailable', detail: err.message });
    }
  }

  if (req.url === '/api/owned-skins') {
    const c = await getCreds();
    if (!c) return sendJson(res, 503, { error: 'client_not_running' });
    try {
      return sendJson(res, 200, await ownedSkins(c));
    } catch (err) {
      return sendJson(res, 502, { error: 'skins_unavailable', detail: err.message });
    }
  }

  if (req.url === '/api/collection') {
    const c = await getCreds();
    if (!c) return sendJson(res, 503, { error: 'client_not_running' });
    try {
      return sendJson(res, 200, await collection(c));
    } catch (err) {
      return sendJson(res, 502, { error: 'collection_unavailable', detail: err.message });
    }
  }

  if (req.url === '/api/mythic-shop') {
    const c = await getCreds();
    if (!c) return sendJson(res, 503, { error: 'client_not_running' });
    try {
      return sendJson(res, 200, await mythicShop(c));
    } catch (err) {
      return sendJson(res, 502, { error: 'shop_unavailable', detail: err.message });
    }
  }

  if (req.url.startsWith('/lcu/')) {
    const c = await getCreds();
    if (!c) return sendJson(res, 503, { error: 'client_not_running' });
    return proxyToLcu(req, res, c);
  }

  serveStatic(req, res);
});

/** Opens the app in the default browser - only when the launcher asked for it (OPEN_BROWSER=1). */
function openBrowser() {
  // the exe is started by a double click, so it opens the browser itself (OPEN_BROWSER=0 turns that off)
  const wanted = process.env.OPEN_BROWSER === undefined ? !!sea : process.env.OPEN_BROWSER === '1';
  if (!wanted) return;
  const url = `http://127.0.0.1:${PORT}`;
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* the address is printed in the console */ }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} is already in use - LootForge is probably already running.`);
    console.error(`  Opening http://127.0.0.1:${PORT} instead. To run a second copy, use another port:`);
    console.error(sea ? `      set PORT=${PORT + 1} && LootForge.exe` : `      set PORT=${PORT + 1} && node server.js`);
    console.error('');
    openBrowser();
  } else {
    console.error('');
    console.error('  Could not start the server:', err.message);
    console.error('');
  }
  // a moment for the browser to open and the log to be written
  setTimeout(() => process.exit(1), sea ? 1500 : 300);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  LOOTFORGE v${VERSION}`);
  console.log(`  -> http://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  Keep the League client running and open the address above in your browser.');
  console.log(sea ? '  LootForge quits by itself shortly after you close its browser tab.' : '  Press Ctrl+C to quit.');
  console.log('');
  openBrowser();
  scheduleIdleExit(START_GRACE_MS);
  getCreds().then((c) => {
    if (!c) console.log('[lcu] League client not found yet - LootForge connects as soon as you start it');
  });
});
