# Hextech Gamba

Vlastní appka na otevírání beden v League of Legends. Připojí se k **běžícímu
League klientovi**, ukáže tvůj skutečný loot a umí ho hromadně otevřít, rozložit,
odemknout nebo rerollnout — s pořádnou reveal animací místo klientského klikání
kus po kusu.

Žádný build, žádné závislosti, žádný Riot API klíč. Jen Node a prohlížeč.

## Spuštění

1. Spusť **League klienta** (stačí přihlášený, nemusíš být ve hře).
2. Dvojklik na `start.cmd` — nebo v terminálu `node server.js`.
3. Otevře se `http://127.0.0.1:4545`.

Klient můžeš spustit i až potom, appka se připojí sama. Když je port obsazený
(typicky už jedna instance běží), server to rovnou napíše.

### Ovládání

| | |
|---|---|
| `Esc` / `mezerník` | během animace ji přeskočí, po dojetí zavře odhalení |
| kolečko myši | pod otevřeným odhalením se pozadí neposouvá |
| klik na tmavé pozadí | zavře odhalení nebo detail |
| `Enter` / `Esc` | potvrdí / zruší potvrzovací okno |
| `Esc` v režimu rerollu | vypne režim rerollu |
| tlačítko **Rychle** | zkrácené animace pro hromadné otevírání |
| tlačítko **Zvuk** | umlčí zvuk |

Appka respektuje systémové nastavení **omezení pohybu** — když ho máš zapnuté,
naběhne rovnou v rychlém režimu a vypnou se zážehy a otřesy.

## Co to umí

| | |
|---|---|
| **Bedny** | Otevře jednu, všechny stejného druhu, nebo úplně všechno jedním klikem. Hlídá, kolik máš klíčů. Z fragmentů umí ukovat klíče. |
| **Skin shardy** | Rozložit na oranžovou esenci, odemknout napermanent. Filtr „jen ty, co už vlastním". |
| **Reroll** | Tlačítko *Reroll* v tabu skinů otevře zásobník se třemi sloty. Naklikáš tři shardy (nebo *Navrhnout 3* vybere nejlevnější, duplikáty mají přednost) a dostaneš za ně jeden náhodný skin natrvalo. |
| **Champion shardy** | Oddělené skupiny *Shardy* a *Permanenty*, ať je jasné, co ještě jde odemknout a co už máš. |
| **Testovací bedna** | Simulace pro ladění reveal animace. Losuje ze skutečných dat klienta (reálné skiny, artwork, rarity), ale **nic neposílá** — žádný craft, žádná esence, žádný zápis do statistik. |
| **Celoobrazovkové odhalení** | Napřed uvidíš jen raritu (oficiální drahokam a barva jako v LoLku), teprve pak, co to je. Když padne víc věcí, na konci dostaneš souhrn všeho. |
| **Označení vlastněných** | Shardy věcí, které už máš, mají zelenou pásku *VLASTNIS* a ztlumený obrázek — duplikáty na rozložení nebo reroll poznáš na první pohled. |
| **Obřad odemknutí** | Odemykání shardu nic netočí — víš přece, co dostaneš. Místo toho se kolem karty stáhnou hextech prstence, slétnou se jiskry, jádro praskne a zůstane po něm permanent ve zlatém rámu. |
| **Živé aktualizace** | Otevřeš bednu přímo v klientovi a appka se přepíše sama — nemusíš mačkat *Obnovit*. |
| **Detail skinu** | Klikni na skin shard a otevře se celý splash art. Tlačítkem *Video prohlídka* si pustíš detailní prohlídku skinu od SkinSpotlights (YouTube) přímo v appce. Pod tím jsou všechny skiny, které na toho šampiona už máš — kliknutím uvidíš jejich splash. Rozložit nebo odemknout jde rovnou z detailu. Hromadný výběr je na kolečku v rohu karty. |
| **Skiny na šampiona** | U skin shardů i na kartách („3 skiny na šampiona“), před odemknutím a když ti skin padne. |
| **Mythic shop** | Aktuální rotace (featured, dvoutýdenní, týdenní, denní) s obrázky, drahokamem rarity a odpočtem do konce. Nákup za mythic esenci s potvrzením; appka počká, jestli nákup opravdu prošel. |
| **Session** | Kolik beden padlo, co z nich vypadlo, nejlepší drop. Historie žije v `localStorage`, na účet nemá vliv. |

Nevratné akce (rozložit, odemknout, reroll) vždycky projdou potvrzovacím oknem
s vyčíslením, o co přijdeš. Otevření bedny se nepotvrzuje — to je smysl appky.

### Animace

Odhalení běží přes **celou obrazovku** a režim se vybírá podle toho, kolik toho
padlo — protože otevřít jednu bednu a otevřít deset jsou dvě různé situace:

| Padlo | Co uvidíš |
|---|---|
| **1 věc** | Jedna velká ruleta přes celou šířku. Pás je poskládaný z karet rarit — dojede na raritu, chvíli počká a pak se karta rozprskne a ukáže, co to je. |
| **2–5 věcí** | Tolik pásů nad sebou. Rozjedou se naráz, ale **každý dojede o kousek později** — takže napětí neskončí prvním dojezdem. |
| **6+ věcí** | Kaskáda: karty se otočí na raritu, pak se běžné odkryjí jednou vlnou a vzácné každá zvlášť, nejlepší nakonec. |
| **2+ věcí** | Po animaci souhrn *Co ti padlo*: sloučené, sečtené podle druhu a seřazené od nejvzácnější. |
| **odemknutí** | Obřad, nic se netočí — výsledek je předem jasný. |
| **reroll** | Tři shardy se položí na oltář, roztočí se ve víru, zhroutí do jádra a z glitchujícího portálu vypadne nový skin. |

Odhalení se neotevírá jako obyčejný popup: nejdřív se přes obrazovku rozjede
zlatá linka, ta se rozevře na dvě desky a mezi nimi vyplave obsah. Zavírá se
stejnou cestou zpátky. Během té vteřiny stejně běží craft, takže se pod animací
schová čekání na klienta.

Rozmazání pásu se počítá z okamžité rychlosti, poslední vteřinu se rám obarví
do rarity toho, co se blíží, a dopad znamená náraz obrazu, zážeh, rázovou vlnu
a střepy. Ostatní dlaždice zšednou, aby zůstala jen výhra.

**Obřad odemknutí** má karta scvrklou a rozklepanou, kolem ní se stahují hextech
prstence, slétnou se jiskry, jádro praskne a permanent se rozvine do plné
velikosti se světelným přejezdem a zlatými rohy.

**Reroll** je nejdelší ze všech (~7,5 s), protože tady se opravdu losuje: tři
vybrané shardy vyletí zespodu a zapadnou do trojúhelníku, pak kolem jádra krouží
čím dál rychleji, rozmazávají se a stahují, až se se zábleskem zhroutí. Z jádra
se otevře portál, ve kterém se míhají skiny — rozbité barevné kanály, cukání,
rámeček bliká barvami rarit — a postupně zpomaluje. Barva rarity výsledku se
schválně nikde neobjeví dřív než v rozkvětu, kdy se portál rozvine do plné
velikosti a za ním se roztočí paprsky.

Hromadné rozkládání a kování klíčů animaci nemá — tam není co dramatizovat,
karty se jen vysypou. *Přeskočit animaci* utne cokoliv okamžitě, *Zvuk* umlčí
zvuk (volba se pamatuje).

Zvuk je celý syntetizovaný WebAudiem, žádné mp3: tikání je filtrovaný šum, který
se s klesající rychlostí prohlubuje a těžkne, pod jízdou duní bas řízený
rychlostí pásu, a dopad je akord podle rarity — čím vzácnější, tím víc tónů,
delší dozvuk a navrch třpytky. U více pásů dostane plnou ránu ten poslední,
ostatní jen cvaknou.

### Testovací bedna

V tabu Bedny je vždycky dole karta s fialovým čárkovaným rámečkem a odznakem
`SIMULACE`. Otevře 1 / 5 / 10 kusů nebo rovnou „Jackpot" (vynutí vzácný skin, ať
si vyzkoušíš glow u epic/legendary/mythic). Odměny se losují v prohlížeči
z `champion-summary.json` a per-champion dat, takže reveal vypadá přesně jako
ostrý — jen se nikde nic nestalo. Do „Otevřít vše" se nepočítá.

Kromě bedny přibydou v tabech Skiny a Šampioni i **testovací shardy** (3 skin +
1 champion, taky s odznakem `SIMULACE`). Jdou rozložit, odemknout i rerollnout
a projdou přitom úplně stejným kódem jako ostré položky — potvrzovací okno,
výběr, actionbar, ruleta. Odbočí se až v `craft()`, kde se místo requestu na
klienta vrátí simulovaná odpověď. Míchat testovací a ostré položky v jedné akci
appka odmítne.

Chceš jiné pomery dropů? Přepiš `DROP_TABLE` v `public/simulator.js`.

## Jak to funguje

```
prohlížeč  ──/lcu/*──>  server.js  ──https + Basic auth──>  LeagueClientUx (LCU)
                            │
                            └── najde port a token z běžícího procesu klienta
```

Prohlížeč se k LCU nedostane sám: běží na náhodném portu, má self-signed
certifikát a chce Basic auth s tokenem, který zná jen klient. `server.js` proto
credentials najde (příkazová řádka procesu `LeagueClientUx.exe`, fallback
`lockfile`), drží si je a proxuje `/lcu/*` dál. Obrázky skinů jdou stejnou
cestou (včetně originálních ikon esencí a klíčů), takže appka funguje i bez
internetu.

**Loot se hlídá sám.** Prohlížeč drží otevřený SSE kanál na `/api/events` a
server mu hlásí, když se inventář v klientovi změnil (porovnává otisk každé dvě
vteřiny). Otevřeš bednu v klientovi a appka se překreslí. *Obnovit* zůstalo pro
jistotu, ale běžně ho nepotřebuješ.

**Obrázky se cachují.** LCU u nich posílá `no-cache`, takže by je prohlížeč
revalidoval při každém roztočení rulety — a ta staví 58 dlaždic na pás. Proxy
u `/lol-game-data/assets/*` hlavičku přepíše; ty soubory se mezi patchi nemění.

**Recepty si nevymýšlíme.** Co s čím jde udělat, se tahá z
`/lol-loot/v1/recipes/initial-item/{lootId}` — z odpovědi plyne typ akce
(`OPEN`, `FORGE`, `DISENCHANT`, `UPGRADE`, `REROLL`) i sloty se surovinami.
Díky tomu appka zvládne i bedny a kapsle, které Riot přidá až později, aniž by
se do ní muselo sahat.

Dvě pasti, na které se naráží. **Endpoint vrací všechny recepty, kde se položka
kdekoliv objeví** — u klíče tedy všechny bedny světa. Proto `recipeAppliesTo()`
nechá jen ty, kde je položka hlavní surovinou; bez toho se klíče tváří jako bedny.
A **klient nechá `slot.lootIds` prázdné**, když do
slotu nic z inventáře nesedí (typicky slot na samotnou bednu). V tom případě do
něj patří právě ta položka, na kterou hráč kliknul — řeší to `slotIds()`
v `public/app.js`.

## Testy

```
node tests/run.js
```

Bez závislostí, jeden příkaz. Testy nikdy nic neposílají na účet — všechny
zápisy jsou v nich zablokované. Ty, které potřebují přihlášeného klienta, se
bez něj přeskočí.

## Struktura

```
server.js        discovery credentials + proxy na LCU + statické soubory (0 závislostí)
start.cmd        dvojklik launcher
public/
  index.html     kostra UI
  app.css        hextech vzhled, rarity barvy, animace
  app.js         načítání lootu, recepty, crafting, reveal, session log
  simulator.js   testovací bedna a shardy (simulace, nesahá na účet)
  reel.js        hextech ruleta, obřad odemknutí a syntetizovaný zvuk
  reel.css       vzhled animací
tests/
  run.js         spustí všechny testy
  harness.js     napodobenina prohlížeče, zablokovaný zápis
  *.test.js      jednotlivé oblasti
```

## Poznámky

- Appka posílá klientovi přesně ty samé craft requesty jako jeho vlastní UI
  (`POST /lol-loot/v1/recipes/{recipe}/craft?repeat=N`). Nic neinjektuje, nečte
  paměť, nesahá na soubory hry — je to jen jiný front-end nad LCU.
- Mezi hromadnými crafty je krátká pauza, ať klient stíhá. Nezvyšuj ji na nulu.
- Všechno běží na `127.0.0.1`. Server neposlouchá navenek a token nikam neodchází.
- Server přijme zápis **jen od vlastní stránky**. Jiná webová stránka otevřená
  v prohlížeči se k proxy nedostane — kontroluje se `Host`, `Origin` a typ obsahu.
- Neoficiální API. Riot ho může kdykoliv změnit; když se něco rozbije, podívej
  se, co reálně vrací `/lol-loot/v1/player-loot` a `.../recipes/initial-item/…`.
