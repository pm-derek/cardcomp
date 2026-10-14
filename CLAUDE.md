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

Vintage JP (Expansion Pack through Neo, Gym, VS) prints no collector number, so TCGplayer has no `Number` field. A product with no Number is only treated as sealed if it also lacks card fields (Rarity/HP/Card Type); otherwise it is a single with `num:""`. Regressing this silently drops ~1,700 vintage JP cards. In JP mode, an EN set name with no JP twin (Neo Genesis, Base Set) filters JP cards to <= that EN set's year instead of an exact set name.

### Loud fail, carry forward, trend (end of ingest.js)
- **Guard** (`coverageProblems`): compares against the data.json already in the repo and exits 1 (run fails, GitHub emails, nothing published) if >3% of $3+ cards vanish by id, a 200+ card segment (Pokemon EN/JP, sealed, Lorcana, One Piece) loses 20%, or 4+ sets fail to download after 3 retries. Single-set losses only log. Thresholds come from replaying 30 days of real runs (normal churn peaks ~0.9%). Manual run with `force` publishes anyway.
- **Carry forward**: TCGplayer has no price row some days for pricey illiquid cards (Gold Stars, $1k+ vintage), so they used to vanish from search for a day. A card whose product got no price today keeps yesterday's entry up to 30 days with `ps` set; the app shows "⚠ no TCGplayer price since <date>". Cards present but under the floor, or whose product reappeared under a new id, are not carried.
- **Trend** (`d7`/`d30`): read from git history (the workflow fetches 40 days; every daily commit is a snapshot, so full history already exists for free). Compares the same printing on both days (top printing with a real market price both days; m == l is a lone listing and skipped), drops moves > 200% as artifacts. Collapsed card shows the 30d move at 15%+ (about 1 card in 6); the detail line shows both.

Shadowless: a TCGCSV `"... (Shadowless)"` group folds onto its base card as `"Shadowless …"` printing keys, so Base Set Charizard is one entry with Unlimited / 1st Edition / Shadowless / Shadowless 1st Edition printings. Folded printings (Shadowless, Master Ball / Poké Ball patterns) are separate TCGplayer products, so each keeps its own product id in `px[k].p`; every TCGplayer link uses the selected printing's `p` (falling back to `pid`) and strips the prefix for the Printing filter. Without it the link opens the base card (shipped once: 1st Ed Shadowless Machop opened regular Machop).

## The card object

```
{ id, n:name, s:set, c:setCode, y:year, o:groupRecency, num, r:rarity,
  hp, t:[types], st:[subtypes], atk, img, lang:"en"|"jp", game:"pkmn"|"lorcana"|"onepiece",
  px:{ "<printing>": {m:marketOrMid, l:low} }, pid:tcgplayerProductId,
  sealed:true?, kind:"<sealed type>"?,
  d7?, d30?:<% change>, ps?:"<YYYY-MM-DD last real price>" }
```

`data.json` also carries `sz: { "<set name>": [printed set sizes] }` for "4/102" search.

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
- Mechanic tags are exact filters: `v`, `ex` (f.mech), `vmax`, `vstar` (stage), `gx`, `break` (subtype). Matched by subtype OR name via `stampOK`/`NAME_STAMPED`, so "melmetal v" never returns VMAX, ex or GX. Applied in the fallback (passId) too.
- Exact name: when the name part of the query is a complete base name (`isBaseName`, from the suggestion index), results keep only cards whose name contains that whole name. "mew" never returns Mewtwo; "meowth" keeps Alolan / Team Rocket's Meowth. Partial input ("meo") still prefix-matches. Same rule whether typed or picked from a chip.
- `SET_TWINS`: a promo line split across two set names (pokemon-tcg-data's joined cards vs TCGplayer standalones, e.g. "SV: Scarlet & Violet Promo Cards"/SVP and "Scarlet & Violet Black Star Promos"/PR-SV) searches as one set. Add a pair when a new promo line splits.
- 25th anniversary: "25th", "25th celebration(s)", "25th anniversary", "cel25", plural "celebrations" and code "cel" all mean `CEL25_SETS` (Celebrations + its Classic Collection + McDonald's 25th promos); JP mode maps to S8a / s8a-G / s8a-P. `SET_GROUP`: naming a main set also covers its Classic Collection (Celebrations, 30th Celebration), because the vintage reprints like Charizard live only in the Classic Collection. Naming the Classic Collection itself stays exact. Singular "celebration" is left to the 30th.
- `ereader` / `e-reader` / `e card` filters to the e-Reader sets (`EREADER_SETS`: EN Expedition, Aquapolis, Skyridge; JP Card e sets). Works alone or with a name.
- `4/102`: the number must match exactly and the set's printed size (`sz`) must include 102; sets with no recorded size are kept, and a zero result relaxes to closest by name.
- Printing selector: `first`/`1st`/`shadowless`/`unlimited` filter to that printing and auto-select it in the detail (`PRINT_HINT`). `1st` + `shadowless` together (any order) mean the Shadowless 1st Edition printing.
- Condition grid: the `NM ↗` label and the market price both open TCGplayer listings for that printing and condition; the bid copies.

## Other UI notes

- **Stale-price banner**: if `data.json`'s `updated` is > 2 days old, a warning shows (the daily ingest may have stalled).
- **Cart**: tap-to-add per condition; tapping a cart row reopens that card expanded. Uses margin-driven bids.
- The app uses `localStorage` for game, settings, and cart — that's fine on GitHub Pages (it is only forbidden inside claude.ai artifact sandboxes).

## Working style / conventions

- Terse, numbers-first. **No em dashes** in any copy written for Derek. Minimal formatting.
- Lean systems — push back on over-engineering relative to the dollars at stake. Prefer sale-side-only data entry.
- Ship several small features per deploy; bugs surface from live-stream use and come back with specifics.
- When adding a card field, adding a rarity, or adding a game: update `storeFields`, the relevant `*_CHASE` set, `passFilters`, and `buildVocab` together.

## Velocity-tiered margin (speedOf in index.html)

Goal is cash flow: fast cards keep a thin margin (competitive bid), slow cards get a fat one (low bid, so Derek mostly passes). Derived 2026-10 from 12 months of TCGplayer sales (pull sheets + order list) and one inventory snapshot.

Margin = clamp(0.50 x monthsToSell / 12, floor, 0.25). 50%/yr target on capital. The settings margin is the floor (the grid assumes 10%). Toggle: settings "speed-based margin". Pokemon singles only; Lorcana, One Piece and sealed stay flat at the floor.

```
                 $2-5  $5-10  $10-25  $25-50  $50-100  $100+
fast              10%   10%    10%     10%     10%     15%
normal            10%   10%    11%     13%     20%     25%
JP                10%   16%    20%     24%     25%     25%
```

- fast = vintage (pre-2014), played (LP or worse), promos. normal = everything else. Price band uses the condition row's own price (spec §12). Rare/Holo Rare was dropped as a fast trait: split by era, modern NM rares sell only x0.85 vs their price band (the fast reading was vintage holos); modern NM promos hold up at x0.58.
- Snapshot caveat: the inventory export has no listing dates, so months-to-sell (stock / sales rate) can only be biased toward slow. "Fast" readings are trustworthy; "slow" ones may be recent buy-ins. That is why SIR/SWSH/XY-SM/ME (1.1-1.3x) are treated as normal and JP is damped from 2.7x to 1.8x. Re-run quarterly with fresh exports before trusting the $50+ steps.
- UI: a one-word pill next to the bid, only for fast or slow cards (normal shows nothing). Green "fast", amber "slow". The pill is a passive label, not tappable (Derek found tap-to-explain annoying in the list); tapping it opens the card like the rest of the row, and the detail line shows the reason ("NM 20% · slow JP"). Never swap text into the pill or bid column: any width change there squeezes the card name to nothing (shipped once, broke live). No icons or ratings. Keep it lean.
- New card fields used by this go in `storeFields` (see the storeFields bug above).

## Deliberately not doing (don't rebuild these)

- Voice input for comping — fights live stream audio; fast typed search + abbreviations won.
- Slab/graded pricing pipeline — deferred until slab volume justifies it (would need a non-TCGplayer source like PriceCharting or PokemonPriceTracker).
- Fully-automatic push-to-live — Derek keeps a one-tap PR review in the loop on purpose (it's a live tool).
