'use strict';

/*
 * The shared environment for the tests.
 *
 * Every test runs in its own process (run.js starts them), so it can set up
 * global stand-ins without them affecting each other:
 *   - the DOM (only as much as the app really uses)
 *   - WebAudio, localStorage, requestAnimationFrame, EventSource
 *   - fetch pointed at the running server.js
 *
 * POST IS BLOCKED. No test may craft, open or disenchant anything on a real
 * account - an attempt is only recorded in env.posts and the fetch fails.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.LOOTFORGE_URL || process.env.GAMBA_URL || 'http://127.0.0.1:4545';

const EXIT = { OK: 0, FAIL: 1, SKIP: 3 };

function createEnv(options = {}) {
  const env = {
    log: [],            // class changes: '+class' / '-class'
    posts: [],          // blocked POST attempts (url)
    postBodies: [],     // ... and their bodies, so what would be sent can be checked
    mem: {
      'lootforge.mute': options.sound ? '0' : '1',
      'lootforge.welcome': '1',                           // the first-start notice would swallow the keys
      'lootforge.testItems': options.testItems === false ? '0' : '1',   // the tests count on them
    },
    sound: { osc: 0, noise: 0 },
    keyHandlers: [],
    clickHandlers: [],
    autoConfirm: options.autoConfirm !== false,
    postResponse: null,   // (url) => a faked response to a blocked POST
    top: {},
  };

  // --- DOM ---------------------------------------------------------------

  function el() {
    const e = {
      className: '', _html: '', textContent: '', hidden: false, disabled: false, title: '',
      children: [], _q: {}, _vars: {}, dataset: {}, clientWidth: 1800, removed: false, src: '',
      style: {
        setProperty(k, v) { e._vars[k] = v; },
        transform: '', filter: '', opacity: '', width: '', height: '', animationDelay: '',
      },
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => { this._s.add(x); env.log.push('+' + x); }); },
        remove(...c) { c.forEach((x) => { this._s.delete(x); env.log.push('-' + x); }); },
        toggle(c, force) {
          const on = force === undefined ? !this._s.has(c) : !!force;
          if (on) this._s.add(c); else this._s.delete(c);
          return on;
        },
        contains(c) { return this._s.has(c); },
        get list() { return [...this._s]; },
      },
      appendChild(c) { e.children.push(c); return c; },
      remove() { e.removed = true; },
      addEventListener() {},
      removeAttribute(name) { if (name === 'src') e.src = ''; },
      insertAdjacentHTML(where, html) { e._html += html; },
      click() { if (e._onclick) e._onclick(); },
      querySelector(sel) { if (!e._q[sel]) e._q[sel] = el(); return e._q[sel]; },
      set innerHTML(v) { e._html = v; e.children.length = 0; },
      get innerHTML() { return e._html; },
      set onclick(fn) {
        e._onclick = fn;
        // "the user clicks Confirm" - only when the test wants it
        if (fn && env.autoConfirm && e === env.top['#modal-ok']) setTimeout(fn, 0);
      },
      get onclick() { return e._onclick; },
    };
    return e;
  }

  env.el = el;
  env.pick = (sel) => { if (!env.top[sel]) env.top[sel] = el(); return env.top[sel]; };

  // elements with a hidden attribute in index.html start hidden here too -
  // otherwise the key handler would think a confirmation dialog is open
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    if (/\shidden(\s|>|=)/.test(m[0])) env.pick('#' + m[1]).hidden = true;
  }

  global.window = global;
  global.innerWidth = options.width || 1858;
  global.innerHeight = options.height || 937;
  global.matchMedia = () => ({ matches: !!options.reducedMotion });
  global.document = {
    body: el(),
    createElement: () => el(),
    querySelector: env.pick,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (type === 'keydown') env.keyHandlers.push(fn);
      if (type === 'click') env.clickHandlers.push(fn);
    },
  };
  global.localStorage = {
    getItem: (k) => (k in env.mem ? env.mem[k] : null),
    setItem: (k, v) => { env.mem[k] = String(v); },
    removeItem: (k) => { delete env.mem[k]; },
  };
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
  global.setInterval = () => 0;   // the app's occasional polling is not wanted in tests
  global.EventSource = function EventSource() { this.addEventListener = () => {}; };

  // --- WebAudio ----------------------------------------------------------

  const param = () => ({
    value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {},
  });
  const node = (extra) => Object.assign({ connect: (dest) => dest }, extra);
  global.AudioContext = function AudioContext() {
    return {
      state: 'running', currentTime: 0, sampleRate: 44100, resume() {}, destination: node(),
      createGain: () => node({ gain: param() }),
      createOscillator: () => { env.sound.osc++; return node({ type: '', frequency: param(), start() {}, stop() {} }); },
      createBiquadFilter: () => node({ type: '', Q: param(), frequency: param() }),
      createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
      createBufferSource: () => { env.sound.noise++; return node({ buffer: null, start() {}, stop() {} }); },
    };
  };

  // --- fetch -------------------------------------------------------------

  const realFetch = global.fetch;
  global.fetch = (url, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {   // reading is allowed, changing is not
      env.posts.push(url);
      env.postBodies.push(init && init.body);
      // a test can ask for a faked response (502 = the client dropped out, say)
      const fakeResponse = env.postResponse && env.postResponse(url);
      if (fakeResponse) return Promise.resolve(fakeResponse);
      return Promise.reject(new Error('POST zablokovan testem'));
    }
    return realFetch(BASE + url, init);
  };

  /**
   * A click without a real DOM: `hits` says what target.closest(selector) would
   * find, e.g. { '.card[data-selectable]': { dataset: { id, detail: '1' } } }.
   */
  env.click = (hits) => {
    const target = { closest: (sel) => (hits && hits[sel]) || null };
    env.clickHandlers.forEach((h) => h({ target, stopPropagation() {}, preventDefault() {} }));
  };

  env.press = (key) => env.keyHandlers.forEach((h) => h({ key, code: key === ' ' ? 'Space' : key, preventDefault() {} }));

  /**
   * Loads the files from public/ the way the browser does. It appends a line to
   * app.js that exposes the named internal functions - app.js is in strict mode,
   * so they would not be visible from the outside otherwise.
   */
  env.load = (files, exports) => {
    for (const f of files) {
      let src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
      if (f === 'app.js' && exports && exports.length) {
        src += `\nglobalThis.__app = { ${exports.join(', ')} };\n`;
      }
      (0, eval)(src);
    }
    return globalThis.__app;
  };

  return env;
}

/** Is the server running and a client connected? */
async function clientStatus() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(BASE + '/api/status', { signal: ctrl.signal });
    clearTimeout(timer);
    const json = await res.json();
    return { server: true, client: !!json.connected };
  } catch (_) {
    return { server: false, client: false };
  }
}

/** A minimal set of checks - no framework, no dependencies. */
function suite(name) {
  let fails = 0;
  let checks = 0;
  const t = {
    section(title) { console.log(`\n  -- ${title}`); },
    ok(cond, msg) {
      checks++;
      if (cond) console.log(`     ok    ${msg}`);
      else { fails++; console.log(`     CHYBA ${msg}`); }
      return !!cond;
    },
    info(msg) { console.log(`           ${msg}`); },
    skip(reason) {
      console.log(`     SKIP  ${reason}`);
      process.exit(EXIT.SKIP);
    },
    done() {
      console.log(`\n  ${name}: ${checks - fails}/${checks}`);
      process.exit(fails ? EXIT.FAIL : EXIT.OK);
    },
    crash(err) {
      console.log(`     PAD   ${err && err.stack ? err.stack : err}`);
      process.exit(EXIT.FAIL);
    },
  };
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { createEnv, clientStatus, suite, sleep, EXIT, PUBLIC, ROOT, BASE };
