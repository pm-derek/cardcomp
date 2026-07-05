# CLAUDE.md — CardComp

Briefing for Claude Code. Read this before touching the repo.

## What this is

CardComp is a scan-to-comp tool the owner (Derek) uses **live, split-screen on a phone during Whatnot auctions**. A card appears on stream → he searches it → gets a TCGplayer price comp → reads a max bid → copies it into Whatnot. Speed and correctness matter because real money is bid in real time.

Two files do everything:

- **`index.html`** — the entire app. A self-contained single-page app with MiniSearch bundled inline. No framework, no build step.
- **`ingest.js`** — a Node script (no dependencies) run by a GitHub Action. It builds **`data.json`**, the catalog the app loads.

`data.json` = `{ updated, floor, cards: [...] }`. The app fetches it on load.

## How it ships

- Hosted on **GitHub Pages** (`pm-derek/cardcomp`, `main` branch). Merging to `main` triggers `pages-build-deployment`, which goes live in ~1 minute. That is the deploy — no other publish step.
- **Code changes** (`index.html`, `ingest.js`): open a PR, Derek reviews the diff and merges (one-tap), Pages redeploys.
- **Data refresh**: the **"Refresh prices"** Action (`prices.yml`) runs `ingest.js` on a schedule and on manual dispatch, then commits `data.json`. Prices and code deploy independently.
- `index.html` and `data.json` must sit beside each other (the app loads `data.json` relative to itself).

## Data flow (ingest.js)

- **Identity**: English card identity (name/set/number/rarity/types/attacks/image) from **pokemon-tcg-data** on GitHub.
- **Prices**: from **TCGCSV** (a TCGplayer price mirror). English = category 3. Japanese = "Pokemon Japan". Lorcana / One Piece = their own categories.
- Output is pruned to cards whose best printing ≥ `FLOOR` ($1.50).

### Coverage model (do not regress this)
Every English TCGCSV *card product* becomes an entry: if it joins to a pokemon-tcg-data card (set mapped + number matches) it gets rich identity; if not, it's emitted **standalone** straight from TCGCSV. Coverage does **not** depend on the fuzzy set-name matcher — that only decides whether a card gets enriched, not whether it appears. Promos, old WOTC subsets, and anything with mismatched numbering still show up. `gameCards()` is the generic path for single-category games (Lorcana, One Piece); JP and EN have their own functions.

Shadowless: a TCGCSV `"... (Shadowless)"` group folds onto its base card as `"Shadowless …"` printing keys, so Base Set Charizard is one entry with Unlimited / 1st Edition / Shadowless / Shadowless 1st Edition printings.

## The card object

```
{ id, n:name, s:set, c:setCode, y:year, o:groupRecency, num, r:rarity,
  hp, t:[types], st:[subtypes], atk, img, lang:"en"|"jp", game:"pkmn"|"lorcana"|"onepiece",
  px:{ "<printing>": {m:marketOrMid, l:low} }, pid:tcgplayerProductId,
  sealed:true?, kind:"<sealed type>"? }
```

`game` defaults to `"pkmn"` when absent. `px` printing keys become the printing chips in the UI.

## ⚠️ The #1 recurring bug: storeFields

MiniSearch **only returns fields listed in `storeFields`**. There are two result paths:
- empty query → `CARDS.map(...)` → full objects, every field present.
- typed query → `ms.search(...)` → **only `storeFields` are present**.

So any field used in `passFilters`, `render`, or sorting **must be in the `storeFields` array**, or searched results silently lose it (browse works, search breaks). This has bitten us with `game`, `sealed`, `kind`, and `o` — each time the symptom was "works when browsing / when in the other mode, but not when I search."

**Rule: add a new card field → add it to `storeFields` in the same commit. Test by searching, not just browsing.**

## Testing (no build step)

Syntax-check the app by extracting the last `<script>` block and running Node:

```bash
node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");const i=h.lastIndexOf("<script>");const e=h.indexOf("</script>",i);fs.writeFileSync("/tmp/app.js",h.slice(i+8,e));' && node --check /tmp/app.js
node --check ingest.js
```

For logic changes (classifiers, bid math, phonetic keys), write a tiny standalone Node harness and check real cases before shipping. The app itself can't run headless (needs the DOM + data.json).

## Bid math

Max bid is **margin-driven**, not a percent of market:

```
bidForMargin(market, mf) = netProceeds(listSale(market)) / (1 + mf)
listSale(m)   = m * (1 + listmarkup%/100)
netProceeds(s)= s*(1-feePct) - flat - (s >= thresh ? track : 0)
mf            = getNum("tgtmargin",10)/100   // "target margin %" setting; Derek runs 10%
```

So the bid is the highest price that still nets the target margin. Do **not** reintroduce flat %-of-market bidding — it was replaced deliberately.

Bids **copy to clipboard as whole dollars, floored** (`Math.floor`) — Whatnot rejects cents, and flooring guarantees the pasted number never exceeds the true ceiling.

Each condition row and the collapsed card also show the **net $ profit** at that bid. `thinFlag()` marks bids built on shaky price data (no market, low-listing-only, or wide spread).

## Full-art / chase toggle: isChase()

Per-game classification:
- **EN Pokémon**: an explicit allowlist `CHASE_EN`. Derek's definition of "full art" is *art extends past the frame*, plus modern "Ultra Rare and above, not Double Rare." Base parallels (Rare Holo V/VMAX/VSTAR/GX), plain Rare Holo, and framed premiums are excluded on purpose. **New Pokémon rarities silently miss until added here** — when a new set introduces a rarity string, add it to `CHASE_EN`.
- **JP**: `JP_CHASE` matches either short codes (AR, SAR, SR…) or full words ("Art Rare"), since TCGCSV storage varies.
- **Lorcana** (`LORCANA_CHASE`): Enchanted / Legendary / Super Rare. **One Piece** (`ONEPIECE_CHASE`): SR / SEC / Manga / etc.

The toggle relabels per game (Full Art / Enchanted+ / Chase).

## game + lang model

- `GAME` (`pkmn`/`lorcana`/`onepiece`) is the top, non-sticky toggle; persisted in localStorage.
- `LANG` (`en`/`jp`) only applies within Pokémon; the EN/JP toggle hides in other games.
- `passFilters` gates on `game` first, then `lang` (only when `pkmn`).
- Search vocab is **game-scoped** (`buildVocab` filters to the current game) and rebuilt on game switch, so Pokémon and Lorcana/One Piece don't cross-match on names or set codes.

## Search layers (in parse/run)

- **ABBR** — unique 3–4 char prefix → full name (`zek` → zekrom). Built per game from real catalog names; only prefixes that resolve to one name.
- **PHON** — phonetic sounds-like fallback for misspellings beyond fuzzy's reach (`goldengo` → gholdengo). Only fires when normal search is thin.
- MiniSearch: prefix matching at length ≥ 3, fuzzy at length > 4.
- Rarity shorthands `dr ir sir ur hr` (and JP `sr ar sar`) are **reserved** so a set code can't hijack them. `DR` = Double Rare (community shorthand; `rr` also works).
- Printing selector: `first`/`1st`/`shadowless`/`unlimited` filter to that printing and auto-select it in the detail (`PRINT_HINT`).

## Other UI notes

- **Stale-price banner**: if `data.json`'s `updated` is > 2 days old, a warning shows (the daily ingest may have stalled).
- **Cart**: tap-to-add per condition; tapping a cart row reopens that card expanded. Uses margin-driven bids.
- The app uses `localStorage` for game, settings, and cart — that's fine on GitHub Pages (it is only forbidden inside claude.ai artifact sandboxes).

## Working style / conventions

- Terse, numbers-first. **No em dashes** in any copy written for Derek. Minimal formatting.
- Lean systems — push back on over-engineering relative to the dollars at stake. Prefer sale-side-only data entry.
- Ship several small features per deploy; bugs surface from live-stream use and come back with specifics.
- When adding a card field, adding a rarity, or adding a game: update `storeFields`, the relevant `*_CHASE` set, `passFilters`, and `buildVocab` together.

## Deliberately not doing (don't rebuild these)

- Voice input for comping — fights live stream audio; fast typed search + abbreviations won.
- Slab/graded pricing pipeline — deferred until slab volume justifies it (would need a non-TCGplayer source like PriceCharting or PokemonPriceTracker).
- Fully-automatic push-to-live — Derek keeps a one-tap PR review in the loop on purpose (it's a live tool).
