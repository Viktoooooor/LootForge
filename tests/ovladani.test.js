'use strict';

/*
 * Ovladani a obal odhaleni: brana pri otevreni a zavreni, zamek rolovani,
 * klavesy a vyber rezimu animace podle poctu odmen. Klient neni potreba.
 */

const { createEnv, suite, sleep } = require('./harness');

const t = suite('ovladani');
const env = createEnv();
const app = env.load(['reel.js', 'simulator.js', 'app.js'],
  ['state', 'showReveal', 'closeReveal', 'revealDrops']);
const $ = env.pick;
const Reel = globalThis.Reel;
const drop = (name, rarity) => ({ name, img: `/lcu/${name}.jpg`, rarity: rarity || 'DEFAULT', count: 1, type: 'SKIN_RENTAL' });

(async () => {
  env.mem['gamba.fast'] = '1';

  t.section('brana a zamek rolovani');
  t.ok($('#reveal').hidden && $('#modal').hidden, 'na startu je odhaleni i potvrzeni schovane');
  app.showReveal('test');
  t.ok(!$('#reveal').hidden && $('#reveal').classList.contains('is-entering'), 'otevreni rozjede branu');
  t.ok(document.body.classList.contains('reveal-open'), 'pozadi se pod odhalenim neroluje');
  await sleep(1000);
  t.ok(!$('#reveal').classList.contains('is-entering'), 'po dojeti se trida uklidi');

  $('#reveal-close').hidden = false;
  app.closeReveal();
  t.ok(!$('#reveal').hidden && $('#reveal').classList.contains('is-leaving'), 'zavreni nejdriv prehraje branu');
  await sleep(450);
  t.ok($('#reveal').hidden && !$('#reveal').classList.contains('is-leaving'), 'pak se schova');
  t.ok(!document.body.classList.contains('reveal-open'), 'rolovani se vrati');
  app.closeReveal();
  await sleep(450);
  t.ok($('#reveal').hidden, 'dvoji zavreni neublizi');

  t.section('klavesy');
  app.showReveal('klavesy');
  $('#reveal-close').hidden = true;
  let skipped = false;
  const realSkip = Reel.skip;
  Reel.skip = () => { skipped = true; realSkip(); };
  env.press('Escape');
  t.ok(skipped && !$('#reveal').hidden, 'Esc behem animace preskoci, nezavre');
  Reel.skip = realSkip;
  $('#reveal-close').hidden = false;
  env.press(' ');
  await sleep(450);
  t.ok($('#reveal').hidden, 'mezernik po dojeti zavre');

  $('#modal').hidden = false;
  let cancel = 0; let confirm = 0;
  env.autoConfirm = false;
  $('#modal-cancel').onclick = () => cancel++;
  $('#modal-ok').onclick = () => confirm++;
  env.press('Escape'); env.press('Enter');
  t.ok(cancel === 1 && confirm === 1, 'v potvrzeni: Esc zrusi, Enter potvrdi');
  $('#modal').hidden = true;

  t.section('rezim odhaleni podle poctu odmen');
  // ktera animace se zavolala - u vice veci ji pak nahradi souhrn
  let called = '';
  for (const fn of ['play', 'playMulti', 'cascade', 'unlock', 'reroll']) {
    const real = Reel[fn];
    Reel[fn] = (...args) => { called = fn; return real(...args); };
  }
  const cases = [
    ['1 vec', 1, { reel: true }, 'play'],
    ['3 veci', 3, { reel: true }, 'playMulti'],
    ['5 veci', 5, { reel: true }, 'playMulti'],
    ['9 veci', 9, { reel: true }, 'cascade'],
    ['odemknuti', 1, { unlock: true }, 'unlock'],
    ['reroll', 1, { reroll: [drop('A'), drop('B'), drop('C')] }, 'reroll'],
  ];
  for (const [label, n, opts, expected] of cases) {
    called = '';
    app.showReveal(label);
    const drops = Array.from({ length: n }, (_, i) => drop('Vec' + i, i === 1 ? 'EPIC' : 'DEFAULT'));
    await app.revealDrops(drops, label, opts);
    t.ok(called === expected && $('#reveal').classList.contains('is-cinematic'), `${label} -> ${called}`);
  }

  t.section('souhrn');
  // jedna vec: zadny souhrn, jen cedule
  app.showReveal('jedna');
  await app.revealDrops([drop('Samotna', 'EPIC')], 'jedna', { reel: true });
  let html = $('#reveal-cards').innerHTML + $('#reveal-cards').children.map((c) => c.innerHTML).join('');
  t.ok(!/class="summary"/.test(html) && /reel-win-name/.test(html), 'jedna vec = cedule, bez souhrnu');

  // vic veci: souhrn se sloucenim, soucty a poradim
  const mixed = [
    { name: 'Oranzova esence', img: '/lcu/oe.png', icon: true, rarity: 'DEFAULT', count: 270, type: 'CURRENCY' },
    { name: 'Star Guardian Kaisa', img: '/lcu/k.jpg', rarity: 'LEGENDARY', count: 1, type: 'SKIN_RENTAL' },
    { name: 'Oranzova esence', img: '/lcu/oe.png', icon: true, rarity: 'DEFAULT', count: 150, type: 'CURRENCY' },
    { name: 'Annie', img: '/lcu/a.jpg', rarity: 'DEFAULT', count: 1, type: 'CHAMPION_RENTAL' },
    { name: 'Dawnbringer Renekton', img: '/lcu/r.jpg', rarity: 'EPIC', count: 1, type: 'SKIN_RENTAL' },
    { name: 'Bez obrazku', img: '', rarity: 'EPIC', count: 1, type: 'SKIN_RENTAL' },
  ];
  app.showReveal('souhrn');
  await app.revealDrops(mixed, 'souhrn', { reel: true });
  const host = $('#reveal-cards').children[0];
  html = host ? host.innerHTML : '';
  t.ok(/class="summary"/.test(html), 'vic veci = souhrn misto animace');
  t.ok(/CO TI PADLO/.test(html) && /6 predmetu/.test(html), 'nadpis a pocet');
  t.ok(/3 skin shardy/.test(html) && /1 champion shard/.test(html), 'soucty podle druhu s ceskymi tvary');
  t.ok(/\+420 oranzova esence/.test(html), 'stejna esence z vice beden se secte (270 + 150)');
  const order = [...html.matchAll(/sum-card rare-(\w+)/g)].map((m) => m[1]);
  t.ok(order[0] === 'LEGENDARY' && order.indexOf('DEFAULT') > order.lastIndexOf('EPIC'), `serazene od nejvzacnejsiho: ${order.join(' > ')}`);
  t.ok((html.match(/sum-card /g) || []).length === 5, 'esence slouceny do jedne karty (5 karet ze 6 dropu)');
  t.ok(/sum-card rare-LEGENDARY is-top/.test(html), 'nejlepsi kus vyzdvizeny');
  t.ok(/rarity-gem-icons\/legendary\.png/.test(html), 'u vzacnych drahokam rarity');
  t.ok(/sum-glyph/.test(html), 'polozka bez obrazku nerozbije kartu');
  t.ok(!$('#reveal-close').hidden, 'po souhrnu jde odhaleni zavrit');

  app.showReveal('rozlozeni');
  await app.revealDrops([drop('Esence'), drop('Esence2')], 'rozlozeni');
  t.ok(!$('#reveal').classList.contains('is-cinematic'), 'rozlozeni bez animace, uzky sloupec');

  t.done();
})().catch(t.crash);
