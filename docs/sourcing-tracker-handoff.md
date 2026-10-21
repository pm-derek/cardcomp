# CardComp sourcing tracker: handoff for the cost / sales / P&L sheet

Written 2026-10-18 from the CardComp build conversation, to take into Claude chat to design the master tracking sheet.

**Goal:** know cost and sales **per card**. Every card bought on Whatnot should carry its true cost
(hammer price + shipping + tax), follow it through the Roga Sifter chaos sort and TCGplayer upload, and land on a
sale. Then P&L rolls up by card, by seller, by stream, by month.

**Where we are:** CardComp already records every Whatnot lot Derek watches, including what he won, for how much,
from whom, and (most of the time) which exact card and condition it was. That is the buying side of the ledger.
Nothing exports it yet. This doc lays out what exists, what is reliable, what is missing, and a proposed design for
the sheet and for a future CardComp export.

---

## 1. The system today (one paragraph each)

**CardComp app** (`pm-derek.github.io/cardcomp`). Search a card, get a TCGplayer price comp and a max bid. Max bid is
margin-driven: the highest price that still nets the target margin (10% floor, higher for slow sellers) after
TCGplayer fees and shipping, if the card were listed at market.

**Chrome extension** (desktop, side panel next to the Whatnot stream). Tapping a bid in CardComp fills Whatnot's
Custom bid box (Derek still presses Place bid himself). The extension also **reads the Whatnot stream** (lot title,
current bid, timer, leader, winner, seller, shipping line, chat joins) and reports each finished lot back to CardComp.

**Lot labeling.** Most sellers run generic lots ("$1 START SINGLES #76", "Card on Screen #291") and never name the
card. So the card Derek **tapped a bid on** (or, if he did not bid, the card he **opened**) during that lot is the
only record of what the lot was. CardComp attaches a full snapshot of that card to the lot record.

**Verified prices.** Clicking a condition (LP, MP...) out to TCGplayer reads the real price for that condition and
saves it (shared between desktop and phone). Fixed 2026-10-18: one TCGplayer product can hold several printings
(1st Edition vs Unlimited), so reads are now keyed by printing.

**Stream stats and dashboard.** The stats panel shows, per seller and stream, what rooms sell at as a % of market,
your win rate, margin on wins and profitable lots you passed on. The dashboard (`cardcomp/#dash`) adds daily buys,
spend, net if listed at market, an after-shipping estimate (one shipping charge per seller per stream, assumed),
best / worst buys, a per-streamer table and buying habits (paid over max, lost under max). It is the closest thing
to a P&L today, but it only covers the **buy side** and uses **estimated** sale value, not real sales.

**Where data lives**

| Store | What | Who can see it |
|---|---|---|
| `pm-derek/cardcomp-data` (private GitHub repo), `log-YYYY-MM-DD.json` | Every finished lot, one JSON row each. **This is the purchase ledger source.** | Derek only |
| Browser localStorage `cardcomp_lots` | Slim copy for the stream stats panel. Rebuilt from the GitHub log on each load. | That browser |
| `pm-derek/cardcomp`, `live` branch, `live.json` | Verified TCGplayer condition prices (no usernames, no purchases) | Public |
| `data.json` in the app | Catalog: every card, printing, TCGplayer product id, market / low price | Public |

Every write to the log is a git commit, so the full history is recoverable (this saved the zenzoogie data once).

---

## 2. What one logged lot looks like

Record version 3, one per finished lot (won or not). Fields that matter for cost tracking are in **bold**.

| Field | Meaning | Reliability |
|---|---|---|
| **`me`** | Derek won this lot | Good. From "You won" / "rewired won!" / username match |
| **`final`** | Hammer price, whole dollars | Good |
| **`seller`** | Whatnot seller username | Good since 2026-10-16 evening (earlier rows had bugs, see section 4) |
| **`at`** | When the lot ended (epoch ms) | Good. Use this to match Whatnot receipts |
| **`url`** | The Whatnot live show URL (one per show) | Good. Groups lots into a show / order |
| **`ship`** | Shipping shown on the lot ("Shipping is $0.78"), `null` when FREE | Best effort, often null |
| `title`, `sub`, `sellerCond` | Lot title, description line, seller's stated condition ("Near Mint") | Title good since 2026-10-17 |
| **`card`** | Snapshot of the card Derek tapped / opened (below) | Present on ~74% of wins so far |
| **`placedMax`** | Max bid actually set in Whatnot ("Max bid added $26") | Good when shown |
| `bidsSent[]` | Every bid CardComp sent this lot: time, amount, condition, card id | Good |
| `iLed` | Derek was the leader at some point (proof he bid, not just tapped) | Good |
| `bids`, `start`, `hist[]`, `leaders[]` | Bid count, start price, every lead change with amount and seconds | Good |
| `room`, `viewers`, `giveaway`, `hour`, `dow` | Room context for bidder analysis | Best effort |

**`card` snapshot** (the card identity at time of purchase):

| Field | Meaning |
|---|---|
| **`id`** | CardComp card id, e.g. `sv3pt5-203` (pokemon-tcg-data id) or `tc:513808` (TCGplayer-only cards) |
| **`n`, `s`, `c`, `num`, `r`** | Name, set, set code, collector number, rarity |
| **`printing`** | TCGplayer printing name: `Holofoil`, `Reverse Holofoil`, `1st Edition Holofoil`, `Normal`... |
| **`cond`** | NM / LP / MP / HP / DMG |
| **`condMarket`** | TCGplayer market for that printing + condition at purchase time |
| `market`, `low` | NM market and lowest listing at purchase time |
| `myMax` | The max bid CardComp computed and Derek tapped |
| `margin`, `tier` | Target margin used (speed-based), fast / slow tag |
| `label` | `tap` (Derek bid on it: strong) or `view` (only opened it: weaker) |
| `condFrom` | `assumed NM` when condition came from nothing (view label, no seller line) |
| `lang`, `game`, `sealed` | en / jp, pkmn / lorcana / onepiece, sealed product |
| `multi`, `cards[]` | Multi-card lot (cart total tapped): one snapshot + bid per card |
| `late` | Tap came within 2.5 s after "Sold" (Derek reacting to the card that just sold) |

Real example (a win from 2026-10-18):

```json
{ "final": 11, "me": true, "seller": "...", "placedMax": 11, "ship": null,
  "card": { "id":"sv3pt5-203", "n":"Erika's Invitation", "s":"151", "c":"MEW", "num":"203",
            "r":"Special Illustration Rare", "printing":"Holofoil", "cond":"NM",
            "market":16.01, "condMarket":16.01, "low":13, "label":"view", "condFrom":"assumed NM" } }
```

---

## 3. Data collected so far (as of 2026-10-18)

- 3 day files (Oct 16, 17, 18), **394 lots** across 20 sellers.
- **39 wins, $395 hammer total.** 29 of 39 wins (74%) carry a card snapshot; 10 are "no card" (Derek won without
  tapping or opening a card in CardComp).
- 0 multi-card lots so far.

---

## 4. Gaps and caveats for cost accounting (read before trusting a number)

1. **Hammer price is not total cost.** Missing: **sales tax** (never shown per lot), **shipping** (shown per lot
   only as "Shipping is $X" or FREE, and Whatnot usually charges shipping once per seller per show, not per lot),
   and any Whatnot credits / promos. **Whatnot order receipts / purchase history are the source of truth for money
   actually charged.** CardComp is the source of truth for *which card* each lot was.
2. **No TCGplayer product id in the snapshot yet.** The card snapshot has CardComp `id` + `printing`, not the
   TCGplayer product id or SKU. It is derivable (CardComp's `data.json` maps id + printing to product id), but the
   export should include it directly. This is the join key to the Roga Sifter / TCGplayer side.
3. **Unlabeled wins** (10 so far). Need a manual "what was this" step. Lot title and time help; the stream video does
   not exist after the fact.
4. **`view` labels are weaker than `tap` labels.** A view means Derek opened that card during the lot without
   bidding through CardComp. Usually right, not guaranteed.
5. **Condition is an assumption until the card is in hand.** `cond` is what Derek bid on or the seller's line, or
   "assumed NM". The real condition is decided at the sort. The sheet needs a "condition received" column separate
   from "condition bought as".
6. **Oct 16 data quality.** Rows logged before the fixes that evening had problems (seller logged as chat users, lots
   split per bid, wrong labels). They were repaired by hand from git history, but treat Oct 16 costs as "verify
   against receipts".
7. **Desktop only.** Bids placed from the phone (clipboard path, no extension) are **not logged**. Only lots watched
   in Chrome with the extension are.
8. **Giveaway wins** appear as lots (title "Giveaway Winner") at $0 cost. Filter or tag them.
9. **Multi-card lots** need cost allocation across cards (suggest: split hammer by each card's `condMarket` share).
10. **Prices are whole dollars** (Whatnot bids are whole dollars), so `final` is exact; tax and shipping are not.

---

## 5. The target: a per-card unit ledger

One row per **physical card** (a "unit"), moving through four stages. Everything else is a view on this table.

```
 BUY (Whatnot lot)  ->  RECEIVE (open package)  ->  SORT / LIST (Roga Sifter -> TCGplayer)  ->  SELL (TCGplayer order)
 CardComp log          condition check, qty          TCGplayer SKU, list price, upload date        order id, sale price, fees
 + Whatnot receipt     match to purchase             (chaos sort mixes sources)                     net proceeds
```

**Cost basis per unit** = hammer (or allocated share of a multi-card lot)
+ allocated shipping (that seller's show shipping / units in that show order)
+ allocated tax (order tax / units, or tax rate x hammer)
- any credits.

**Profit per unit** = TCGplayer net proceeds - cost basis.
CardComp's fee model (section 7) gives an *estimate* of net proceeds at buy time; the sale side should use
TCGplayer's actual payout lines.

### Join keys

| From -> to | Key | Notes |
|---|---|---|
| CardComp lot -> Whatnot receipt | seller + show (`url`) + time (`at`) + amount (`final`) | Receipts list item + price + time per order; match within a few minutes and exact $ |
| CardComp card -> TCGplayer catalog | CardComp `id` + `printing` -> **TCGplayer product id**; + condition -> **SKU** | CardComp can export product id directly (to build) |
| Purchase unit -> inventory (Roga Sifter upload) | TCGplayer SKU (product + printing + condition + language) | The chaos sort pools cards from many buys: match by SKU, then allocate |
| Inventory -> sale | TCGplayer SKU + order date (FIFO), or a per-unit tag if Derek labels units | See "chaos sort" below |

### The chaos-sort problem (and the practical answer)

Once a Whatnot pickup goes into a chaos sort with other inventory, the physical card loses its link to the
purchase. Options, simplest first:

1. **Pool by SKU, cost by FIFO (or average).** Each SKU (e.g. Erika's Invitation 151 #203 Holofoil NM) has a queue of
   purchase costs. A sale consumes the oldest cost. No physical tagging needed. Accurate per SKU, approximate per
   physical copy. Recommended starting point.
2. **Average cost per SKU.** Simpler, smooths out, good enough for P&L.
3. **Specific identification** (tag each card or keep Whatnot buys in a separate batch until listed). Most exact,
   most work. Worth it only for high-value cards (say $50+), which could be handled as a special case.

---

## 6. Proposed sheet structure (to design in Claude chat)

| Tab | One row per | Source | Key columns |
|---|---|---|---|
| **Purchases** | Won lot | CardComp export (future) or manual from the log | lot_id, date/time, seller, show url, title, hammer, card id, name, set, number, printing, cond bought as, label (tap/view), condMarket at buy, myMax, placedMax |
| **Orders** | Whatnot order / show checkout | Whatnot receipts / purchase history | order id, seller, date, items subtotal, shipping, tax, total charged |
| **Units** | Physical card | Purchases (+ split multi-card lots) | unit id, lot_id, TCGplayer product id, SKU, cond received, allocated cost (hammer + ship + tax), status (bought / received / listed / sold) |
| **Inventory / Uploads** | Roga Sifter -> TCGplayer upload line | Roga Sifter / TCGplayer export | SKU, qty, list price, upload date, batch |
| **Sales** | TCGplayer order line | TCGplayer order export / pull sheets | order id, date, SKU, qty, sale price, fees, shipping paid, net proceeds |
| **P&L** | Card / SKU / month / seller | Formulas over Units + Sales | cost, revenue, net, margin, days held |
| **Exceptions** | Anything unmatched | Formulas | lots with no card, purchases with no receipt, sales with no cost basis, condition downgrades |

Useful rollups once joined:
- **By Whatnot seller:** spend, units, realized margin, days to sell. Which streams are actually profitable.
- **CardComp accuracy:** condMarket at buy vs actual sale price. Shows whether the bid math and condition
  multipliers are right, and feeds back into tuning.
- **Bid discipline:** won at what % of myMax, how often `final` > `myMax`.
- **Velocity:** days from purchase to sale by price band, which checks the speed-based margin table.

---

## 7. CardComp's money model (so the sheet's estimates match the app)

TCGplayer seller fees as coded in CardComp (`FEES`, `SHIPPING` in index.html):

- Commission 10.75% (capped at $75), payment processing 2.5% + $0.30, effective tax on processing 7%.
- Under $5: buyer pays shipping ($1.49). $5+: free shipping, seller pays a PWE (~$0.93). $49.99+: tracked
  (~$5.70). $250+: signature (+$4).
- `netProceeds(sale)` = 0.86575 x sale - fixed costs for that price band (the proportional part).
- `listSale(market)` = market x 1.04 (lists 4% above market by default).
- Max bid = `netProceeds(listSale(market)) / (1 + margin)`; margin 10% floor, up to 25% for slow cards
  (speed-based: vintage / played / promos are "fast", JP and $50+ are slower).
- Condition prices when no verified read: NM x era multiplier (1999-2016 LP 60% / MP 40% / HP 29% / DMG 21%;
  2017-2019 LP 74%; 2020+ LP 80-90%).

Real sales should replace these estimates in the sheet; the estimates are for comparing "expected vs actual".

---

## 8. Proposed CardComp export (next build, not built yet)

A "download purchases" button in the stats panel (or a script over the private log) producing a CSV, one row per
**unit** (multi-card lots expanded):

```
lot_id, ended_at (local), date, seller, show_url, lot_title, seller_cond_line,
hammer, allocated_hammer (multi-card split), ship_shown, placed_max, my_max, i_led, label (tap/view/none),
cardcomp_id, tcgplayer_product_id, tcgplayer_sku (if derivable), name, set, set_code, number, rarity, printing,
language, cond_bought_as, cond_source (tap / seller line / assumed), nm_market_at_buy, cond_market_at_buy,
low_at_buy, target_margin, speed_tier, giveaway (y/n), data_quality_flag (e.g. "pre-fix Oct 16")
```

Small app changes needed first:
1. Add TCGplayer **product id** (the printing's own id) to the card snapshot at buy time.
2. Stable `lot_id` (seller + startedAt + at already identifies a lot; make it a short string).
3. A way to **label a "no card" win after the fact** from the stats table (pick the card), so the 10 unlabeled wins
   and future ones can be fixed.
4. Optional: store Whatnot order totals / tax if Derek pastes or forwards receipts (or keep that in the sheet).

---

## 9. Open questions to settle in Claude chat

1. What does the Roga Sifter upload file look like (columns)? Does it carry TCGplayer SKU / product id, condition,
   printing, quantity, a batch id?
2. What does the existing master tracking sheet / P&L sheet look like today? Which tabs and keys exist already?
3. Whatnot receipts: where do they come from (email, app purchase history, CSV)? Do they show tax and shipping per
   order? Is shipping charged once per seller per show?
4. Cost method: FIFO per SKU, average per SKU, or specific ID for high-value cards?
5. How to treat cards bought elsewhere (bulk lots, local, TCGplayer purchases) so all inventory has a cost basis,
   not only Whatnot buys?
6. Grading / damaged-on-arrival / returns: how should a condition downgrade at receipt change cost or expected value?
7. Sale-side source: TCGplayer order export, pull sheets, Seller Portal payouts? (CardComp's speed tiers were built
   from 12 months of pull sheets + the order list + an inventory snapshot, so those exports exist.)
8. Monthly P&L cadence and what "done" looks like (e.g. per-card profit visible within a week of a sale).

---

## 10. Glossary

- **Lot:** one Whatnot auction item. Generic title, one card shown on camera (sometimes a stack).
- **Hammer / final:** winning bid, whole dollars.
- **Tap label / view label:** CardComp's record of which card a lot was, from a bid tap (strong) or from opening the
  card (weaker).
- **condMarket:** TCGplayer market for the exact printing + condition at buy time.
- **myMax / placedMax:** what CardComp said to bid / what was actually set in Whatnot.
- **SKU (TCGplayer):** product + printing + condition + language. The natural inventory key.
- **Chaos sort:** sorting mixed cards from many sources together, which breaks the physical link to the purchase.
- **Verified price:** a condition price read from the TCGplayer page itself, not estimated.
