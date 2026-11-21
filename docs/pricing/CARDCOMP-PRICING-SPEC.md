# CardComp pricing spec: what Derek lists at

Handoff for Claude Code working in `pm-derek/cardcomp`. Written 2026-11-20 from the Pull Sheet (Google Sheets + Apps Script, master copy in the private repo `pm-derek/cardcomp-data/pull-sheet/`).

## Why

CardComp's bid math assumes a sale price of `listSale(m) = m * (1 + listmarkup%)`. Derek's real listing prices now come from the Pull Sheet's **Pricing tab**: a markup table by price band, an era premium for older cards, a separate table for played cards, rounding rules, and Direct rules on top. Since 2026-11-17 most $2.50+ NM/LP sales go through **TCGplayer Direct**, which charges different fees than a regular order. CardComp should price the sale the way the sheet does and net it the way the channel does.

Files in this handoff:

- `CARDCOMP-PRICING-SPEC.md` (this file)
- `pricing-settings.snapshot.json`: today's settings, the same shape the live feed produces. Ship it as the built-in default.
- `engine.js`: reference implementation of the sheet's pricing, a pure function. Port or reuse it; the test cases below come from it.

## 1. Live settings feed

The sheet now has a tab **"CardComp Settings"** (Pull Sheet menu: Tools & fixes > "CardComp: pricing settings tab (to publish)"). Every value on it is a live formula on the Pricing tab. Derek publishes only that tab to the web as CSV (File > Share > Publish to web > that tab > CSV, auto-republish on). Google refreshes a published CSV within a few minutes of an edit. The tab holds settings only, no orders, buyers or costs.

CSV shape, one row per value:

```
group,key,value,what it is
meta,format,cardcomp-pricing-1,...
meta,built,2026-11-20 17:50,...
setting,ship_under_free,1.49,...
...
markup,1,1.4,...          key = market up to $, value = x
markup,2,1.3,
...
copies,0,1,...            key = copies from, value = x
floor_copies,0,1,...
nd_markup,1,1.25,...      key = market up to $ (MP/HP/DMG, sealed)
era,WOTC,1.1,...
lang_adjust,EN,0,...
lang_md_days,EN,,...      blank = no markdowns
lang_md_week,EN,0.02,...
lang_md_max,EN,0.15,...
```

Blank `key` = unused table row, skip it. `setting` values are numbers except `low_markup` (TRUE/FALSE). Parse into the shape of `pricing-settings.snapshot.json`.

Suggested wiring (decide what fits the repo):

- **ingest.js** (GitHub Action, server side, no CORS question): fetch the CSV URL (store it as a repo variable or secret), parse, embed as `pricing` in `data.json`. Prices refresh daily, so settings would too.
- **Browser, optional**: fetch the CSV directly with `cache: "no-cache"` for same-day changes. Untested whether Google's published CSV allows cross-origin reads from `pm-derek.github.io`; check before relying on it.
- **Fallbacks**: last good copy (localStorage) > `data.json.pricing` > built-in snapshot. Reject a feed whose `meta.format` isn't `cardcomp-pricing-1`, whose markup table is empty, or with values out of range (markups 0.5 to 3, `dl_cap_x` 1 to 3); keep the previous copy and show nothing alarming.

The feed never needs a token: publish-to-web is read only and public by design.

## 2. How the sheet prices a card

Order of steps (all settings keys refer to the snapshot / CSV). Implemented in `engine.js` `listPrice(card, S)`.

1. **Route**
   - No market price: keeps the current price (not CardComp's concern).
   - `market <= floor_at` ($0.40): floor price `floor_price` ($0.50) x `floor_copies`, then rounding.
   - Else "priced".
2. **Base** = `max(market * markup(market) * copies(n), cheapest * copies(n))`
   - `markup`: "up to $" tiers, smallest bound >= market. Today: <=1: 1.40, <=2: 1.30, <=3: 1.35, <=5: 1.30, <=10: 1.30, <=25: 1.25, <=100: 1.20, above: 1.10.
   - `copies`: "from N" tiers on how many copies Derek holds of that SKU, up to x1.08. CardComp doesn't know the count; use 1.
   - `cheapest` = the cheapest TCGplayer listing on Derek's terms (under `free_from` $5: its price with shipping minus `ship_under_free`; from $5: as listed). The sheet never lists under it. CardComp's per-condition cheapest listing (fast read `lo`) or catalog `l` can stand in; ignoring it only makes the estimate lower, which is the safe side for bids.
3. **Condition**
   - Near Mint / Lightly Played: on to step 4.
   - MP / HP / DMG (and sealed): `max(market * nd_markup(market), cheapest) * copies` replaces step 2's markup. No era, no Direct. Today: <=1: 1.25, <=2: 1.15, <=5: 1.08, <=10: 1.05, <=25: 1.03, <=100: 1.02, above: 1.01.
4. **Language and era** (NM/LP): `x (1 + lang_adjust)` and, when `market >= era_from` ($2.50), `x era`. Today: WOTC / EX 1.10, DP / HGSS / BW 1.06, XY 1.04, SM 1.02, SWSH / SV / ME / other 1.00. Era mapping in section 6.
5. **Direct** (NM/LP only; only ever raises the price). Needs the TCGplayer Direct Low for that SKU, which CardComp doesn't have; skip it (section 4).
   - Another seller holds the Direct Low above Derek's price, market >= `dl_from`: raise to `directLow - 0.01`.
   - Derek holds it, market >= `own_from`, `own_probe` = 1: raise to the cap (or 1 cent under a remembered next seller).
   - Never above the cap = `market * dl_cap_x + dl_cap_add` (today x1.5 + $2.00).
6. **Markdown** (off while `lang_md_days` is blank, as today), then **rounding** on the final price:
   - round to cents first
   - $5.00 to `snap5_to` ($5.20) -> $4.99
   - $50.00 to `snap50_to` ($52) -> $49.99
   - otherwise, within `charm` (1%) above an .99 -> that .99 (e.g. $8.00 -> $7.99, $120.00 -> $119.99)

### Test cases (from `engine.js`, today's settings, 1 copy, no cheapest listing unless stated)

| Card | List price |
|---|---|
| $0.35 market, NM | $0.50 |
| $1.80, NM, SV | $2.34 |
| $4.00, NM, SV | $4.99 |
| $4.00, NM, SV, another Direct seller at $5.49 | $5.48 |
| $4.00, NM, SV, another Direct seller at $12.00 | $7.99 (cap $8.00, rounded) |
| $4.00, NM, SV, another Direct seller at $4.50 | $4.99 |
| $4.00, NM, SV, Derek is the Direct Low at $4.99 | $7.99 (probe to cap) |
| $4.00, NM, SV, cheapest listing $6.10 | $6.10 |
| $20, NM, WOTC | $27.50 |
| $20, MP, WOTC | $20.60 |
| $42, NM, SV | $49.99 |
| $100, NM, SM, 3 copies | $126.99 |

## 3. What a sale nets, by channel

Same models as the Pull Sheet's Shipped Log (`feeModel_`, `orderFees_`, `directFees_`).

**Regular order** (Derek ships), one card at sale price `s`:

- buyer pays $1.49 shipping when the order is under $5, else free
- commission 10.75% of `s` (max $75 a card)
- processing 2.5% of (`s` + shipping) x 1.07 (sales tax) + $0.30 per order
- postage: envelope $0.97 under $49.99; tracked $6.18 from $49.99; +$4.00 signature from $250
- net = `s` - fees - postage + buyer shipping

**TCGplayer Direct** (Derek restocks TCGplayer in bulk; NM/LP only):

- under $2.50: 50% of `s`
- $2.50 and up: $1.12 + 8.95% commission (max $75) + 2.5% transaction
- plus RI shipping and insurance, about $15 per RI spread over its cards (~$0.15 a card at 100 cards)
- the buyer's shipping goes to TCGplayer, not Derek
- paid after TCGplayer checks the RI in, roughly 1-2 weeks after the sale

Net per card, one-card regular order vs Direct:

| Sale price | Regular | Direct |
|---|---|---|
| $2.99 | $2.77 | $1.38 |
| $3.99 | $3.64 | $2.26 |
| $4.99 | $4.50 | $3.15 |
| $7.99 and up | about even | about even |

Under ~$7.99 Direct nets less; that's why the Pricing tab's $2-10 markups are high (1.30-1.35).

## 4. What CardComp can and can't know

| Input | Sheet uses | CardComp |
|---|---|---|
| market | TCGplayer market of the SKU | has it (catalog / condition prices) |
| condition, era | from the listing | condition from the grid; era from set / year (section 6) |
| copies held | Derek's stock count | unknown: use 1 |
| cheapest listing | TCGplayer low, on his terms | partial (fast read `lo`, catalog `l`); safe to skip |
| Direct Low | live export | unknown: skip. Direct rules only raise the price, so skipping is conservative |
| markdowns | days unsold | off today; skip |

## 5. Suggested use in bid math (for Derek to confirm)

- `listSale` = the sheet's price for that card and condition (steps 1-4 and 6), instead of the flat `listmarkup%`.
- Net by channel: MP and below, under $2.50, Japanese, sealed: regular only. NM/LP $2.50+: either channel. Recent mix: about two thirds of $2.50+ NM/LP sales went through Direct, which sold at 1.16-1.23x market (first two RIs, 2026-11-17 to 19).
- Derek prefers caution ("I'd rather have something sit too long than price it too low"). The conservative choice for NM/LP $2.50+ is `min(net regular, net Direct)`; a blend by channel share is the optimistic one. Ask him which.
- Keep everything else as is: target margin, min profit per card, whole-dollar rounding (`wholeBid`), speed-based margin, condition tiers for played cards.

## 6. Era mapping

The sheet maps by set name (`eraCode_` in "Pull Sheet Sorter v4.gs"). By release year it is close enough:

| Era | Years | Covers |
|---|---|---|
| WOTC | 1999-2003 | Base Set to Neo, Legendary Collection, e-Card, WOTC promos |
| EX | 2003-2007 | Ruby & Sapphire to Power Keepers, POP Series |
| DP | 2007-2009 | Diamond & Pearl, Platinum |
| HGSS | 2010-2011 | HeartGold SoulSilver to Call of Legends |
| BW | 2011-2013 | Black & White to Legendary Treasures |
| XY | 2014-2016 | XY to Evolutions, Generations |
| SM | 2017-2019 | Sun & Moon to Cosmic Eclipse, Hidden Fates |
| SWSH | 2020-2022 | Sword & Shield to Crown Zenith |
| SV | 2023-2025 | Scarlet & Violet to White Flare, TCG Classic |
| ME | 2025 on | Mega Evolution |
| other | | sets the sheet can't date (misc promos, jumbo, deck exclusives): 1.00 |

Year cut points the sheet uses when only a year is known: <2003 WOTC, <2007 EX, <2010 DP, <2011 HGSS, <2014 BW, <2017 XY, <2020 SM, <2023 SWSH, <2025 SV, else ME. Boundary years are ambiguous (2003, 2007, 2011, 2025); a set-name check beats the year there. Non-Pokemon games: always "other". Era only matters from $2.50 market and only for NM/LP.

## 7. Open questions for Derek

1. Conservative (min of channels) or blended net for NM/LP $2.50+?
2. Should CardComp show the expected list price on the open card ("lists at $27.50")? It makes the bid easy to sanity-check.
3. The published CSV URL, once he publishes the tab.
