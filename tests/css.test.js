'use strict';

/*
 * Staticka kontrola CSS proti kodu. Chyta chyby, ktere headless testy animaci
 * neuvidi: JS nastavi tridu, pro kterou CSS nema pravidlo, a animace se tise
 * nestane (takhle zmizelo .sfx-btn.is-muted). Plus dve pasti s posuvnikem.
 */

const fs = require('fs');
const path = require('path');
const { suite, PUBLIC } = require('./harness');

const t = suite('css');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS = { 'app.css': stripComments(read('app.css')), 'reel.css': stripComments(read('reel.css')) };
const CODE = ['index.html', 'app.js', 'reel.js', 'simulator.js'].map((f) => [f, read(f)]);

// Tridy, ktere zamerne nemaji styl - jsou to jen haky pro JS.
const HOOKS = {
  'conn-label': 'querySelector pro text stavu pripojeni',
  'group': 'obal skupiny, mezery resi .groups',
  'is-winner': 'SCHVALNE bez stylu - prozradil by vyhru behem roztaceni',
  'rare-DEFAULT': 'vychozi vzhled, zadna rarita',
  'reel-host': 'obal, rozmer resi vnitrek',
};

t.section('zavorky');
for (const [f, css] of Object.entries(CSS)) {
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  t.ok(open === close, `${f}: ${open} x { a ${close} x }`);
  t.ok(!/\{\s*\}/.test(css), `${f}: zadne prazdne pravidlo`);
}

t.section('tridy z kodu maji pravidlo v CSS');
const defined = new Set();
for (const css of Object.values(CSS)) {
  for (const block of css.split('{')) {
    const selector = block.split('}').pop();
    for (const m of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) defined.add(m[1]);
  }
}

const used = new Map();
const note = (raw, where) => {
  // tokeny z template literalu (${...}, ternary) ocistit od uvozovek a zavorek
  const c = String(raw).replace(/^[`'"{}]+|[`'"{}]+$/g, '').trim();
  if (!/^[A-Za-z][\w-]*$/.test(c)) return;
  if (!used.has(c)) used.set(c, where);
};
for (const [f, src] of CODE) {
  for (const m of src.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => note(c, f));
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/'([^']+)'/g)) q[1].split(/\s+/).forEach((c) => note(c, f));
  }
  for (const m of src.matchAll(/makeEl\(\s*[`']([^`']+)[`']/g)) m[1].split(/\s+/).forEach((c) => note(c, f));
}
// dynamicke rare-* a r-* rozepsat
for (const r of ['EPIC', 'LEGENDARY', 'MYTHIC', 'ULTIMATE']) { note('rare-' + r, 'dynamicky'); note('r-' + r, 'dynamicky'); }

const missing = [...used.keys()].filter((c) => !defined.has(c) && !HOOKS[c]);
// jen tokeny, ktere opravdu vypadaji jako nazev tridy (ne slova z ternaru)
const suspicious = missing.filter((c) => c.includes('-'));
t.ok(suspicious.length === 0, suspicious.length
  ? `trida bez pravidla: ${suspicious.map((c) => `${c} (${used.get(c)})`).join(', ')}`
  : `${used.size} trid z kodu, vsechny s pravidlem (krome ${Object.keys(HOOKS).length} zamernych haku)`);

t.ok(defined.has('sfx-btn') && /\.sfx-btn\.is-muted/.test(CSS['reel.css'] + CSS['app.css']),
  'tlacitko Zvuk ma stav is-muted (jednou uz pri prepisu zmizel)');

t.section('pasti s vodorovnym posuvnikem');
for (const [f, css] of Object.entries(CSS)) {
  const vw100 = [...css.matchAll(/(?:^|[;{\s])(?:max-)?width:\s*100vw/g)];
  t.ok(vw100.length === 0, `${f}: zadne width: 100vw (pocita i se svislym posuvnikem)`);

  // kazde pravidlo s overflow-y musi explicitne rict i overflow-x
  const rules = css.split('}').map((r) => r.split('{').pop());
  const bad = rules.filter((r) => /overflow-y\s*:\s*(auto|scroll)/.test(r) && !/overflow-x\s*:/.test(r) && !/overflow\s*:/.test(r));
  t.ok(bad.length === 0, `${f}: overflow-y: auto nikde bez overflow-x (${bad.length} prohresku)`);
}

t.ok(/\.unlock-stage\s*\{[^}]*overflow:\s*hidden/.test(CSS['reel.css']), 'obrad oreze prstence (jinak +154 px rolovani)');
t.ok(/\.rr-stage\s*\{[^}]*overflow:\s*hidden/.test(CSS['reel.css']), 'reroll orizne paprsky a strepy');
t.ok(/body\s*\{[^}]*overflow-x:\s*clip/.test(CSS['app.css']), 'body ma overflow-x: clip (ne hidden - rozbilo by sticky)');

t.done();
