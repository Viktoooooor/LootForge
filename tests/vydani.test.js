'use strict';

/*
 * Pripravenost na verejne vydani. Staticke kontroly bezi vzdycky, zbytek jen
 * s klientem:
 *  - zadny stary nazev a zadna cestina v UI, disclaimer Riotu, licence, verze
 *  - server nestahuje YouTube a jiny externi dotaz nez YouTube Data API neni
 *  - testovaci polozky jsou ve vychozim stavu vypnute, uvodni upozorneni se ukaze
 */

const fs = require('fs');
const path = require('path');
const { createEnv, clientStatus, suite, sleep, PUBLIC, ROOT } = require('./harness');

const t = suite('vydani');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  t.section('nazev a texty');
  const html = read('public/index.html');
  const app = read('public/app.js');
  const pkg = JSON.parse(read('package.json'));
  const ui = html + app + read('public/reel.js') + read('public/simulator.js') + read('server.js');
  // komentare pryc - v nich cestina zustava
  const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).map((l) => l.replace(/(^|\s)\/\/ .*$/, '')).join('\n');

  t.ok(!/gamba/i.test(code.replace(/lootforge|'gamba\.' \+ k/gi, '')), 'stary nazev "Gamba" nikde v UI (krome prevodu ulozenych dat)');
  t.ok(!/hextech\s*gamba|HEXTECH<em>/i.test(code), 'nazev "Hextech" neni znacka appky');
  t.ok(/<title>LootForge<\/title>/.test(html) && /LOOT<em>FORGE<\/em>/.test(html), 'titulek a logo LootForge');
  const czech = code.match(/['"`>][^'"`<]*\b(esence|bedn[aey]|sampion|rozloz|odemk|odemcen|natrvalo|novy skin|vlastnis|nacitam|zadn[ya]|prazdn|klient nebezi|potvrd|zrusit|obnovit|uklid|kolekce|statistiky|rotace|neznama|polozk)\w*/gi) || [];
  t.ok(czech.length === 0, czech.length ? `cestina v UI: ${czech.slice(0, 5).join(' | ')}` : 'zadna cestina v textech UI');
  t.ok(!/[ěščřžýáíéůúňťď]/i.test(code), 'zadna diakritika v kodu UI');
  const cssTexts = ['public/app.css', 'public/reel.css']
    .flatMap((f) => [...read(f).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/content:\s*(['"])([^'"]+)\1/g)].map((m) => m[2]));
  const czechCss = cssTexts.filter((txt) => /[ěščřžýáíéůúňťď]|tenhle|vyndat|vlastn|odebrat|zrusit/i.test(txt));
  t.ok(cssTexts.length > 0 && czechCss.length === 0, czechCss.length ? `cestina v CSS content: ${czechCss.join(', ')}` : `texty v CSS anglicky (${cssTexts.join(', ')})`);
  t.ok(!/'cs-CZ'|, 'cs'\)/.test(app), 'cisla a razeni v anglicke lokalizaci');
  t.ok(/lang="en"/.test(html), 'html lang="en"');

  t.section('pravni nalezitosti');
  const disclaimer = /isn't endorsed by Riot Games and doesn't\s+reflect the views or opinions of Riot Games/;
  const jibber = /created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games/;
  t.ok(disclaimer.test(html) && jibber.test(html), 'paticka appky: disclaimer Riot Games');
  const readme = read('README.md');
  t.ok(disclaimer.test(readme.replace(/\s+/g, ' ')) && jibber.test(readme.replace(/\s+/g, ' ')), 'README: disclaimer Riot Games');
  t.ok(fs.existsSync(path.join(ROOT, 'LICENSE')) && /MIT License/.test(read('LICENSE')) && pkg.license === 'MIT', 'MIT licence (LICENSE + package.json)');
  t.ok(html.includes(`v${pkg.version}</span>`), `verze v paticce sedi s package.json (${pkg.version})`);
  t.ok(/<ul>[\s\S]*Everything is real[\s\S]*Use at your own risk/.test(html), 'uvodni upozorneni: vse je ostre, neoficialni API');

  t.section('sit a soukromi');
  const server = read('server.js');
  t.ok(!/youtube|spotlight/i.test(server), 'server nestahuje YouTube');
  t.ok(/server\.listen\(PORT, '127\.0\.0\.1'/.test(server), 'server posloucha jen na 127.0.0.1');
  const hosts = [...new Set((code.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map((u) => u.toLowerCase()))];
  const allowed = ['http://127.0.0.1', 'http://localhost', 'https://api.github.com', 'https://github.com', 'https://www.googleapis.com', 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://developers.google.com'];
  t.ok(hosts.every((h) => allowed.includes(h)), `externi adresy v UI jen YouTube/Google: ${hosts.join(', ')}`);
  t.ok(!/fetch\(\s*['"`]https:\/\/(?!www\.googleapis\.com|api\.github\.com)/.test(app), 'externi fetch jen YouTube Data API a GitHub releases');
  const fetches = app.match(/fetch\(\s*['"`]https:\/\/[^'"`]+/g) || [];
  t.ok(fetches.length === 2, `presne dva externi dotazy v app.js (${fetches.length})`);
  t.ok(/path\.join\('C:', path\.sep, 'Riot Games'/.test(server), 'cesta k lockfile bez rozbitych zpetnych lomitek');
  const lock = server.match(/const LOCKFILES = \[[\s\S]*?\];/);
  t.ok(lock && !/'[A-Z]:\\[^\\]/.test(lock[0]), 'zadny retezec "C:\\Riot..." (\\R neni escape)');

  t.section('spousteni');
  const cmd = read('start.cmd');
  t.ok(/where node/.test(cmd) && /nodejs\.org/.test(cmd), 'start.cmd poradi, kdyz chybi Node.js');
  t.ok(/OPEN_BROWSER=1/.test(cmd) && /OPEN_BROWSER/.test(server), 'prohlizec otevre server az po spusteni (ne naslepo predem)');
  t.ok(pkg.engines && /18/.test(pkg.engines.node) && pkg.scripts.start && pkg.scripts.test, 'package.json: engines, start, test');
  t.ok(!pkg.dependencies && !pkg.devDependencies, 'nula zavislosti');

  t.section('vydani: exe, changelog, repo');
  t.ok(pkg.scripts.build && fs.existsSync(path.join(ROOT, 'scripts', 'build-exe.js')), 'npm run build postavi exe');
  t.ok(/^dist\/\s*$/m.test(read('.gitignore')), 'dist/ neni v gitu');
  const changelog = read('CHANGELOG.md');
  t.ok(new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}`, 'm').test(changelog), `CHANGELOG ma zaznam pro ${pkg.version} s datem`);
  t.ok(/sea\.getAsset/.test(server) && /readAppFile\('package\.json'\)/.test(server) && !/=\s*require\('\.\/package\.json'\)/.test(server),
    'server umi bezet jako exe (soubory z node:sea, ne require)');
  const repoUrl = String((pkg.repository && pkg.repository.url) || '');
  if (/YOUR-GITHUB-NAME/.test(repoUrl) || /YOUR-GITHUB-NAME/.test(changelog)) {
    t.info('POZOR: v package.json / CHANGELOG je zastupne repo YOUR-GITHUB-NAME - kontrola verze je vypnuta. Pred vydanim doplnit.');
  } else {
    t.ok(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl), `repo pro kontrolu verze: ${repoUrl}`);
  }
  t.ok(/c\.id < 1000/.test(read('public/simulator.js')), 'simulator nelosuje Jade sampiony (id 60001+)');

  const status = await clientStatus();
  if (!status.client) t.skip('zbytek potrebuje bezici server a prihlaseneho klienta');

  t.section('vychozi stav pro noveho hrace');
  const env = createEnv({ testItems: false });
  delete env.mem['lootforge.welcome'];
  delete env.mem['lootforge.testItems'];
  const lf = env.load(['reel.js', 'simulator.js', 'app.js'], ['state', 'loadLoot', 'loadShop', 'setTestItems', 'acceptWelcome', 'isNewerVersion', 'checkForUpdates']);
  const $ = env.pick;
  await sleep(50);
  t.ok(!$('#welcome').hidden, 'prvni spusteni: uvodni upozorneni');
  env.press('Escape');
  t.ok(!$('#welcome').hidden, 'Esc ho neodmackne - chce vedome potvrzeni');
  lf.acceptWelcome();
  t.ok($('#welcome').hidden && env.mem['lootforge.welcome'] === '1', 'po potvrzeni se uz neukaze');

  await lf.loadLoot();
  t.ok(!lf.state.items.some((i) => i.isTest), 'testovaci polozky ve vychozim stavu nejsou');
  await lf.loadShop();
  t.ok(!lf.state.shop.stores.some((s) => s.isTest), 'ani testovaci nabidka v obchode');
  await lf.setTestItems(true);
  t.ok(lf.state.items.filter((i) => i.isTest).length === 5, 'zapnuti v nastaveni: 5 testovacich polozek');
  await lf.setTestItems(false);
  t.ok(!lf.state.items.some((i) => i.isTest), 'vypnuti je hned odebere');
  t.ok(env.posts.length === 0, 'nic se nezapsalo');

  t.section('testovaci shardy');
  const rolled = await TestChest.roll(30, true);
  const skinIds = rolled.map((d) => Number((/(\d+)$/.exec(d.lootId) || [])[1]));
  t.ok(skinIds.every((id) => id > 1000 && Math.floor(id / 1000) < 1000), `30 vzacnych skinu, zadny Jade (${skinIds.filter((id) => id >= 1000000).length})`);

  t.section('kontrola nove verze');
  const cases = [['1.0.1', '1.0.0', true], ['v1.10.0', '1.9.9', true], ['1.0.0', '1.0.0', false], ['0.9.0', '1.0.0', false], ['2.0.0-beta', '1.5.0', true]];
  t.ok(cases.every(([a, b, want]) => lf.isNewerVersion(a, b) === want), 'porovnani verzi (1.10 > 1.9, v na zacatku)');

  const realFetch = global.fetch;
  const ghCalls = [];
  let release = { tag_name: 'v1.2.0', html_url: 'https://github.com/someone/LootForge/releases/tag/v1.2.0' };
  global.fetch = (url, init) => {
    if (String(url).startsWith('https://api.github.com/')) { ghCalls.push(String(url)); return Promise.resolve({ ok: true, status: 200, json: async () => release }); }
    return realFetch(url, init);
  };
  lf.state.app = { version: '1.0.0', repo: null };
  t.ok(await lf.checkForUpdates() === null && ghCalls.length === 0, 'bez skutecneho repa se nic nekontroluje');

  lf.state.app = { version: '1.0.0', repo: 'someone/LootForge' };
  await lf.checkForUpdates();
  t.ok(ghCalls[0] === 'https://api.github.com/repos/someone/LootForge/releases/latest', 'ptame se GitHubu na posledni release');
  t.ok(!$('#update').hidden && $('#update').textContent === 'v1.2.0 available' && $('#update').href === release.html_url, 'nova verze: odkaz nahore v liste');
  await lf.checkForUpdates();
  t.ok(ghCalls.length === 1, 'do 12 hodin z pameti - GitHub se neotravuje');

  release = { tag_name: 'v1.3.0', html_url: 'https://evil.example/LootForge.exe' };
  await lf.checkForUpdates(true);
  t.ok($('#update').href === 'https://github.com/someone/LootForge/releases/latest', 'odkaz mimo vlastni repo se nahradi strankou releasu');

  release = { tag_name: 'v1.0.0', html_url: 'https://github.com/someone/LootForge/releases/tag/v1.0.0' };
  await lf.checkForUpdates(true);
  t.ok($('#update').hidden, 'stejna verze: nic se neukaze');

  delete env.mem['lootforge.update'];
  env.mem['lootforge.updates'] = '0';
  const before = ghCalls.length;
  await lf.checkForUpdates();
  t.ok(ghCalls.length === before, 'vypnuto v Nastaveni: zadny dotaz');
  global.fetch = realFetch;

  t.section('prevod dat ze stare verze');
  const env2 = createEnv();
  env2.mem['gamba.stats'] = JSON.stringify({ opened: 42, disenchanted: 7 });
  env2.mem['gamba.history'] = '[]';
  delete env2.mem['lootforge.mute'];
  env2.mem['gamba.mute'] = '0';
  const lf2 = env2.load(['reel.js', 'simulator.js', 'app.js'], ['readStats']);
  t.ok(lf2.readStats().opened === 42 && env2.mem['lootforge.mute'] === '0', 'statistiky a nastaveni z "gamba.*" se prenesly');

  await sleep(50);
  t.done();
})().catch(t.crash);
