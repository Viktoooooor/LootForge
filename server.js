#!/usr/bin/env node
'use strict';

/**
 * Hextech Gamba - lokalni most mezi prohlizecem a League klientem (LCU).
 *
 * Prohlizec se k LCU nedostane sam: bezi na nahodnem portu, ma self-signed
 * certifikat a chce Basic auth s tokenem, ktery zna jen bezici klient.
 * Tenhle server credentials najde, drzi je u sebe a proxuje /lcu/* dal.
 *
 * Zadne zavislosti. `node server.js` a hotovo.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4545;
const PUBLIC_DIR = path.join(__dirname, 'public');

const LOCKFILES = [
  'C:\Riot Games\League of Legends\lockfile',
  'D:\Riot Games\League of Legends\lockfile',
  path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'League of Legends', 'lockfile'),
];

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// Obrazky ze hry se mezi patchi nemeni, ale LCU u nich posila `no-cache`.
// Bez prepsani by je prohlizec revalidoval pri kazdem roztoceni rulety -
// a ta stavi 58 dlazdic na pas.
const GAME_ASSETS = /^\/lol-game-data\/assets\//i;

let creds = null;          // { port, token, source }
let discovering = null;    // rozpracovany discovery slib (aby nebezel 5x paralelne)

// --- hledani credentials -----------------------------------------------

function fromLockfile() {
  for (const file of LOCKFILES) {
    if (!file) continue;
    try {
      const parts = fs.readFileSync(file, 'utf8').trim().split(':');
      if (parts.length >= 4 && parts[2] && parts[3]) {
        return { port: Number(parts[2]), token: parts[3], source: file };
      }
    } catch (_) { /* neni tam, zkousime dal */ }
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

/** Overi, ze credentials fakt fungujou (klient mohl mezitim spadnout). */
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
    // lockfile je levny, process scan spolehlivy - zkusime v tomhle poradi
    let found = fromLockfile();
    if (!found || !(await ping(found))) found = await fromProcessList();
    if (found && !(await ping(found))) found = null;
    creds = found;
    discovering = null;
    if (found) console.log(`[lcu] pripojeno na port ${found.port} (${found.source})`);
    return found;
  })();

  return discovering;
}

// --- proxy --------------------------------------------------------------

function proxyToLcu(req, res, c) {
  const target = req.url.slice(4) || '/';   // odrizne "/lcu"
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
    creds = null;   // pristi request si sahne pro nove
    sendJson(res, 502, { error: 'lcu_unreachable', detail: err.message });
  });

  req.pipe(upstream);
}

// --- zive aktualizace ---------------------------------------------------

/**
 * Prohlizec drzi otevreny SSE kanal a server mu hlasi, kdyz se loot zmenil.
 * Zmenu zjistujeme kratkym dotazem na klienta kazde dve vteriny.
 *
 * Proc ne WebSocket na LCU event stream: Node nema vestaveneho WS klienta a
 * rucne psany RFC6455 (handshake, maskovani, parsovani ramcu) by byl zdaleka
 * nejkrehcejsi kus tohohle projektu. Dotaz na localhost stoji nic a vysledek
 * je pro uzivatele stejny.
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

/** Levny otisk inventare - staci vedet, ze se neco zmenilo. */
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
  try { loot = await lcuGetJson('/lol-loot/v1/player-loot'); } catch (_) { /* klient nebezi */ }

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

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': pripojeno\n\n');

  sseClients.add(res);
  startPolling();

  const beat = setInterval(() => { try { res.write(': .\n\n'); } catch (_) {} }, 20000);
  req.on('close', () => {
    clearInterval(beat);
    sseClients.delete(res);
    stopPollingIfIdle();
  });
}

// --- mythic shop ----------------------------------------------------------

/*
 * Mythic shop neni v loot receptech - bydli v novem obchodnim systemu Riotu
 * (lol-shoppefront) jako obchody MYTHIC_SHOPPE_* (featured, dvoutydenni,
 * tydenni a denni rotace). Polozky tam nemaji obrazky, jen contentId, ktere
 * se paruje na herni data (skiny, chromy, ikony, emoty).
 *
 * Obchody maji ~1 MB a herni data ~8,5 MB. Do prohlizece jde jen maly prehled
 * a herni data se drzi v pameti, dokud se klient nerestartuje (jiny port).
 */

let shopIndex = null;   // { port, byContent: Map }

async function gameIndex(port) {
  if (shopIndex && shopIndex.port === port) return shopIndex.byContent;

  const [skins, icons, emotes, champions] = await Promise.all([
    lcuGetJson('/lol-game-data/assets/v1/skins.json'),
    lcuGetJson('/lol-game-data/assets/v1/summoner-icons.json'),
    lcuGetJson('/lol-game-data/assets/v1/summoner-emotes.json'),
    lcuGetJson('/lol-game-data/assets/v1/champion-summary.json'),
  ]);

  const byContent = new Map();
  const skinById = new Map();
  const championNames = {};
  const add = (cid, value) => { if (cid) byContent.set(String(cid).toLowerCase(), value); };

  for (const ch of champions || []) if (ch.id > 0 && ch.id < 1000) championNames[ch.id] = ch.name;   // bez Jade (60001+)

  for (const sk of Object.values(skins || {})) {
    // uncentered = cely originalni splash art (1215x717). "splashPath" je
    // priblizeny s rozmazanym pozadim a "tilePath" jen ctvercovy vyrez.
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
    });
    for (const ch of sk.chromas || []) {
      add(ch.contentId, { kind: 'chroma', img: ch.chromaPath || ch.tilePath || '', rarity: 'DEFAULT' });
    }
  }
  for (const ic of icons || []) add(ic.contentId, { kind: 'icon', img: ic.imagePath || '', rarity: 'DEFAULT' });
  for (const em of emotes || []) add(em.contentId, { kind: 'emote', img: em.inventoryIcon || '', rarity: 'DEFAULT' });

  shopIndex = { port, byContent, skinById, championNames };
  return byContent;
}

const SKIN_RARITY = {
  kNoRarity: 'DEFAULT', kRare: 'DEFAULT', kEpic: 'EPIC', kLegendary: 'LEGENDARY',
  kMythic: 'MYTHIC', kUltimate: 'ULTIMATE', kTranscendent: 'TRANSCENDENT', kExalted: 'EXALTED',
};

// poradi a cesky popisek rotaci; obchod se pozna podle nazvu
const SHOP_ROTATIONS = [
  [/FEATURED/i, 'Featured'],
  [/BIWEEKLY/i, 'Dvoutydenni rotace'],
  [/WEEKLY/i, 'Tydenni rotace'],
  [/DAILY/i, 'Denni rotace'],
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
        // jen platba mythic esenci - jine meny tu neresime
        const option = (unit.paymentOptions || []).find((o) =>
          (o.payments || []).some((pay) => pay.name === 'lol_mythic_essence'));
        if (!option) return null;
        const pay = option.payments.find((x) => x.name === 'lol_mythic_essence');
        const meta = index.get(String(f.itemId || '').toLowerCase()) || { kind: 'other', img: '', rarity: 'DEFAULT' };
        return {
          storeId: st.id,
          catalogEntryId: e.id,
          name: f.name || 'Neznama polozka',
          kind: meta.kind,
          img: meta.img,
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

// --- vlastnene skiny ------------------------------------------------------

/*
 * Ktere skiny hrac vlastni, seskupene podle sampiona. Zdroj je
 * /lol-champions/v1/inventories/{summonerId}/skins-minimal (~1,7 MB, vsechny
 * skiny hry s vlastnictvim). Overeno proti inventari klienta: bez chrom, bez
 * pujcenych, vernostnich i Xbox skinu. Zakladni skin se nepocita.
 *
 * Vlastnictvi se necachuje (meni se rerollem, odemknutim, nakupem), jen
 * summonerId a rarity z hernich dat.
 */

let summonerCache = null;   // { port, id }

async function ownedSkins(creds) {
  if (!summonerCache || summonerCache.port !== creds.port) {
    const me = await lcuGetJson('/lol-summoner/v1/current-summoner');
    summonerCache = { port: creds.port, id: me.summonerId };
  }
  await gameIndex(creds.port);   // kvuli raritam
  const all = await lcuGetJson(`/lol-champions/v1/inventories/${summonerCache.id}/skins-minimal`);

  const rank = ['DEFAULT', 'EPIC', 'LEGENDARY', 'MYTHIC', 'ULTIMATE', 'TRANSCENDENT', 'EXALTED'];
  const byChampion = {};
  let total = 0;
  for (const sk of all || []) {
    const o = sk.ownership || {};
    const rental = o.rental || {};
    if (!o.owned || sk.isBase || rental.rented || o.loyaltyReward || o.xboxGPReward) continue;
    // "Jade" verze (project_jade, sampioni Jade_Annie s id 60001+) jsou z jineho
    // produktu Riotu sdileneho inventare - vetsinou duplikaty normalnich skinu.
    // Sampioni League maji id pod 1000.
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

// --- video prohlidka skinu (YouTube, kanal SkinSpotlights) --------------------

/*
 * SkinSpotlights natoci detailni prohlidku prakticky kazdeho skinu. Bez API
 * klice YouTube vyhledavani nenabizi, takze se cte verejna stranka s vysledky
 * (ytInitialData). Jen na vyslovne kliknuti, s cache. Kdyz YouTube stranku
 * zmeni, vrati se videoId: null a appka nabidne odkaz na hledani.
 */

const SPOTLIGHT_CHANNEL = 'UC0NwzCHb8Fg89eTB5eYX17Q';   // SkinSpotlights (id kanalu, ne jmeno)
const spotlightCache = new Map();

function normalizeTitle(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

function httpsGetText(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300) {
        res.resume();
        const to = res.headers.location ? ' -> ' + String(res.headers.location).split('?')[0] : '';
        return reject(new Error('youtube ' + res.statusCode + to));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('youtube timeout')); });
  });
}

async function findSpotlight(skinName) {
  const key = normalizeTitle(skinName);
  if (spotlightCache.has(key)) return spotlightCache.get(key);

  const query = `SkinSpotlights ${skinName} skin spotlight`;
  const html = await httpsGetText('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: 'SOCS=CAI; CONSENT=YES+cb',   // v EU jinak presmeruje na stranku se souhlasem
  });

  const videos = [];
  const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (m) {
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.videoRenderer) {
        const v = o.videoRenderer;
        const owner = (v.ownerText && v.ownerText.runs && v.ownerText.runs[0]) || {};
        videos.push({
          id: v.videoId,
          title: ((v.title && v.title.runs) || []).map((r) => r.text).join(''),
          channelId: owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint
            ? owner.navigationEndpoint.browseEndpoint.browseId : '',
        });
      }
      for (const k of Object.keys(o)) walk(o[k]);
    })(JSON.parse(m[1]));
  }

  // Stranka bez jedineho videa neni "video neexistuje", ale rozbita odpoved
  // (omezeni pri vice dotazech za sebou, zmena stranky). Nesmi se zapamatovat.
  if (!videos.length) throw new Error('youtube vratil stranku bez vysledku');

  const pick = pickSpotlight(videos, skinName);
  if (!pick) return { videoId: null };   // neuspech necachovat - pristi klik to zkusi znovu
  const result = { videoId: pick.id, title: pick.title };
  spotlightCache.set(key, result);
  return result;
}

// --- straz ---------------------------------------------------------------

/*
 * Server posloucha jen na 127.0.0.1, ale to nestaci: kazda stranka otevrena
 * v prohlizeci muze na localhost poslat request. POST s Content-Type text/plain
 * je pro prohlizec "simple request" - projde bez CORS preflightu - a proxy by
 * ho poslusne predala klientovi. Cizi web by tak mohl naslepo rozkladat loot.
 *
 *  - Host musi byt nase adresa   -> brani DNS rebindingu (cizi domena presmerovana na 127.0.0.1)
 *  - zapis jen z nasi stranky    -> prohlizec u POST vzdy posle Origin, cizi web ho nepodvrhne
 *  - zapis jen jako JSON         -> JSON vynuti preflight, simple request uz neprojde
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

// --- staticke soubory ---------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel));
  // s oddelovacem: samotne startsWith(PUBLIC_DIR) by pustilo i slozku "public-cokoliv"
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not_found', path: rel });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// --- server -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (!guard(req, res)) return;

  if (req.url === '/api/status') {
    const c = await getCreds();
    return sendJson(res, 200, c ? { connected: true, port: c.port, source: c.source } : { connected: false });
  }

  if (req.url === '/api/events') return handleEvents(req, res);

  // detail jednoho skinu (i zakladniho = sampion): cely splash, jmeno, rarita
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

  if (req.url.startsWith('/api/spotlight?')) {
    const name = String(new URL(req.url, 'http://x').searchParams.get('name') || '').trim().slice(0, 80);
    const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`SkinSpotlights ${name}`);
    if (!name) return sendJson(res, 400, { error: 'name_required' });
    try {
      return sendJson(res, 200, { ...(await findSpotlight(name)), searchUrl });
    } catch (err) {
      // bez internetu nebo YouTube nedostupny - appka nabidne aspon odkaz
      return sendJson(res, 200, { videoId: null, searchUrl, detail: err.message });
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  Port ${PORT} uz nekdo zabral - nejspis druha instance appky.`);
    console.error('  Zavri ji, nebo spust appku na jinem portu:');
    console.error(`      set PORT=${PORT + 1} && node server.js`);
    console.error('');
  } else {
    console.error('');
    console.error('  Server se nepodarilo spustit:', err.message);
    console.error('');
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  HEXTECH GAMBA');
  console.log(`  -> http://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  Nech bezet League klienta a otevri adresu vyse v prohlizeci.');
  console.log('  Ukoncis Ctrl+C.');
  console.log('');
  getCreds().then((c) => {
    if (!c) console.log('[lcu] klient zatim nebezi - pripojim se, az ho spustis');
  });
});
