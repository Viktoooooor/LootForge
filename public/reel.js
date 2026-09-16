/* Hextech animace odmen - pres celou obrazovku.
 *
 * Podle toho, kolik toho padne, se pouzije jiny rezim:
 *   play()     1 vec     - jedna velka ruleta pres celou sirku
 *   playMulti()2-5 veci  - tolik pasu nad sebou, kazdy dojede o chvili pozdeji
 *   cascade()  6+ veci   - mrizka rubem nahoru, karty se postupne otaceji
 *   unlock()   odemknuti - obrad, nic se netoci (vysledek je predem jasny)
 *
 * Animace zene requestAnimationFrame (ne CSS transition), protoze jen tak vim
 * v kazdem snimku, jak rychle pas jede - a podle toho ridim rozmazani i zvuk.
 * Rozmery dlazdic pocita JS a predava je do CSS pres --tw/--th, takze se to
 * prizpusobi obrazovce a nemuze se to s CSS rozejit.
 *
 * Zvuk se cely syntetizuje WebAudiem, zadne mp3 se nikam netahaji.
 */

'use strict';

globalThis.Reel = (function () {

  const TILES = 58;
  const WIN_AT = 50;           // na kolikate dlazdici pas zastavi
  const CHARGE = 750;          // ms nabijeni pred startem
  const SPIN_BASE = 4300;      // ms jizdy prvniho pasu
  const SPIN_STEP = 430;       // o kolik dojede kazdy dalsi pas pozdeji
  const CLOSING_FROM = 0.82;   // odkud se pas barvi do rarity vyhry
  const MAX_ROWS = 5;

  const RARITY_LABEL = {
    DEFAULT: 'ZISK', EPIC: 'EPIC', LEGENDARY: 'LEGENDARY',
    MYTHIC: 'MYTHIC', ULTIMATE: 'ULTIMATE', TRANSCENDENT: 'TRANSCENDENT', EXALTED: 'EXALTED',
  };
  const RARITY_RANK = ['DEFAULT', 'EPIC', 'LEGENDARY', 'MYTHIC', 'ULTIMATE', 'TRANSCENDENT', 'EXALTED'];

  let skipRequested = false;

  /**
   * Rychly rezim. Sest vterin na bednu je paradni jednou, ne po padesate.
   * Dokud si uzivatel nevybere sam, rozhoduje systemove nastaveni omezeni pohybu.
   */
  const Motion = {
    get reduced() {
      return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },
    get fast() {
      const v = localStorage.getItem('gamba.fast');
      return v === null ? this.reduced : v === '1';
    },
    set fast(v) { localStorage.setItem('gamba.fast', v ? '1' : '0'); },
    /** Zkrati casovani, kdyz je zapnuty rychly rezim. */
    t(ms) { return this.fast ? Math.max(60, Math.round(ms * 0.26)) : ms; },
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rank = (r) => Math.max(0, RARITY_RANK.indexOf(r || 'DEFAULT'));
  const rarityVar = (r) => `var(--r-${String(r || 'DEFAULT').toLowerCase()}, var(--r-default))`;

  /** Cekani, ktere jde kdykoliv utnout tlacitkem "Preskocit animaci". */
  function wait(ms) {
    return new Promise((resolve) => {
      if (skipRequested || ms <= 0) return resolve();
      const t0 = performance.now();
      (function step() {
        const left = ms - (performance.now() - t0);
        if (skipRequested || left <= 0) return resolve();
        // po 40 ms kvuli skipu, ale kratka cekani nenatahovat na celych 40
        setTimeout(step, Math.min(40, left));
      })();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const viewport = () => ({
    w: (typeof window !== 'undefined' && window.innerWidth) || 1280,
    h: (typeof window !== 'undefined' && window.innerHeight) || 800,
  });

  // ======================================================================
  //  ZVUK
  // ======================================================================

  const Sfx = {
    ctx: null, master: null, _noise: null,

    get enabled() { return localStorage.getItem('gamba.mute') !== '1'; },
    set enabled(v) { localStorage.setItem('gamba.mute', v ? '0' : '1'); },

    /** AudioContext smi vzniknout az po kliknuti - sem se vzdy dostaneme z nej. */
    wake() {
      if (!this.enabled) return null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this.ctx) {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.85;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },

    /** Sumovy buffer se vyrabi jednou - tiku je za jizdu pres ctyricet. */
    noiseBuffer(ctx) {
      if (!this._noise) {
        const len = Math.floor(ctx.sampleRate * 0.8);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        this._noise = buf;
      }
      return this._noise;
    },

    tone(freq, dur, gain, type, slideTo, delay) {
      const ctx = this.wake();
      if (!ctx) return;
      const t = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const vol = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      vol.gain.setValueAtTime(0.0001, t);
      vol.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(0.04, dur / 3));
      vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(vol).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    },

    noise(dur, gain, filter, freq, sweepTo, delay) {
      const ctx = this.wake();
      if (!ctx) return;
      const t = ctx.currentTime + (delay || 0);
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(ctx);
      const biq = ctx.createBiquadFilter();
      biq.type = filter || 'bandpass';
      biq.Q.value = 1.1;
      biq.frequency.setValueAtTime(freq, t);
      if (sweepTo) biq.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
      const vol = ctx.createGain();
      vol.gain.setValueAtTime(Math.max(0.0002, gain), t);
      vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(biq).connect(vol).connect(this.master);
      src.start(t);
      src.stop(t + dur + 0.02);
    },

    /** Tik pod zamerovacem. `slow` 0 = pas leti, 1 = uz sotva leze. */
    clack(slow) {
      this.noise(0.028 + 0.055 * slow, 0.045 + 0.13 * slow, 'bandpass', 2700 - 1500 * slow);
      if (slow > 0.5) this.tone(170 - 55 * slow, 0.1, 0.05 * slow, 'triangle');
    },

    whoosh() { this.noise(0.85, 0.14, 'lowpass', 350, 2800); },

    chargeUp(sec) {
      this.tone(80, sec, 0.09, 'sawtooth', 380);
      this.noise(sec, 0.045, 'highpass', 260, 2000);
    },

    /** Dunivy podklad behem jizdy; hlasitost ridi rychlost pasu. */
    rumble() {
      const ctx = this.wake();
      if (!ctx) return null;
      const osc = ctx.createOscillator();
      const low = ctx.createBiquadFilter();
      const vol = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 44;
      low.type = 'lowpass';
      low.frequency.value = 170;
      vol.gain.value = 0.0001;
      osc.connect(low).connect(vol).connect(this.master);
      osc.start();
      return {
        set(v) { try { vol.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.06); } catch (_) {} },
        stop() {
          try {
            vol.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1);
            osc.stop(ctx.currentTime + 0.7);
          } catch (_) {}
        },
      };
    },

    /** Dopad na vyhru. `weight` ztlumi rady, ktere nejsou ta hlavni. */
    land(rarity, weight) {
      const w = weight == null ? 1 : weight;
      const chords = {
        DEFAULT:   [294, 440],
        EPIC:      [392, 587, 784],
        LEGENDARY: [415, 622, 831, 1046],
        MYTHIC:    [440, 659, 880, 1318],
        ULTIMATE:  [523, 784, 1046, 1568, 2093],
        TRANSCENDENT: [587, 740, 880, 1174, 1480, 1760],
        EXALTED:   [659, 830, 988, 1318, 1661, 1976, 2637],
      };
      const notes = chords[rarity] || chords.DEFAULT;
      const big = notes.length > 3;

      this.tone(58, 0.85, 0.26 * w, 'sine', 34);
      this.noise(0.5, 0.16 * w, 'lowpass', 1800, 200);

      notes.forEach((f, i) => {
        this.tone(f, big ? 1.5 : 0.9, 0.085 * w, 'triangle', null, i * 0.055);
        if (big) this.tone(f * 2, 2.1, 0.03 * w, 'sine', null, 0.22 + i * 0.06);
      });

      if (big) {
        this.noise(1.6, 0.05 * w, 'highpass', 4000, 9000, 0.18);
        this.tone(notes[0] / 2, 2.2, 0.05 * w, 'sine', null, 0.1);
      }
    },

    /** Otoceni karty v kaskade - cim vzacnejsi, tim vys a dyl. */
    /** Odhaleni, co se skryva za raritou: trpytivy prejezd, u vzacnych vys a plnejsi. */
    unveil(rarityRank) {
      const r = rarityRank || 0;
      this.noise(0.4, 0.05 + r * 0.015, 'highpass', 2400, 9500);
      this.tone(620 + r * 105, 0.32, 0.045 + r * 0.01, 'triangle', 930 + r * 150);
      if (r >= 2) this.tone(1240 + r * 150, 0.6, 0.025, 'sine', null, 0.08);
    },

    flip(rarityRank) {
      this.noise(0.05, 0.07, 'bandpass', 1800 + rarityRank * 400);
      this.tone(240 + rarityRank * 90, 0.14, 0.05, 'triangle');
    },

    /** Otevreni a zavreni brany kolem celeho odhaleni. */
    gateOpen() {
      this.tone(130, 0.55, 0.13, 'sine', 62);
      this.noise(0.55, 0.12, 'highpass', 200, 2800);
      this.tone(520, 0.3, 0.045, 'triangle', 900, 0.05);
    },

    gateClose() {
      this.tone(96, 0.42, 0.14, 'sine', 46);
      this.noise(0.32, 0.09, 'lowpass', 2400, 300);
    },

    unlockCharge(sec) {
      this.tone(70, sec, 0.11, 'sawtooth', 300);
      this.tone(210, sec, 0.05, 'sine', 900);
      this.noise(sec, 0.05, 'bandpass', 400, 3200);
      for (let i = 0; i < 5; i++) this.tone(660 + i * 120, 0.16, 0.04, 'sine', null, sec * (0.3 + i * 0.13));
    },

    // --- reroll ---

    /** Polozeni shardu na oltar - kazdy o kus vys. */
    rrPlace(i) {
      this.tone(92 - i * 9, 0.4, 0.17, 'sine', 52);
      this.noise(0.14, 0.09, 'bandpass', 900 + i * 280);
      this.tone(330 * Math.pow(1.26, i), 0.6, 0.045, 'triangle', null, 0.04);
    },

    /** Vir: dva rozladene pily a sum, vsechno stoupa a zrychluje. */
    rrVortex(sec) {
      this.tone(52, sec, 0.12, 'sawtooth', 470);
      this.tone(55, sec, 0.07, 'sawtooth', 495);
      this.noise(sec, 0.08, 'bandpass', 220, 5200);
      for (let i = 0; i < 9; i++) {
        this.tone(480 + i * 95, 0.08, 0.03, 'square', null, sec * (0.3 + i * 0.075));
      }
    },

    /** Zhrouceni do jadra. */
    rrImplode() {
      this.tone(40, 1.7, 0.36, 'sine', 23);
      this.noise(0.95, 0.25, 'lowpass', 4200, 110);
      this.noise(0.22, 0.12, 'highpass', 2200, 9500);
    },

    /** Mihnuti skinu v portalu; `p` 0..1 = jak daleko jsme. */
    rrFlick(p) {
      this.noise(0.03 + 0.05 * p, 0.05 + 0.1 * p, 'bandpass', 3300 - 1900 * p);
      this.tone(420 + 820 * p, 0.06 + 0.09 * p, 0.028 + 0.045 * p, 'triangle');
    },

    unlockBurst(rarity) {
      this.tone(48, 1.3, 0.3, 'sine', 28);
      this.noise(0.7, 0.2, 'lowpass', 3000, 180);
      const notes = (rarity === 'ULTIMATE' || rarity === 'MYTHIC')
        ? [523, 659, 784, 1046, 1568]
        : [440, 554, 659, 880];
      notes.forEach((f, i) => {
        this.tone(f, 2.2, 0.08, 'triangle', null, i * 0.06);
        this.tone(f * 2, 2.6, 0.028, 'sine', null, 0.3 + i * 0.07);
      });
      this.noise(2.0, 0.055, 'highpass', 3500, 10000, 0.15);
    },
  };

  // ======================================================================
  //  SPOLECNE KOUSKY
  // ======================================================================

  function makeEl(cls, html) {
    const e = document.createElement('div');
    e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  /** Rozsype strepy ze stredu prvku. */
  function shards(host, rarity, count, spread) {
    const wrap = makeEl(`fx-shards rare-${rarity}`);
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const dist = spread * (0.55 + Math.random() * 0.75);
      const size = 4 + Math.random() * 8;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.animationDelay = `${Math.random() * 110}ms`;
      wrap.appendChild(p);
    }
    host.appendChild(wrap);
    setTimeout(() => wrap.remove(), 1600);
  }

  const GEM = (r) => `/lcu/lol-game-data/assets/v1/rarity-gem-icons/${String(r).toLowerCase()}.png`;

  /**
   * Strana karty, ktera ukazuje jen raritu - drahokam z klienta a barvu.
   * Co to je, se hrac dozvi az pri odhaleni. Bezne veci drahokam nemaji
   * (stejne jako v LoLku), dostanou jen sedy hextech kosoctverec.
   */
  function rarityFaceHtml(rarity) {
    const r = rarity || 'DEFAULT';
    const gem = r === 'DEFAULT'
      ? '<span class="rface-hex"></span>'
      : `<img class="rface-gem" src="${GEM(r)}" alt="" onerror="this.style.display='none'">`;
    return `<div class="rface rare-${esc(r)}">
      ${gem}
      ${r === 'DEFAULT' ? '' : `<span class="rface-label">${esc(RARITY_LABEL[r] || r)}</span>`}
    </div>`;
  }

  /**
   * Dlazdice pasu. Vypln ukazuje jen raritu. Vyherni dlazdice ma pod raritou
   * schovany i samotny predmet, ktery se odkryje az po dojezdu.
   */
  function tileHtml(drop, isWinner) {
    const r = esc(drop.rarity || 'DEFAULT');
    if (!isWinner) return `<div class="reel-tile rare-${r}">${rarityFaceHtml(drop.rarity)}</div>`;
    return `<div class="reel-tile rare-${r} is-winner">
      <div class="tile-item">
        ${drop.img ? `<img src="${esc(drop.img)}" alt="" onerror="this.style.display='none'">` : ''}
        <span class="reel-tile-name">${esc(drop.name)}${drop.count > 1 ? ` &times;${drop.count}` : ''}</span>
      </div>
      ${rarityFaceHtml(drop.rarity)}
    </div>`;
  }

  /**
   * Poskladá pas: nahodna vypln, na WIN_AT pozici vyhra.
   * Vypln se losuje, ne bere po poradku - jinak by kazdy pas vypadal stejne
   * a pri peti bednach naraz to bylo videt na prvni pohled.
   */
  function buildStrip(winner, filler) {
    const tiles = [];
    let last = -1;

    for (let i = 0; i < TILES; i++) {
      if (i === WIN_AT) { tiles.push(tileHtml(winner, true)); continue; }

      let idx = Math.floor(Math.random() * filler.length);
      // dva stejne obrazky vedle sebe vypadaji jako chyba vykreslovani
      if (filler.length > 1 && idx === last) idx = (idx + 1) % filler.length;
      last = idx;

      tiles.push(tileHtml(filler[idx] || winner, false));
    }
    return tiles.join('');
  }

  /**
   * Rozmery dlazdic podle poctu rad a velikosti okna. JS je jediny zdroj
   * pravdy - CSS si je bere z --tw/--th, takze se to nemuze rozejit.
   */
  function geometry(rows) {
    const vp = viewport();

    // Kolem pasu musi zbyt misto na titulek, ceduli s vyhrou a tlacitka.
    // Bez teto rezervy pet pasu prelezlo a odhaleni zacalo rolovat.
    const strop = Math.min(vp.h * 0.9, 900);        // .reveal-inner ma max-height: 90vh
    const chrome = Math.min(260, strop * 0.34);     // na malem okne se rezerva sama zmensi
    const avail = Math.max(180, strop - chrome);

    const rowH = clamp(Math.floor(avail / rows) - 14, 64, rows === 1 ? 200 : 150);
    const tileH = Math.round(rowH * 0.78);
    const tileW = Math.round(tileH * 16 / 9);
    return { rowH, tileH, tileW, gap: 12, stride: tileW + 12 };
  }

  // ======================================================================
  //  RULETA (1 az 5 pasu naraz)
  // ======================================================================

  function spin(rowDefs, host) {
    skipRequested = false;

    const rows = rowDefs.slice(0, MAX_ROWS);
    const geo = geometry(rows.length);
    const vp = viewport();
    const best = rows.reduce((b, r) => (rank(r.winner.rarity) > rank(b.winner.rarity) ? r : b), rows[0]);

    const stage = makeEl('reel-stage');
    // zlata, dokud nic nedojede - jinak by zare prozradila nejlepsi drop hned na startu
    stage.style.setProperty('--win', 'var(--gold)');
    stage.appendChild(makeEl('cine-glow'));

    const built = rows.map((def) => {
      const row = makeEl('reel-row', `
        <div class="reel-window">
          <div class="reel-strip"></div>
          <div class="reel-scan"></div>
          <div class="reel-marker"></div>
          <div class="reel-fade left"></div>
          <div class="reel-fade right"></div>
          <div class="reel-shock"></div>
          <div class="reel-flash"></div>
        </div>`);
      row.style.setProperty('--tw', `${geo.tileW}px`);
      row.style.setProperty('--th', `${geo.tileH}px`);
      row.style.setProperty('--rh', `${geo.rowH}px`);
      row.style.setProperty('--win', rarityVar(def.winner.rarity));

      const windowEl = row.querySelector('.reel-window');
      const strip = row.querySelector('.reel-strip');
      strip.innerHTML = buildStrip(def.winner, (def.filler && def.filler.length) ? def.filler : [def.winner]);

      stage.appendChild(row);
      return { def, row, windowEl, strip };
    });

    host.innerHTML = '';
    host.appendChild(stage);

    // kam ma ktery pas dojet
    const jitterMax = geo.stride * 0.5;
    built.forEach((b, i) => {
      // sirka bereme z realneho prvku, ne z window.innerWidth - to pocita
      // i se svislym posuvnikem a vyhra by dosedla mimo zamerovac
      const w = b.windowEl.clientWidth || vp.w;
      b.end = -(WIN_AT * geo.stride + geo.stride / 2 - w / 2 + (Math.random() - 0.5) * jitterMax);
      b.duration = Motion.t(SPIN_BASE) + i * Motion.t(SPIN_STEP);
      b.landed = false;
    });

    const lastIndex = built.length - 1;

    return (async () => {
      // --- 1) nadech ---
      built.forEach((b) => b.windowEl.classList.add('is-charging'));
      Sfx.chargeUp(Motion.t(CHARGE) / 1000);
      await wait(Motion.t(CHARGE));
      built.forEach((b) => b.windowEl.classList.remove('is-charging'));

      // --- 2) jizda ---
      if (!skipRequested) Sfx.whoosh();
      const rum = Sfx.rumble();
      built.forEach((b) => b.windowEl.classList.add('is-spinning'));

      await new Promise((resolve) => {
        const t0 = performance.now();
        let lastIdx = -1;
        let lastX = 0;

        function landRow(b, i) {
          if (b.landed) return;
          b.landed = true;
          b.strip.style.transform = `translateX(${b.end}px)`;
          b.strip.style.filter = 'none';
          b.windowEl.classList.remove('is-spinning');
          const win = b.strip.querySelector('.is-winner');
          if (win) win.classList.add('landed');
          b.windowEl.classList.add('is-done');
          shards(b.windowEl, b.def.winner.rarity || 'DEFAULT', built.length > 1 ? 16 : 28, built.length > 1 ? 110 : 190);
          // hlavni rana patri posledni rade, ostatni jen cvaknou
          Sfx.land(b.def.winner.rarity || 'DEFAULT', i === lastIndex ? 1 : 0.45);
          if (i === lastIndex || rank(b.def.winner.rarity) >= 3) {
            stage.classList.add('is-hit');
            setTimeout(() => stage.classList.remove('is-hit'), 460);
          }
        }

        function frame(now) {
          if (skipRequested) {
            built.forEach(landRow);
            if (rum) rum.stop();
            return resolve();
          }

          const elapsed = now - t0;
          let allDone = true;

          built.forEach((b, i) => {
            if (b.landed) return;
            const t = clamp(elapsed / b.duration, 0, 1);
            const eased = 1 - Math.pow(1 - t, 4.2);   // rychly start, dlouhy dojezd
            const x = b.end * eased;

            b.strip.style.transform = `translateX(${x}px)`;

            if (i === lastIndex) {
              // rozmazani a zvuk ridi posledni pas - tika az do uplneho konce
              const pxPerMs = Math.abs(x - lastX) / 16.7;
              lastX = x;
              if (rum) rum.set(clamp(pxPerMs / 90, 0, 1) * 0.16);
              const idx = Math.floor(-x / geo.stride);
              if (idx !== lastIdx) { lastIdx = idx; Sfx.clack(t); }
            }
            b.strip.style.filter = `blur(${clamp(Math.abs(b.end) * (1 - t) ** 3.2 / 260, 0, 8).toFixed(2)}px)`;

            if (!b.closing && t > CLOSING_FROM) {
              b.closing = true;
              b.windowEl.classList.add('is-closing');
            }

            if (t >= 1) landRow(b, i);
            else allDone = false;
          });

          if (allDone) {
            if (rum) rum.stop();
            return resolve();
          }
          requestAnimationFrame(frame);
        }

        requestAnimationFrame(frame);
      });

      // --- 4) odhaleni: rarita uz je videt, ted teprve co to je ---
      await wait(skipRequested ? 0 : Motion.t(built.length > 1 ? 380 : 650));
      stage.style.setProperty('--win', rarityVar(best.winner.rarity));
      for (let i = 0; i < built.length; i++) {
        const b = built[i];
        const win = b.strip.querySelector('.is-winner');
        if (win) win.classList.add('is-unveiled');
        Sfx.unveil(rank(b.def.winner.rarity));
        if (i < built.length - 1) await wait(skipRequested ? 0 : Motion.t(380));
      }
      await wait(skipRequested ? 60 : Motion.t(750));
    })();
  }

  const play = (winner, filler, host) => spin([{ winner, filler }], host);
  const playMulti = (winners, filler, host) => spin(winners.map((w) => ({ winner: w, filler })), host);

  // ======================================================================
  //  KASKADA (hodne veci naraz)
  // ======================================================================

  /**
   * Na ruletu je toho moc, tak se vsechno rozlozi rubem nahoru a karty se
   * postupne otaceji. Vzacne se otoci pomaleji a s ranou, at je poznat.
   */
  function cascade(drops, host) {
    skipRequested = false;

    const best = drops.reduce((b, d) => (rank(d.rarity) > rank(b.rarity) ? d : b), drops[0]);
    const stage = makeEl('cascade-stage');
    stage.style.setProperty('--win', rarityVar(best.rarity));
    stage.appendChild(makeEl('cine-glow'));

    const grid = makeEl('cascade-grid');
    const cards = drops.map((d) => {
      const card = makeEl(`flip rare-${d.rarity || 'DEFAULT'}`, `
        <div class="flip-in">
          <div class="flip-back"><span class="flip-hex"></span></div>
          <div class="flip-front">
            <div class="flip-item">
              ${d.img ? `<img src="${esc(d.img)}" alt="" onerror="this.style.display='none'">` : ''}
              <span class="flip-name">${esc(d.name)}${d.count > 1 ? ` &times;${d.count}` : ''}</span>
            </div>
            ${rarityFaceHtml(d.rarity)}
          </div>
        </div>`);
      card.style.setProperty('--win', rarityVar(d.rarity));
      grid.appendChild(card);
      return { card, drop: d };
    });

    stage.appendChild(grid);
    host.innerHTML = '';
    host.appendChild(stage);

    return (async () => {
      // hodne karet = svizneji, at to neni na dlouhe lokty
      const step = Motion.t(drops.length > 20 ? 55 : drops.length > 12 ? 85 : 120);

      Sfx.chargeUp(Motion.t(450) / 1000);
      await wait(skipRequested ? 0 : Motion.t(450));

      // --- 1) otoceni: zatim je videt jen rarita ---
      for (const { card, drop } of cards) {
        card.classList.add('is-open');
        const r = rank(drop.rarity);
        Sfx.flip(r);
        if (r >= 1) {
          card.classList.add('is-rare');
          Sfx.land(drop.rarity, 0.35);
          await wait(skipRequested ? 0 : step + Motion.t(150));
        } else {
          await wait(skipRequested ? 0 : step);
        }
      }
      await wait(skipRequested ? 0 : Motion.t(550));

      // --- 2) odhaleni: bezne vsechny jednou vlnou, vzacne pak kazda zvlast ---
      // Rozestup vlny resi CSS (--ud), ne cekani v JS - jinak kazda karta narazi
      // na minimum v Motion.t() a u dvaceti obycejnych veci se to vleče.
      const commons = cards.filter((c) => rank(c.drop.rarity) === 0);
      const rares = cards.filter((c) => rank(c.drop.rarity) >= 1)
        .sort((a, b) => rank(a.drop.rarity) - rank(b.drop.rarity));   // nejlepsi posledni

      if (commons.length) {
        commons.forEach((c, i) => {
          c.card.style.setProperty('--ud', `${Math.min(i * 45, 700)}ms`);
          c.card.classList.add('is-unveiled');
        });
        Sfx.unveil(0);
        await wait(skipRequested ? 0 : Motion.t(420 + Math.min(commons.length * 45, 700)));
      }
      for (const c of rares) {
        c.card.classList.add('is-unveiled');
        const r = rank(c.drop.rarity);
        Sfx.unveil(r);
        shards(c.card, c.drop.rarity, 10 + r * 3, 90);
        await wait(skipRequested ? 0 : Motion.t(420 + r * 60));
      }

      // nejlepsi kus si na zaver rekne o pozornost
      const top = cards.find((c) => c.drop === best);
      if (top) {
        top.card.classList.add('is-top');
        stage.classList.add('is-hit');
        shards(top.card, best.rarity, 22, 150);
        Sfx.land(best.rarity, 1);
        setTimeout(() => stage.classList.remove('is-hit'), 460);
      }
      await wait(skipRequested ? 60 : Motion.t(620));
    })();
  }

  // ======================================================================
  //  OBRAD ODEMKNUTI
  // ======================================================================

  /**
   * Zadna ruleta - tady uz vis, co dostanes. Shard se sbali do hextech jadra,
   * to praskne a zustane po nem permanent v ramu.
   */
  function unlock(drop, host) {
    skipRequested = false;
    const rarity = drop.rarity || 'DEFAULT';

    const stage = makeEl('unlock-stage', `
      <div class="cine-glow"></div>
      <div class="unlock-rings"><i></i><i></i><i></i></div>
      <div class="unlock-motes"></div>
      <div class="unlock-card">
        ${drop.img ? `<img src="${esc(drop.img)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="unlock-sheen"></div>
        <div class="unlock-frame"><i></i><i></i><i></i><i></i></div>
      </div>
      <div class="unlock-shock"></div>
      <div class="unlock-flash"></div>
      <div class="unlock-label">ODEMYKANI</div>`);
    stage.style.setProperty('--win', rarityVar(rarity));

    host.innerHTML = '';
    host.appendChild(stage);

    const motes = stage.querySelector('.unlock-motes');
    const label = stage.querySelector('.unlock-label');

    for (let i = 0; i < 28; i++) {
      const m = document.createElement('i');
      const angle = (Math.PI * 2 * i) / 28 + Math.random() * 0.6;
      const dist = 240 + Math.random() * 260;
      m.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      m.style.setProperty('--dy', `${Math.sin(angle) * dist * 0.6}px`);
      m.style.animationDelay = `${Math.random() * 700}ms`;
      motes.appendChild(m);
    }

    return (async () => {
      stage.classList.add('phase-charge');
      Sfx.unlockCharge(Motion.t(1600) / 1000);
      await wait(skipRequested ? 0 : Motion.t(1600));

      stage.classList.remove('phase-charge');
      stage.classList.add('phase-burst');
      Sfx.unlockBurst(rarity);
      shards(stage, rarity, 36, 300);
      await wait(skipRequested ? 0 : Motion.t(260));

      stage.classList.remove('phase-burst');
      stage.classList.add('phase-open');
      label.textContent = 'ODEMCENO NATRVALO';
      label.classList.add('is-final');
      await wait(skipRequested ? 60 : Motion.t(1100));
    })();
  }

  // ======================================================================
  //  REROLL
  // ======================================================================

  /**
   * Tri shardy se polozi na oltar, roztoci se ve viru, zhrouti se do jadra
   * a z portalu, ve kterem se mihaji skiny, vypadne jeden novy.
   *
   * Na rozdil od odemykani se tu opravdu losuje, takze napeti v portalu je
   * na miste. Barva rarity vysledku (--win) se proto nastavi az v rozkvetu -
   * driv by ji prozradila zare za scenou.
   */
  function reroll(offered, result, pool, host) {
    skipRequested = false;
    const rarity = result.rarity || 'DEFAULT';
    const vp = viewport();

    const stage = makeEl('rr-stage', `
      <div class="cine-glow"></div>
      <div class="rr-rays"></div>
      <div class="rr-rune"></div>
      <div class="rr-rune rr-rune-2"></div>
      <div class="rr-core"></div>
      <div class="rr-portal"><img alt=""><div class="rr-portal-sheen"></div></div>
      <div class="rr-shock"></div>
      <div class="rr-flash"></div>
      <div class="rr-label">REROLL</div>`);
    stage.style.setProperty('--win', 'var(--gold)');

    const cards = offered.slice(0, 3).map((d) => {
      const c = makeEl(`rr-card rare-${d.rarity || 'DEFAULT'}`, `
        ${d.img ? `<img src="${esc(d.img)}" alt="" onerror="this.style.display='none'">` : ''}
        <span class="rr-card-name">${esc(d.name)}</span>`);
      stage.appendChild(c);
      return c;
    });

    host.innerHTML = '';
    host.appendChild(stage);

    const portal = stage.querySelector('.rr-portal');
    const portalImg = portal.querySelector('img');
    const label = stage.querySelector('.rr-label');

    // co se bude mihat v portalu: nahodne kusy z vyplne, na konci vysledek
    const frames = [];
    const src = (pool || []).filter((x) => x && x.img);
    let last = -1;
    const FLICKS = Motion.fast ? 8 : 21;   // v rychlem rezimu min snimku, ne jen kratsi
    for (let k = 0; k < FLICKS && src.length; k++) {
      let idx = Math.floor(Math.random() * src.length);
      if (src.length > 1 && idx === last) idx = (idx + 1) % src.length;
      last = idx;
      frames.push(src[idx]);
    }
    frames.push(result);
    // nacist predem, jinak by rychle mihani ukazovalo prazdna okna
    if (typeof Image === 'function') {
      frames.forEach((f) => { if (f.img) { const im = new Image(); im.src = f.img; } });
    }

    const R = clamp(Math.min(vp.w, vp.h) * 0.26, 140, 280);
    const base = [-90, 30, 150].map((a) => (a * Math.PI) / 180);

    const place = (c, x, y, scale, rot, blur, opacity) => {
      c.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rot}deg) scale(${scale})`;
      c.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
      c.style.opacity = String(opacity);
    };

    return (async () => {
      // --- 1) oltar: shardy vyleti zespodu a zapadnou do trojuhelniku ---
      stage.classList.add('phase-offer');
      cards.forEach((c, i) => place(c, Math.cos(base[i]) * R, Math.sin(base[i]) * R + 320, 0.55, 0, 0, 0));
      for (let i = 0; i < cards.length; i++) {
        await wait(Motion.t(i ? 260 : 140));
        cards[i].classList.add('is-placed');
        place(cards[i], Math.cos(base[i]) * R, Math.sin(base[i]) * R, 1, 0, 0, 1);
        Sfx.rrPlace(i);
      }
      await wait(Motion.t(700));

      // --- 2) vir: krouzi, zrychluji, stahuji se do stredu ---
      stage.classList.remove('phase-offer');
      stage.classList.add('phase-vortex');
      cards.forEach((c) => c.classList.add('is-orbiting'));
      const VORTEX = Motion.t(1900);
      Sfx.rrVortex(VORTEX / 1000);

      await new Promise((resolve) => {
        const t0 = performance.now();
        function frame(now) {
          const t = skipRequested ? 1 : clamp((now - t0) / VORTEX, 0, 1);
          const turn = 5.5 * Math.PI * 2 * Math.pow(t, 2.3);
          const r = R * (1 - Math.pow(t, 1.7));
          cards.forEach((c, i) => {
            const a = base[i] + turn;
            place(c, Math.cos(a) * r, Math.sin(a) * r,
              1 - 0.8 * Math.pow(t, 1.4),
              turn * 57.3 * 0.12,
              7 * t * t,
              1 - 0.75 * Math.pow(t, 3));
          });
          stage.style.setProperty('--charge', t.toFixed(3));
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        }
        frame(performance.now());
      });

      // --- 3) zhrouceni ---
      cards.forEach((c) => c.remove());
      stage.classList.remove('phase-vortex');
      stage.classList.add('phase-implode');
      Sfx.rrImplode();
      shards(stage, 'GOLD', 30, 260);
      await wait(Motion.t(420));

      // --- 4) portal: skiny se mihaji a zpomaluji ---
      stage.classList.remove('phase-implode');
      stage.classList.add('phase-portal');
      for (let k = 0; k < frames.length; k++) {
        if (skipRequested) break;
        const f = frames[k];
        const p = frames.length > 1 ? k / (frames.length - 1) : 1;
        portalImg.src = f.img || '';
        portal.style.setProperty('--flick', rarityVar(f.rarity));
        if (p > 0.8) portal.classList.add('is-closing');
        Sfx.rrFlick(p);
        if (k === frames.length - 1) break;
        await wait(Motion.t(Math.round(40 + 300 * Math.pow(p, 2.6))));
      }
      portalImg.src = result.img || '';

      // --- 5) rozkvet: az ted se prozradi rarita ---
      stage.style.setProperty('--win', rarityVar(rarity));
      stage.classList.remove('phase-portal');
      stage.classList.add('phase-bloom');
      if (rank(rarity) >= 2) stage.classList.add('is-big');
      label.textContent = 'NOVY SKIN';
      label.classList.add('is-final');
      Sfx.land(rarity, 1);
      shards(stage, rarity, rank(rarity) >= 2 ? 46 : 30, 340);
      await wait(skipRequested ? 60 : Motion.t(1300));
    })();
  }

  function skip() { skipRequested = true; }

  /** Cedule s hlavni vyhrou. */
  function bannerHtml(drop, extra) {
    const rarity = drop.rarity || 'DEFAULT';
    return `<div class="reel-banner rare-${rarity}" style="--win:${rarityVar(rarity)}">
      <span class="reel-rarity">${RARITY_LABEL[rarity] || 'ZISK'}</span>
      <span class="reel-win-name">${esc(drop.name)}${drop.count > 1 ? ` &times;${drop.count}` : ''}</span>
      ${extra ? `<span class="reel-sub">${esc(extra)}</span>` : ''}
      <span class="reel-flourish"></span>
    </div>`;
  }

  return { play, playMulti, cascade, unlock, reroll, skip, bannerHtml, rarityFaceHtml, GEM, rank, Sfx, Motion, MAX_ROWS };
})();
