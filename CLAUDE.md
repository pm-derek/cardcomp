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

**Join key** (`joinCard` in englishCards): set + de-padded number. Reprint subsets keep their original numbers, so one pokemon-tcg-data set can repeat a number (30th Celebration Classic Collection: Shining Celebi, Palkia LV.X, M Gardevoir-EX all #106; ids get letter suffixes like `me55c-106p`). When several cards share the number, the product joins to the one whose name tokens it contains; no name match -> standalone. Joining on number alone once poured Palkia's price into Shining Celebi and dropped three cards for a month.

**Debugging a missing card**: run "Refresh prices" by hand with the `find` input (a name regex, e.g. `gardevoir.?ex`). The log lists every matching pokemon-tcg-data card (set id, number, id) and every TCGplayer product (group, number, product id, price or "NO PRICE ROW (dropped)").

Vintage JP (Expansion Pack through Neo, Gym, VS) prints no collector number, so TCGplayer has no `Number` field. A product with no Number is only treated as sealed if it also lacks card fields (Rarity/HP/Card Type); otherwise it is a single with `num:""`. Regressing this silently drops ~1,700 vintage JP cards. In JP mode, an EN set name maps to its JP set(s): `EN_TO_JP_NAMES` (by JP set name; 91 sets from Base through Cosmic Eclipse, including WOTC/EX whose JP sets have no codes; where the split is not one-to-one, neighbouring JP sets are included) wins over `EN_TO_JP` (by JP code, SV/SWSH/ME). Covered: every main SV / SWSH / ME set (code map), plus Trainer Gallery / Galarian Gallery / Shiny Vault subsets, 30th Celebration, Pitch Black (-> M5 Abyss Eye, by release order), TCG Classic, and the SV / SWSH / ME promo lines (SV-P, S-P, M-P). Nicknames "sv promo", "swsh promo", "me promo", "tcg classic" resolve in both modes. An EN set with neither falls back to JP cards <= that EN set's year (promo grab-bags like Prize Pack / Misc have no JP twin). Every name in the map is verified against data.json; re-verify when TCGplayer renames a JP group.

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

## Condition multipliers (TIERS / tierFor in index.html)

LP/MP/HP/DMG prices = NM x multiplier by era (and price band for 2020+). Measured 2026-10 from a TCGplayer Seller Portal pricing export of 13 full sets with every condition (Base Set, Shadowless, Neo Discovery, EX R&S, EX Magma/Aqua, XY, BREAKpoint, Crimson Invasion, Lost Thunder, Crown Zenith, Temporal Forces, Prismatic, Phantasmal Flames; ~13.5k prices). Era drives the discount; price band barely matters.

```
                LP    MP    HP    DMG
1999-2016      60%   40%   29%   21%    (measured: WOTC, EX and XY all ~59-61% LP)
2017-2019      74%   58-60 44-45 33-38  (SM measured LP 74%)
2020+          80-90 55-78 35-58 22-42  (kept cautious; measured LP ~100% but thin markets)
```

Before this, the era line was 2010, so XY / BW cards used modern 90% LP and played older cards were overbid. To re-tune: export a few full sets (all conditions) from the Seller Portal pricing page and rerun the per-card played/NM medians by era.

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
- 30th: "30th", "30th anniversary", "30th celebration" mean the 30th Celebration set (plus its Classic Collection via SET_GROUP; JP mode M6a). "30th celebration classic collection" stays exact.
- 25th anniversary: "25th", "25th celebration(s)", "25th anniversary", "cel25", plural "celebrations" and code "cel" all mean `CEL25_SETS` (Celebrations + its Classic Collection + McDonald's 25th promos); JP mode maps to S8a / s8a-G / s8a-P. `SET_GROUP`: naming a main set also covers its Classic Collection (Celebrations, 30th Celebration), because the vintage reprints like Charizard live only in the Classic Collection. Naming the Classic Collection itself stays exact. Same for Shining Fates / Hidden Fates: the set name (or code) also covers its Shiny Vault, where the shinies live. Singular "celebration" is left to the 30th.
- Set codes (EN) resolve to the set's name before filtering: one set can carry several codes (Base Set 2 is "B2" and "BS2", Celebrations CEL/CLB), so filtering on the code alone dropped most of the set. "base 2" / "base2" / "bs2" mean Base Set 2 (not Base Set #2); "base 2/102" still means #2 of 102.
- `ereader` / `e-reader` / `e card` filters to the e-Reader sets (`EREADER_SETS`: EN Expedition, Aquapolis, Skyridge; JP Card e sets). Works alone or with a name.
- `4/102`: the number must match exactly and the set's printed size (`sz`) must include 102; sets with no recorded size are kept, and a zero result relaxes to closest by name.
- Suggestion chips, keyboard (Derek's choice): Tab moves a gold highlight right, Shift+Tab left (Down/Up also work), Enter or Space takes the highlighted chip. With nothing highlighted, Enter searches what was typed (phone "Go" unchanged) and Space types a space. Esc hides until the next keystroke. Tap works as before.
- Type words (fire, lightning/electric, colorless...) filter by Pokémon type, except when the word plus the next word is part of a real card name (`nameBigrams`): "double colorless energy", "lightning energy", "metal saucer" stay name searches. Energy aliases in `NICK`: electric/yellow -> lightning, dark/black -> darkness, steel/silver -> metal, red/blue/green/purple -> fire/water/grass/psychic ("electric energy" is Lightning Energy on TCGplayer).
- `shining` filters rarity "Shining" or a name starting "Shining" (promo reprints like Shining Lugia SM82 carry rarity "Promo"). EN has no Shining Legends Shining Lugia; only JP does.
- Printing selector: `first`/`1st`/`shadowless`/`unlimited` filter to that printing and auto-select it in the detail (`PRINT_HINT`). `1st` + `shadowless` together (any order) mean the Shadowless 1st Edition printing.
- Condition grid: the `NM ↗` label and the market price both open TCGplayer listings for that printing and condition; the bid copies.

## Bid into Whatnot (extension/)

Desktop path: a Chrome extension (MV3, `extension/`, load unpacked, see its README) that puts the tapped bid into Whatnot's Custom bid box. It never presses Place bid.

- `copyAmt` in index.html still copies to the clipboard, then `sendToWhatnot` posts `{type:"cardcomp-bid", amount, name}` to its own window and to its parent frame. With no extension nothing listens; the chip says `copied $X`. With it, the ack flips the chip to `Whatnot $X`.
- `cardcomp.js` (content script on pm-derek.github.io) and `panel.js` (side panel iframing CardComp) forward the message to `bg.js`, which sends it to the active whatnot.com tab. `whatnot.js` fills the box: a bid-looking input if visible, else clicks the "Custom bid" button and waits for it, else arms the next input Derek taps (2 min) and says so in a toast. Whatnot's markup is undocumented, so the selectors are heuristic; the armed fallback is what keeps it working after a redesign.
- Live price: `tcgplayer.js` runs on TCGplayer product pages opened from a condition link (the URL carries Printing and Condition), reads that condition's market price (else lowest listing) and posts `{type:"cardcomp-tcg-price", pid, printing, cond, market, low}` back through `bg.js` to the side panel page and any CardComp tab. `applyLive` stores it in `LIVE[pid|cond]` (pid is the printing's own product id, same as the URL) and `condGridHTML` uses it instead of the tier multiplier, marked `live`. Session-only.
- Verified store: `applyLive` turns a read into `{r: live/NM ratio, m, nm, src, at}` (NM from `pidIndex()`, product id -> card + printing) and posts `cardcomp-live-save`; the extension's `store.js` batches 20 s and PUTs `live.json` on the orphan `live` branch via the GitHub contents API (fine-grained token in `chrome.storage.local`, set on the options page; retry once on sha conflict). The `live` branch never builds Pages and never triggers the ingest (schedule / dispatch only), so writes are free. The app fetches it raw (`LIVE_URL`) on boot and every 5 min; `liveFor(pid, cond, nmToday)` prefers the session read, applies the ratio to today's NM, drops reads older than 60 days. Row shows `✓ 3d` (gold ≤ 7d, faint after) with the raw read in the hover text. Over time this is a per-card multiplier sample; re-tune `TIERS` from it once there are a few hundred entries.
- Your bid: the open card has a `your bid $ −1 [ ] +1 send` row between the bid table and the grid. Starts at the NM margin bid, then `copyAmt` writes every tapped bid into it (so +1 steps from the last tap); Enter or send runs `copyAmt` on the value, so overrides (14 said, going 15) reach Whatnot the same way.
- Feedback: `tcgplayer.js` sends `first:true` on the first read of a page and `bg.js` then re-activates the Whatnot tab (same window first) if the TCGplayer tab is still the active one; `none:true` after 8 s with nothing read shows a line under the grid (`liveNote`) so Derek knows the reader missed. The app polls `cardcomp-status` every 4 s once the extension says hello and paints `#wnstat` (`Whatnot ✓ · store ✓`). Verified rows: market price gold ≤ 7d; collapsed row tag line gets `✓ verified 3d` (`liveTag`, tag line only, never the bid column). The side panel keeps the cart column: Derek uses the cart for multi-card lots.
- Real layout (screenshots 2026-10, quagstradingco): lot row = title "$1 START SINGLES 🔥 #76" / seller line "Near Mint · Card" / "1 Bid" / "Shipping is $0.78 + Taxes" with a price column "$1" + "00:07" or "Sold"; above it "darks_tcg" + "is Winning!" or "daybreakfm" + "won!" (separate leaves); a "darks_tcg won the auction!" popup; below "Bid: $2" / "Custom" or "Awaiting next item". Titles start with "$", so only a bare "$1" outside a button is the price, and the lot row is the smallest ancestor of "N Bid" holding one. Text leaves have no size floor (short names like "kal", the viewer count "32"); usernames must have no spaces. The second line gives `sellerCond` (NM/LP/...). Win = "Sold" in the row or "X won!"; mine when X equals the username saved in extension Options (`wnUser`). `iLed` from the same username. Tested in headless Chromium against a mock of that layout (scratch test, not in repo). Sub-$1 max bids floor to 0: nothing is copied or sent ("under $1"), the tap still labels the lot. Lots with no tap are labeled with the last card opened since the previous lot ended (`LAST_VIEW`, `label:"view"`, condition from the seller line); taps carry `label:"tap"`. The strip says what the lot will be logged as ("logging: Jynx NM (viewed)" / "not labeled").
- Lot reader (`whatnot.js`): finds the "N Bids" leaf, its smallest ancestor carrying a bare $ amount is the lot card; from it title / current bid / timer / shipping; page-wide "X is Winning!" (or "you're winning"), the quick "Bid: $N" button, "Sold to X" / "You won". Posts `cardcomp-lot` on change and `cardcomp-lot-end` (final, bids, winner, leaders seen, ship, seller, url, times) when the title changes or a sold line appears. App: `LOT` paints `#lotstrip` in the sticky search row (`paintLot`); `LAST_TAP` (set in `sendToWhatnot`, grid chips carry `data-cond`) gives "over your $X" and joins the record to a card, but only when the tap happened since the previous lot ended (`LOT_START`, moved only at lot end so taps made while the seller is still showing the card count; capped at 3 min before `rec.startedAt`). Several taps on one lot (NM, LP, NM) are one record labeled with the last; all are in `bidsSent`, each with `filled:true` when it landed in the Custom bid box. The cart total is tappable (`.carttot`, `data-cart`) and labels the lot `multi:true` with `cards:[...]`, one snapshot and bid per cart item (`cardSnap`). The "your bid" send keeps the condition last tapped on that card. Lot boundaries in `whatnot.js`: title change, or for sellers who reuse one title, the bid count dropping below the lot's max or the timer jumping up 5 s+ after a sale (a late-bid extension inside a lot does not split it; tested in a vm harness). A lot that never showed a price sends `rec.empty` so the app resets without logging. `iLed` = Derek led at some point, proof he actually bid. Most sellers run generic "$2 start #43" lots and never name the card, so Derek's tap is the only record of what a lot was; a stale tap would mislabel it. Lots with no tap are logged unlabeled; `cardcomp-log-save` -> `store.js` `queueLog` -> `log-YYYY-MM-DD.json` arrays in the PRIVATE repo `pm-derek/cardcomp-data` (branch main; the token needs Contents read/write there too). The log carries usernames and Derek's purchase ledger, so it never goes on the public cardcomp repo; `live.json` (prices only) stays on the public `live` branch so the phone can read it without a token. New lot selects the search box text. `lotQuery` pulls a base name out of the title for the chip. Readouts (room closes at X% of market, bidder tendencies, purchase ledger views) are not built yet: wait for a few hundred rows, then add them from the log files.
- Log record v2 (`log-YYYY-MM-DD.json`, one file per day since each write re-uploads the file): `{v:2, title, start, final, bids, winner, me, leaders, hist:[{t:s since start, u, a}], ship, seller, url, viewers, viewers0, giveaway, room:{user:{leads, joins, min}}, startedAt, at, hour, dow, card:{id,n,s,c,num,r,y,lang,game,sealed,cond,printing,market,condMarket,low,tier,margin,thin,d30,live,myMax,tapAt}, bidsSent:[{t,bid,cond,id}]}`. `hist` is the hand history (every lead change with amount and seconds into the lot); `room` is who was seen in the last 30 min (chat "X joined" lines, lot leaders). Viewer count is a bare number in the top 220 px of the page outside the lot card: best effort. The reader runs off a MutationObserver (plus a 2 s timer in front) so background tabs keep reporting; Chrome throttles background timers to 1/min after 5 min. Next quality step when Derek can share DevTools output: read Whatnot's own websocket / GraphQL frames from a page-world script instead of scraping text (structured bids, joins, viewer counts; invisible to the server).
- Not building: auto-pressing Place bid. Whatnot's terms bar automated bidding and synthetic clicks are detectable (`isTrusted`); the human tap is also the last check against a wrong fill. Derek agreed to hold off.
- Header: no subtitle; the game is a small `<select id="gamesel">` in the search row (gold when off Pokémon) instead of a row of buttons, since nearly all bids are Pokémon.
- Headroom (checked 2026-10, Derek asked to be reminded when it matters): Pages 100 GB/mo soft (12 MB a load, ~300 loads/mo used), Pages 10 builds/hr soft (live branch never builds), API 5k/hr per token (~40 per stream), Actions unlimited on a public repo, live.json grows a few KB/mo. Tell Derek before any change that writes to `main` per click, loads the catalog far more often, or moves the app off GitHub, since those are the only ways to reach a limit.
- Mobile stays clipboard: the Whatnot app cannot be typed into from a browser (iOS no path, Android would need an accessibility service). Don't build that unless Derek moves to desktop bidding and it proves worth it.

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
- UI: a one-word pill next to the bid, only for fast or slow cards (normal shows nothing). Green "fast", amber "slow". The pill is a passive label, not tappable (Derek found tap-to-explain annoying in the list); tapping it opens the card like the rest of the row. The open card explains it in one sentence under the bid table (`speedExplain`), shown whenever the card is fast/slow or its margin differs from the floor: what made it fast/slow (vintage / played / promo / JP / price band), months to sell vs typical, and the resulting margin. Opening the card is the mobile "hover": no long-press or tap-to-reveal (both fought live use). Never swap text into the pill or bid column: any width change there squeezes the card name to nothing (shipped once, broke live). No icons or ratings. Keep it lean.
- New card fields used by this go in `storeFields` (see the storeFields bug above).

## Deliberately not doing (don't rebuild these)

- Voice input for comping — fights live stream audio; fast typed search + abbreviations won.
- Slab/graded pricing pipeline — deferred until slab volume justifies it (would need a non-TCGplayer source like PriceCharting or PokemonPriceTracker).
- Fully-automatic push-to-live — Derek keeps a one-tap PR review in the loop on purpose (it's a live tool).
