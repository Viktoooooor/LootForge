/* The test chest - PURE SIMULATION.
 *
 * It never touches the account. It sends no craft, opens nothing and spends
 * nothing. It exists to work on the reveal animation when there is nothing real
 * to open.
 *
 * The rewards are rolled from real client data (skins, champions, their artwork
 * and rarities), so the reveal looks exactly like the real thing - except that
 * nothing happened.
 */

'use strict';

globalThis.TestChest = (function () {

  const LOOT_ID = 'TEST_CHEST';

  // A simplified drop table. These are not official Riot odds, just a reasonable
  // a guess, so the simulation feels alive. Want different odds? Change the weights here.
  const DROP_TABLE = [
    { weight: 50, kind: 'skin' },
    { weight: 25, kind: 'champion' },
    { weight: 10, kind: 'keyFragment' },
    { weight:  9, kind: 'blueEssence' },
    { weight:  5, kind: 'orangeEssence' },
    { weight:  1, kind: 'mythicEssence' },
  ];

  const RARITY = {
    kNoRarity: 'DEFAULT', kRare: 'DEFAULT', kEpic: 'EPIC',
    kLegendary: 'LEGENDARY', kMythic: 'MYTHIC', kUltimate: 'ULTIMATE',
    kTranscendent: 'TRANSCENDENT', kExalted: 'EXALTED',
  };

  const ART = '/lcu/lol-game-data/assets/ASSETS/Loot/';

  let champions = null;              // the list from champion-summary.json
  const champCache = new Map();      // id -> details with the skins

  // --- data from the client ---------------------------------------------

  async function get(path) {
    const res = await fetch('/lcu' + path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function loadChampions() {
    if (champions) return champions;
    const all = await get('/lol-game-data/assets/v1/champion-summary.json');
    // League champions only (id below 1000). The list also holds "Jade" versions
    // (Jade_Veigar 60045) from another Riot product - their skins have different ids,
    // so neither the player's skins nor the full artwork would be found for them.
    champions = all.filter((c) => c.id > 0 && c.id < 1000);
    return champions;
  }

  async function champDetail(id) {
    if (!champCache.has(id)) champCache.set(id, await get(`/lol-game-data/assets/v1/champions/${id}.json`));
    return champCache.get(id);
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const between = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  // --- the individual kinds of reward -----------------------------------

  async function rollSkin(onlyRare) {
    // a few tries: not every champion has a legendary, let alone an ultimate skin
    for (let tries = 0; tries < (onlyRare ? 14 : 4); tries++) {
      const champ = pick(await loadChampions());
      const detail = await champDetail(champ.id);
      let skins = (detail.skins || []).filter((s) => !s.isBase && s.tilePath);
      if (onlyRare) skins = skins.filter((s) => ['kEpic', 'kLegendary', 'kMythic', 'kUltimate', 'kTranscendent', 'kExalted'].includes(s.rarity));
      if (!skins.length) continue;

      const skin = pick(skins);
      return {
        name: skin.name,
        img: '/lcu' + skin.tilePath,
        icon: false,
        rarity: RARITY[skin.rarity] || 'DEFAULT',
        type: 'SKIN_RENTAL',
        count: 1,
        lootId: 'TEST_SKIN_' + skin.id,
        splash: skin.splashPath ? '/lcu' + skin.splashPath : '',   // same as splashPath in the loot
      };
    }
    return rollChampion();
  }

  async function rollChampion() {
    const champ = pick(await loadChampions());
    const detail = await champDetail(champ.id);
    const base = (detail.skins || [])[0];
    return {
      name: champ.name,
      img: base && base.tilePath ? '/lcu' + base.tilePath : '',
      icon: false,
      rarity: 'DEFAULT',
      type: 'CHAMPION_RENTAL',
      count: 1,
      lootId: 'TEST_CHAMPION_' + champ.id,
    };
  }

  function currency(name, img, count) {
    return { name, img: ART + img, icon: true, rarity: 'DEFAULT', type: 'CURRENCY', count, lootId: 'TEST_CURRENCY' };
  }

  async function rollOne(onlyRare) {
    if (onlyRare) return rollSkin(true);

    let roll = Math.random() * DROP_TABLE.reduce((n, d) => n + d.weight, 0);
    const entry = DROP_TABLE.find((d) => (roll -= d.weight) < 0) || DROP_TABLE[0];

    switch (entry.kind) {
      case 'skin':          return rollSkin(false);
      case 'champion':      return rollChampion();
      case 'keyFragment':   return currency('Key Fragment', 'HextechKeyFragment_490x490.png', 1);
      case 'blueEssence':   return currency('Blue Essence', 'currency_champion.png', between(150, 1200));
      case 'orangeEssence': return currency('Orange Essence', 'currency_cosmetic.png', between(50, 400));
      case 'mythicEssence': return currency('Mythic Essence', 'Mythic_Essence_490px.png', between(5, 25));
      default:              return rollChampion();
    }
  }

  // --- test shards and simulated actions --------------------------------

  const SHARD_IDS = ['TEST_SKIN_SHARD_1', 'TEST_SKIN_SHARD_2', 'TEST_SKIN_SHARD_3'];
  const CHAMP_ID = 'TEST_CHAMPION_SHARD';

  function shardItem(id, drop, type) {
    const skin = type === 'SKIN_RENTAL';
    return {
      lootId: id, lootName: id, itemDesc: drop.name,
      count: 1, type, rarity: drop.rarity || 'DEFAULT',
      tilePath: String(drop.img || '').replace(/^\/lcu/, ''),
      splashPath: String(drop.splash || '').replace(/^\/lcu/, ''),
      disenchantValue: skin ? 270 : 960,
      upgradeEssenceValue: skin ? 1350 : 1440,
      upgradeEssenceName: skin ? 'CURRENCY_cosmetic' : 'CURRENCY_champion',
      redeemableStatus: 'REDEEMABLE_RENTAL', itemStatus: 'NONE',
      // for a champion = the champion id (same as for real shards), for a skin we do not need it
      // same as real shards: the champion id for a champion, the skin id for a skin
      storeItemId: Number((String(drop.lootId).match(/(\d+)$/) || [])[1] || 0),
      isTest: true,
    };
  }

  /** Test shards for the Skins and Champions tabs. The first one is rare on purpose. */
  async function shards() {
    const out = [];
    for (let i = 0; i < SHARD_IDS.length; i++) {
      out.push(shardItem(SHARD_IDS[i], await rollSkin(i === 0), 'SKIN_RENTAL'));
    }
    out.push(shardItem(CHAMP_ID, await rollChampion(), 'CHAMPION_RENTAL'));
    return out;
  }

  /**
   * Fake recipes. Thanks to them test shards behave in the UI exactly like real
   * ones - buttons, selection, action bar - and only the last step in craft()
   * differs. The slots deliberately contain test items only, so a real
   * ingredient can never end up in them.
   */
  function recipesFor(item) {
    if (item.lootId === CHAMP_ID) {
      return [
        recipe('TEST_CHAMPION_upgrade', 'UPGRADE', [[item.lootId]]),
        recipe('TEST_CHAMPION_disenchant', 'DISENCHANT', [[item.lootId]]),
      ];
    }
    if (SHARD_IDS.includes(item.lootId)) {
      return [
        recipe('TEST_SKIN_upgrade', 'UPGRADE', [[item.lootId]]),
        recipe('TEST_SKIN_reroll', 'REROLL', [SHARD_IDS, SHARD_IDS, SHARD_IDS]),
        recipe('TEST_SKIN_disenchant', 'DISENCHANT', [[item.lootId]]),
      ];
    }
    return [];
  }

  function recipe(name, type, slotLists) {
    return {
      recipeName: name, type, crafterName: 'test',
      slots: slotLists.map((lootIds, i) => ({ slotNumber: i, quantity: 1, lootIds, tags: '' })),
    };
  }

  function reward(itemDesc, type, rarity, tilePath, lootId) {
    return { lootId: lootId || 'TEST_REWARD', lootName: lootId || 'TEST_REWARD',
             itemDesc, type, rarity: rarity || 'DEFAULT', tilePath: tilePath || '', count: 1 };
  }

  /**
   * Stands in for a craft on the client. It returns the same shape of response
   * ({ added, removed, redeemed }), so the rest of the app cannot tell the
   * difference.
   */
  async function simulateCraft(recipeName, items, repeat) {
    const name = String(recipeName || '').toLowerCase();
    const times = Math.max(1, repeat || 1);
    const first = items.find((i) => i && i.isTest) || items[0] || {};
    const added = [];

    if (name.includes('disenchant')) {
      const skin = first.type === 'SKIN_RENTAL';
      const total = (first.disenchantValue || 270) * times;
      added.push({ deltaCount: total, playerLoot: reward(
        skin ? 'Orange Essence' : 'Blue Essence', 'CURRENCY', 'DEFAULT', '',
        skin ? 'CURRENCY_cosmetic' : 'CURRENCY_champion') });

    } else if (name.includes('upgrade')) {
      const champ = first.type !== 'SKIN_RENTAL';
      added.push({ deltaCount: 1, playerLoot: reward(
        first.itemDesc, champ ? 'CHAMPION' : 'SKIN',
        first.rarity, first.tilePath,
        first.storeItemId ? (champ ? 'TEST_CHAMPION_' : 'TEST_SKIN_') + first.storeItemId : undefined) });

    } else if (name.includes('reroll')) {
      const d = await rollSkin(Math.random() < 0.45);
      added.push({ deltaCount: 1, playerLoot: reward(
        d.name, 'SKIN', d.rarity, String(d.img).replace(/^\/lcu/, ''), d.lootId) });

    } else {
      for (const d of await roll(times, false)) {
        added.push({ deltaCount: d.count, playerLoot: reward(
          d.name, d.type, d.rarity, String(d.img || '').replace(/^\/lcu/, ''), d.lootId) });
      }
    }

    // so something visibly happens - the client would think for a moment too
    await new Promise((r) => setTimeout(r, 220));
    return { added, removed: [], redeemed: [] };
  }

  // --- public API -------------------------------------------------------

  /** An inventory item. `isTest` keeps it out of every real path in app.js. */
  function item() {
    return {
      lootId: LOOT_ID, lootName: LOOT_ID, itemDesc: 'Test chest',
      count: 1, type: 'CHEST', rarity: 'DEFAULT', tilePath: '',
      disenchantValue: 0, upgradeEssenceValue: 0,
      redeemableStatus: 'NOT_REDEEMABLE', itemStatus: 'NONE',
      isTest: true,
    };
  }

  /** Rolls the rewards for `count` chests. `onlyRare` forces a rare skin (jackpot). */
  async function roll(count, onlyRare) {
    const out = [];
    for (let i = 0; i < count; i++) {
      try {
        out.push(await rollOne(onlyRare));
      } catch (err) {
        out.push(currency('Blue Essence', 'currency_champion.png', between(150, 1200)));
      }
    }
    return out;
  }

  /** A test offer for the Mythic Shop - a rare skin; the purchase is only simulated. */
  async function shopOffer() {
    const d = await rollSkin(true);
    return {
      storeId: 'TEST_SHOP', catalogEntryId: 'TEST_OFFER',
      name: d.name, kind: 'skin', rarity: d.rarity,
      img: String(d.img || '').replace(/^\/lcu/, ''),
      splash: String(d.splash || '').replace(/^\/lcu/, ''),
      price: 150, paymentKey: '0-lol_mythic_essence', owned: false,
      isTest: true,
    };
  }

  return { LOOT_ID, item, roll, shards, recipesFor, simulateCraft, shopOffer, SHARD_IDS, CHAMP_ID };
})();
