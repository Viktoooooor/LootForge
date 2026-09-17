# Changelog

All notable changes to LootForge are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-09-17

First public release.

### Added

- **Chests**: open one, all of a kind, or everything at once. *Open all* shows
  its progress and can be stopped after the current batch. Key fragments can be
  forged into keys.
- **Cinematic reveals**: the rarity shows first (official gem and colour), then
  the item. One chest gets a roulette, 2–5 get stacked reels, 6+ get a card
  cascade, and a summary of everything you got comes at the end.
- **Unlock and reroll ceremonies** with the full splash art at full size,
  plus synthesized sound effects and a fast mode.
- **Skin and champion shards**: shards and permanents grouped separately,
  *OWNED* ribbons, search, rarity and ownership filters, sorting.
- **Starred shards**: protected from clean up, *Select all* and reroll
  suggestions.
- **Clean up**: rule-based bulk disenchanting that always keeps one copy of
  extra shards.
- **Skin details**: uncropped splash art, chromas, your other skins for that
  champion and video previews by SkinSpotlights (optional YouTube Data API key).
- **Mythic Shop** with current rotations and purchasing (experimental).
- **Collection**: skins, champions, chromas, emotes, icons, wards and Nexus
  Finishers with completion percentages.
- **Stats**: chests opened, rarity distribution, essence gained and spent,
  history and JSON export.
- **Live updates**, new-loot notifications and wallet change highlights.
- **Settings**: YouTube key, optional test items, update check.
- Remembers your last tab, filters and collection view.
- `LootForge.exe`: runs without installing Node.js and without a console window;
  it quits by itself after its browser tab is closed.
- Connection screen that waits for the League client and greets you once connected.
- Update check: tells you when a newer release is available on GitHub.

[Unreleased]: https://github.com/Viktoooooor/LootForge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Viktoooooor/LootForge/releases/tag/v1.0.0
