'use strict';

/*
 * The animations without a browser: the order of the phases, timing, skipping,
 * fast mode, the randomness of the filler and the rule that the result is never
 * given away early. Needs neither the client nor the server.
 */

const { createEnv, suite, sleep } = require('./harness');

const t = suite('animace');
const env = createEnv();
env.load(['reel.js']);
const Reel = globalThis.Reel;

const drop = (name, rarity) => ({ name, img: `/lcu/${name}.jpg`, rarity: rarity || 'DEFAULT', count: 1 });
const filler = Array.from({ length: 50 }, (_, i) => drop('Vypln' + i, i % 5 ? 'DEFAULT' : 'EPIC'));
const phases = (prefix) => env.log.filter((x) => x.startsWith('+' + prefix)).map((x) => x.slice(1 + prefix.length));
const kids = (node, cls) => node.children.filter((c) => String(c.className).split(/\s+/).includes(cls));
const timed = async (fn) => { const t0 = Date.now(); await fn(); return Date.now() - t0; };

(async () => {
  // ---------------------------------------------------------------- roulette
  t.section('ruleta');
  let host = env.el();
  env.log.length = 0;
  let ms = await timed(() => Reel.play(drop('Lux', 'ULTIMATE'), filler, host));
  let stage = host.children[0];
  let rows = kids(stage, 'reel-row');
  const strip = rows[0]._q['.reel-strip'];
  t.ok(rows.length === 1, 'jeden pas');
  t.ok((strip.innerHTML.match(/class="reel-tile /g) || []).length === 58, '58 dlazdic');
  t.ok((strip.innerHTML.match(/is-winner/g) || []).length === 1, 'prave jedna vyherni');
  t.ok(ms > 4500 && ms < 7500, `plna delka ${ms} ms`);
  const seq = env.log.filter((x) => /is-(charging|spinning|closing|done)|landed/.test(x) && x.startsWith('+'));
  t.ok(seq.join(',').startsWith('+is-charging,+is-spinning,+is-closing'), `faze: ${[...new Set(seq)].join(' > ')}`);
  t.ok(strip.style.filter === 'none', 'rozmazani po dojezdu vynulovane');
  t.ok((strip.innerHTML.match(/class="rface /g) || []).length === 58, 'vsech 58 dlazdic ukazuje nejdriv jen raritu');
  t.ok((strip.innerHTML.match(/class="tile-item"/g) || []).length === 1, 'skutecny predmet je schovany jen pod vyherni dlazdici');
  t.ok(/rarity-gem-icons\/ultimate\.png/.test(strip.innerHTML), 'rarita se ukazuje oficialnim drahokamem z klienta');
  const landedAt = env.log.indexOf('+landed');
  const unveiledAt = env.log.indexOf('+is-unveiled');
  t.ok(landedAt > -1 && unveiledAt > landedAt, 'odhaleni prijde az po dojezdu');

  // ------------------------------------------------------- five reels + filler
  t.section('pet pasu a vypln');
  host = env.el();
  env.mem['lootforge.fast'] = '1';
  env.log.length = 0;
  const multi = Reel.playMulti([1, 2, 3, 4, 5].map((i) => drop('Vyhra' + i, i === 3 ? 'ULTIMATE' : 'EPIC')), filler, host);
  // the scene's glow must not give away the best drop until every reel has landed
  const multiStage = host.children[0];
  const leaked = new Set();
  let watching = true;
  (function watch() {
    if (!watching) return;
    const rs = kids(multiStage, 'reel-row');
    if (rs.length && !rs.every((r) => r._q['.reel-window'].classList.contains('is-done'))) leaked.add(multiStage._vars['--win']);
    setTimeout(watch, 10);
  })();
  await multi;
  watching = false;
  t.ok(leaked.size === 1 && leaked.has('var(--gold)'), `behem jizdy je zare zlata, ne barva vyhry (${[...leaked].join(', ')})`);
  t.ok(/ultimate/.test(multiStage._vars['--win']), 'po dojezdu se barva nejlepsiho dropu ukaze');
  t.ok(env.log.filter((x) => x === '+is-unveiled').length === 5, 'vsech pet vyher se odkryje');
  rows = kids(host.children[0], 'reel-row');
  t.ok(rows.length === 5, 'pet pasu');
  const seqs = rows.map((r) => (r._q['.reel-strip'].innerHTML.match(/<img src="([^"]+)"/g) || []));
  let same = 0;
  for (let i = 0; i < seqs.length; i++) for (let j = i + 1; j < seqs.length; j++) if (seqs[i].join() === seqs[j].join()) same++;
  t.ok(same === 0, 'zadne dva pasy nemaji stejnou vypln (driv i % delka = vsechny stejne)');
  let neighbours = 0;
  for (const s of seqs) for (let k = 1; k < s.length; k++) if (s[k] === s[k - 1]) neighbours++;
  t.ok(neighbours === 0, 'nikde dva stejne obrazky vedle sebe');

  const rowH = parseInt(rows[0]._vars['--rh'], 10);
  const total = rowH * 5 + 4 * 14 + Math.min(260, Math.min(937 * 0.9, 900) * 0.34);
  t.ok(total <= Math.round(937 * 0.9), `pet pasu se vejde do okna 937 px (${total} <= ${Math.round(937 * 0.9)})`);

  // ----------------------------------------------------------------- cascade
  t.section('kaskada');
  host = env.el();
  const many = Array.from({ length: 12 }, (_, i) => drop('Vec' + i, i === 7 ? 'MYTHIC' : (i % 5 ? 'DEFAULT' : 'EPIC')));
  await Reel.cascade(many, host);
  const grid = kids(host.children[0], 'cascade-grid')[0];
  t.ok(grid.children.length === 12, '12 karet');
  t.ok(grid.children.every((c) => c.classList.contains('is-open')), 'vsechny otocene');
  t.ok(grid.children.every((c) => c.classList.contains('is-unveiled')), 'vsechny odkryte');
  t.ok(grid.children.every((c) => /class="rface /.test(c.innerHTML) && /class="flip-item"/.test(c.innerHTML)),
    'kazda karta ma stranu s raritou a pod ni predmet');
  const commonCards = grid.children.filter((c) => /rare-DEFAULT/.test(c.className));
  t.ok(commonCards.every((c) => c._vars['--ud'] !== undefined), 'bezne se odkryji jednou vlnou (rozestup resi CSS)');
  t.ok(grid.children.filter((c) => c.classList.contains('is-top')).length === 1, 'prave jeden vyzdvizeny kus');

  // -------------------------------------------------------------------- obrad
  t.section('obrad odemknuti');
  host = env.el();
  env.log.length = 0;
  await Reel.unlock(drop('Syndra', 'EPIC'), host);
  stage = host.children[0];
  t.ok(phases('phase-').join(',') === 'charge,burst,open', `faze: ${phases('phase-').join(' > ')}`);
  t.ok(!/reel-strip/.test(stage.innerHTML), 'zadna ruleta (vysledek se nelosuje)');
  t.ok(stage._q['.unlock-label'].textContent === 'UNLOCKED', 'titulek');

  // ------------------------------------------------------------------- reroll
  t.section('reroll');
  delete env.mem['lootforge.fast'];
  host = env.el();
  env.log.length = 0;
  const offered = [drop('A', 'EPIC'), drop('B'), drop('C', 'LEGENDARY')];
  const result = drop('Novy', 'MYTHIC');
  let colourBeforeBloom = null;
  const run = Reel.reroll(offered, result, filler, host);
  stage = host.children[0];
  // setInterval is disabled in the harness (the app uses it for polling), hence the loop
  let spying = true;
  (function spy() {
    if (!spying) return;
    if (!stage.classList.contains('phase-bloom')) colourBeforeBloom = stage._vars['--win'];
    setTimeout(spy, 25);
  })();
  ms = await timed(() => run);
  spying = false;

  t.ok(phases('phase-').join(',') === 'offer,vortex,implode,portal,bloom', `faze: ${phases('phase-').join(' > ')}`);
  t.ok(ms > 6000 && ms < 9500, `plna delka ${ms} ms`);
  t.ok(kids(stage, 'rr-card').length === 3 && kids(stage, 'rr-card').every((c) => c.removed), 'tri shardy na oltari, po zhrouceni zmizi');
  t.ok(colourBeforeBloom === 'var(--gold)', `rarita se neprozradi pred rozkvetem (--win: ${colourBeforeBloom})`);
  t.ok(/mythic/.test(stage._vars['--win']), 'v rozkvetu barva vysledku');
  t.ok(stage._q['.rr-portal']._q.img.src === result.img, 'portal skonci na vysledku');
  t.ok(stage.classList.contains('is-big'), 'mythic = velky otres');
  t.ok(stage._q['.rr-label'].textContent === 'NEW SKIN', 'titulek rozkvetu');

  // ------------------------------------------- the full artwork when it grows
  t.section('cela kresba pri zvetseni');
  // the unlock card and the reroll portal are up to 900 px wide - a square
  // 380x380 crop would only blur there. A fake Image stands in for loading.
  let loadDelay = 5;
  global.Image = function FakeImage() {
    const im = {};
    let src = '';
    Object.defineProperty(im, 'src', {
      get: () => src,
      set(v) {
        src = v;
        setTimeout(() => (/NEEXISTUJE/.test(v) ? im.onerror && im.onerror() : im.onload && im.onload()), loadDelay);
      },
    });
    return im;
  };
  env.mem['lootforge.fast'] = '1';
  const withArt = (name, splash) => ({ ...drop(name, 'LEGENDARY'), splash });
  const varus = withArt('Varus', '/lcu/lol-game-data/assets/ASSETS/Characters/Varus/Skins/Base/Images/varus_splash_centered_0.jpg');
  const uncentered = '/lcu/lol-game-data/assets/ASSETS/Characters/Varus/Skins/Base/Images/varus_splash_uncentered_0.jpg';
  t.ok(Reel.fullArtUrl(varus) === uncentered && Reel.fullArtUrl(drop('Bez')) === '', 'centered -> uncentered, bez splashe nic');

  host = env.el();
  await Reel.unlock(varus, host);
  t.ok(host.children[0]._q['.unlock-card img'].src === uncentered, 'odemknuti sampiona: velka karta ma celou kresbu');
  t.ok(!/is-icon/.test(host.children[0].innerHTML), 'kresba se neoznaci jako ikona');

  loadDelay = 1500;   // the artwork arrives after the card grew (a fast ceremony takes ~800 ms)
  host = env.el();
  await Reel.unlock(varus, host);
  const lateCard = host.children[0]._q['.unlock-card img'];
  t.ok(lateCard.src !== uncentered, 'pomale nacitani: do te doby zustane vyrez');
  await sleep(1600);
  t.ok(lateCard.src === uncentered, '...a jakmile se kresba nacte, vymeni se');
  loadDelay = 5;

  host = env.el();
  await Reel.unlock(withArt('Rozbity', '/lcu/NEEXISTUJE_splash_centered_1.jpg'), host);
  t.ok(host.children[0]._q['.unlock-card img'].src === '', 'kresba neexistuje: zustane puvodni obrazek');

  host = env.el();
  await Reel.unlock({ ...drop('Ikona'), icon: true }, host);
  t.ok(/unlock-card is-icon/.test(host.children[0].innerHTML), 'ikona z obchodu bez kresby: cela a ostra, ne roztazena');

  host = env.el();
  await Reel.reroll(offered, withArt('Novy', '/lcu/x/janna_splash_centered_66.jpg'), filler, host);
  t.ok(host.children[0]._q['.rr-portal']._q.img.src === '/lcu/x/janna_splash_uncentered_66.jpg', 'reroll: v rozkvetu cela kresba noveho skinu');

  delete global.Image;
  delete env.mem['lootforge.fast'];

  // ---------------------------------------------------------- skip + rychle
  t.section('skip a rychly rezim');
  for (const [name, fn] of [
    ['ruleta', () => Reel.play(drop('X', 'EPIC'), filler, env.el())],
    ['pet pasu', () => Reel.playMulti([1, 2, 3, 4, 5].map((i) => drop('W' + i)), filler, env.el())],
    ['kaskada', () => Reel.cascade(many, env.el())],
    ['obrad', () => Reel.unlock(drop('U'), env.el())],
    ['reroll', () => Reel.reroll(offered, result, filler, env.el())],
  ]) {
    const p = fn();
    await sleep(250);
    Reel.skip();
    const t0 = Date.now();
    await p;
    const after = Date.now() - t0;
    t.ok(after < 500, `${name}: skip dojede za ${after} ms`);
  }

  env.mem['lootforge.fast'] = '1';
  // the cascade has two passes (rarity, then the reveal), hence more than the roulette
  const limits = { ruleta: 2300, 'pet pasu': 3200, kaskada: 2600, obrad: 1200, reroll: 2600 };
  for (const [name, fn] of [
    ['ruleta', () => Reel.play(drop('X', 'EPIC'), filler, env.el())],
    ['pet pasu', () => Reel.playMulti([1, 2, 3, 4, 5].map((i) => drop('W' + i)), filler, env.el())],
    ['kaskada', () => Reel.cascade(many, env.el())],
    ['obrad', () => Reel.unlock(drop('U'), env.el())],
    ['reroll', () => Reel.reroll(offered, result, filler, env.el())],
  ]) {
    const took = await timed(fn);
    t.ok(took < limits[name], `rychle ${name}: ${took} ms (limit ${limits[name]})`);
  }

  t.section('Motion');
  t.ok(Reel.Motion.t(4300) < 1200, `rychly rezim zkracuje: 4300 -> ${Reel.Motion.t(4300)}`);
  delete env.mem['lootforge.fast'];
  t.ok(Reel.Motion.t(4300) === 4300, 'bez rychleho rezimu beze zmeny');
  global.matchMedia = () => ({ matches: true });
  t.ok(Reel.Motion.fast === true, 'systemove omezeni pohybu zapne rychly rezim, dokud si uzivatel nevybere');
  env.mem['lootforge.fast'] = '0';
  t.ok(Reel.Motion.fast === false, 'volba uzivatele ma prednost pred systemem');

  t.section('zvuk');
  env.mem['lootforge.mute'] = '0';
  env.mem['lootforge.fast'] = '1';
  env.sound.osc = 0; env.sound.noise = 0;
  await Reel.reroll(offered, result, filler, env.el());
  t.ok(env.sound.osc > 20 && env.sound.noise > 5, `reroll hraje (oscilatoru ${env.sound.osc}, sumu ${env.sound.noise})`);
  env.mem['lootforge.mute'] = '1';
  env.sound.osc = 0; env.sound.noise = 0;
  await Reel.unlock(drop('U'), env.el());
  t.ok(env.sound.osc === 0 && env.sound.noise === 0, 'ztlumeno = ticho');

  t.done();
})().catch(t.crash);
