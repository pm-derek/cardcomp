# CardComp: browser vs phone

What the desktop (CardComp in Chrome + the extension) does, and where the phone app (android/, phone/bridge.js) stands.
Updated 2026-10-23 with phone 0.6. Keep it current when a row moves.

Status: **done** (working on the phone) · **ported** (built from the extension's code, checked in the browser test,
not yet confirmed on a real stream) · **next** (definitely wanted) · **nice** (worth it later) · **no** (impossible or
not worth it).

## Finding the card and pricing it

| Browser feature | Phone | Notes |
|---|---|---|
| Search, abbreviations, sounds-like, set chips, JP / EN | done | Same app page. |
| Condition grid, cascade, verified prices, bid math, speed margin, profit buttons, your-bid box | done | In the full view (tap the card name). |
| Max bid per condition at a glance | done | The small card: NM / LP / MP / HP buttons. |
| "No such card" | done | Phone only: "no card #X in the catalog (likely under $1.50)". |
| Read the card on stream (read now) | done | Gold bubble. |
| Zoomed re-read, picture match | done | Same code as desktop. |
| Read at each lot's timer start | ported | Setup screen switch, off by default. |
| Read a card held still before the timer (watcher) | next | Needs frames every ~0.7 s between lots: port recog-whatnot.js's thumbnail check to the app. |
| TCGplayer fast read (all conditions in one tap) | ported | Same tcgfast.js; requests go through the app. The browser opens only if it fails. |
| TCGplayer page read (background tab) | no | No background tabs on a phone; the fast read replaces it. |
| Save verified prices for everyone (live.json) | ported | Needs the GitHub token in the app. Reading them already worked. |
| Settings panel (margin %, list markup, multipliers) | nice | Hidden on the phone; it uses the defaults (10% margin, as you run). |
| Filters, tiles / list, game switch | nice | Hidden to save room; search covers it. |
| Cart (multi-card lots) | nice | Hidden on the phone. |

## Bidding

| Browser feature | Phone | Notes |
|---|---|---|
| Copy the bid (whole dollars, floored) | done | Every bid tap. |
| Put the bid in Whatnot's Custom box | ported | Screen reader on. Worked once in 0.5, then failed. 0.6 also finds the button once it says "Max bid added $N", runs on its own thread, and shows why when it fails. |
| Under the next bid: don't open, say "need $N" | ported | Reads "Bid $N". |
| Sold / Awaiting Next Item: enter nothing | ported | |
| Late taps count for the lot that just sold | done | App logic, fed by the lot reader. |
| Press Place bid / Submit for you | no | Whatnot's terms; the human tap is the last check. |

## Lots, wins and the log

| Browser feature | Phone | Notes |
|---|---|---|
| Lot strip (now, next, timer, leader, over your max) | ported | Shows on the small card. |
| Lot boundaries, leaders, hand history, winner, final | ported | whatnot.js's lot state machine, unchanged. Only the screen reading is new. |
| Your wins (incl. learning your username from "You won") | ported | |
| Label lots with the card you tapped or opened | done | App logic. |
| Auction log to cardcomp-data (same rows as desktop) | ported | Same store.js. Needs the GitHub token in the app. Rows carry `src: "phone"`. |
| Stream stats, haul, verdict | ported | Opens in the full view. |
| Change card / condition, remove, clear logged lots | ported | Same store.js edit and prune. |
| Dashboard, buyers (sharp / whale / rival) | ported | Same pages; small on a phone screen. |
| Room: joins, leads | ported | Joins and leads from the screen; chat messages not counted. |
| Viewer count, giveaway entries | ported | |
| Copy debug of the lot row | no | Replaced by automatic screen layouts (uploaded with the token). |
| Two windows / two streams at once | no | One stream on a phone. |

## Things only the phone needs

| Feature | Status |
|---|---|
| Floating panel: drag, resize, collapse to the bubble | done |
| Keyboard never taken from Whatnot | done |
| In-app updates | done |
| Automatic screen layouts for fixing the reader | done (needs the token to upload) |
| iPhone | no: iOS lets no app draw over another |

## To do, in order

1. Confirm on a stream with the screen reader on and the GitHub token saved: the lot strip, a logged lot, the
   Custom fill, the fast read. Fix whatever the uploaded screen layouts show.
2. Watcher: read a card held still before the timer (the desktop reads ~2 per gap).
3. Cart on the phone (multi-card lots), if you bid on lots of several cards from the phone.
4. A phone-sized stats / dashboard layout.
5. Settings on the phone (or carry them over from the desktop).
