# Handoff: CardComp on the phone, over the Whatnot app

Status: idea, not built. Written 2026-10-23 to start a fresh conversation. Read `CLAUDE.md` first (the whole app,
bid math, the extension, the recognition experiment); this file covers only what is specific to a phone build and
what was learned so far that a phone build should reuse.

## The ask (Derek)

Build a mobile app that works over the Whatnot app: recognize the card on stream, show CardComp's prices and max bid
on top of the stream, without leaving Whatnot. He bids on his phone a lot; today the phone path is CardComp in a
browser, split screen, typed search, bid copied to the clipboard (`CLAUDE.md`: "Mobile stays clipboard"). The desktop
path (Chrome extension, side panel) already reads the stream, recognizes cards and fills bids; the phone has none of it.

His phone looks like Android (status bar in his screenshots: "6E" Wi-Fi, Samsung-style battery pill). Confirm first:
it decides almost everything below.

## Competitor: PalletTrade (Derek's screenshots, 2026-10-23, everzonium_tcg stream)

- Mobile app with an "Auto Scan" mode: "Cards are identified automatically as they appear on stream. Prices pop up
  here on their own, no tapping needed." A dark panel floats over the top ~40% of the Whatnot app (an Android
  overlay window), with an X to close.
- A red screen-recording pill sits in the status bar while it runs: it captures the screen with Android's
  MediaProjection (screen capture permission), not the Whatnot video itself.
- Result card: product photo, name, set and number ("Stufful, Crimson Invasion #55/111"), and a condition table
  NM / LP / MP / HP / DMG by printing (Normal, R. Holo). Prices only.
- Seen working: Stufful identified while held tilted, close to the camera, 2 s left on the timer.
- Seen failing:
  - After lot #99 sold for $18 with an empty easel, it showed Area Zero Underdepths ($0.17), probably a card lying
    on the table. It reads background cards; our prompt ignores cards on stands, in binders or on the table.
  - Raw prices with no sanity: Stufful HP $0.28 above NM $0.26 and LP $0.19 (CardComp caps a worse condition at the
    one above it).
- Missing: no max bid, no margin or fee math, no condition logic, no bid entry, no lot log, no stats.
- The panel covers the seller's upper video; a smaller or draggable panel would be kinder.
- Their site did not load from the cloud sandbox. A search shows a "PalletTrade Pro" desktop browser extension
  ($9.99/mo or $99.99/yr, price badges on marketplace listings, paired through the mobile app). Slabbr is a similar
  Firefox add-on for Whatnot (key press scans the frame, $9.99/mo for 75 scans a day, $24.99/mo for 300).

## What already exists to reuse

All in this repo unless noted.

- The app: `index.html` on GitHub Pages (`https://pm-derek.github.io/cardcomp/`). Search, condition grid, bid math,
  speed-based margin, profit buttons, cart. It already runs fine in a phone browser.
- Catalog: `data.json` beside it (`{updated, floor, sz, cards}`, ~8 MB raw, ~1.2 MB gzipped; card shape in
  `CLAUDE.md`). Verified condition prices: `live.json` on the public `live` branch (fetched raw, no token).
- Bid math, tiers, speed: `bidForMargin`, `netProceeds`, `listSale`, `TIERS` / `tierFor`, `speedOf`, `condGridHTML`
  (cascade, caps, stale-market rule, the line under each condition). Port or reuse, never re-derive.
- Recognition, app side: `recog/automatch.js` `autoMatch(read, ctx)` turns a reading
  `{name, number, total, language, rarity, stamp, finish, set, confidence}` into candidates and a suggestion. It
  needs the globals `CARDS`, `SET_SIZE`, `bestMarket` from `index.html`. Rules learned the hard way are in its header
  comment and in `CLAUDE.md` (Japanese cards: trust the number over the name; never a closest-by-name fallback;
  a premium rarity read never picks a 5x pricier printing).
- Recognition, model call: `extension/recog/recog-bg.js` `recogRead` (Claude, streamed JSON with short keys,
  `RECOG_SYSTEM` / `RECOG_ASK` / `RECOG_SCHEMA`, early fill from the partial reply, zoom re-read of the card box).
  CardSight client in the same file (`csIdentify`, `csToRead`, `csBudget`).
- Picture match: `extension/recog/imgmatch.js` (pure functions on RGBA pixels, runs anywhere): ranks the frame
  against TCGplayer photos (`https://tcgplayer-cdn.tcgplayer.com/product/<pid>_200w.jpg`) of the name's printings.
- Trigger logic: `extension/recog/recog-whatnot.js` (thumbnail diff every 0.7 s, "card held still", read before the
  timer, at most 2 pre-start reads per gap, never re-read the sold card the seller still holds).
- Lot reading on desktop: `extension/whatnot.js` reads the Whatnot web page's text (title, timer, bids, leader,
  Sold, "Awaiting next item", seller). The phone app has no page to read: see "Lot state" below.
- The log: private repo `pm-derek/cardcomp-data`, one `log-YYYY-MM-DD.json` per day, record v2 in `CLAUDE.md`.
  `extension/store.js` writes it through the GitHub contents API (token on the device, never in this public repo).
  Dashboard and stream stats read it.

## Recognition results so far (desktop, from the log)

`node scripts/recog-score-log.js <cardcomp-data>` scores readings against the card Derek tapped or opened.

- Since the picture match shipped (2026-10-20): the right card on top in 45 of 51 lots (88%), text read or picture.
- Claude (Sonnet) reads take ~2 to 3 s; the early fill shows name and number after ~1.5 s.
- Japanese is weaker: the name is printed in Japanese, the model names the Pokemon partly from the art. Number,
  total and set code come out right (Mega Golurk ex 109/076 M6 was read as "Mega Metagross ex 109/076 (M6)").
- CardSight (cardsight.ai, a card recognition API, claims 99.5% in under 0.4 s, Free 750 calls a month, Pro $14.95
  for 5,000) runs side by side with Claude on desktop since extension 0.9.0: a coin per read picks which answer
  shows, both go on the log row (`recog.src`, `recog.alt`, `recog.cs`). Score it before choosing the phone's reader.

## Platform constraints

Android (likely Derek's phone):
- Screen capture: MediaProjection. The user approves capture each session (Android 14+ asks every time and shows a
  status bar indicator); needs a foreground service of type `mediaProjection`. Apps that set FLAG_SECURE come out
  black; Whatnot evidently does not (PalletTrade captures it).
- Overlay: "Display over other apps" (SYSTEM_ALERT_WINDOW, `TYPE_APPLICATION_OVERLAY`). A small draggable panel or
  bubble that expands; it must not cover Whatnot's bid buttons.
- Lot state (timer, Sold, "Awaiting Next Item", title "#80", "X won!", "Bid $1"): two ways.
  1. On-device text recognition (ML Kit, free, ~100 ms) on the bottom strip of each captured frame. No special
     permission, works whatever Whatnot's layout code is.
  2. An AccessibilityService reading Whatnot's view tree, like `whatnot.js` reads the web page. More exact, but
     Google Play restricts that API to accessibility use, so it suits a sideloaded personal build only.
- Bid entry: the overlay copies the floored max bid to the clipboard (today's phone flow). An AccessibilityService
  could type it into Whatnot's Custom box; `CLAUDE.md` says not to build that unless Derek asks and it proves worth
  it. Never press Place bid (Whatnot's terms bar automated bidding; the human tap is the last check).
- Distribution: a sideloaded APK built by a GitHub Action is enough for one user; Play Store review adds policy work
  (accessibility, screen capture disclosures).

iOS (if the phone is an iPhone, or for later):
- No app can draw over another app. Options are weak: a ReplayKit Broadcast Upload Extension can capture the screen
  (50 MB memory limit), with results shown as a Live Activity / Dynamic Island or a notification, or a
  picture-in-picture window. Plan for Android first.

## Suggested shape (to confirm in the new conversation)

Proposed, not decided:

1. Native Android shell (Kotlin): MediaProjection capture service + overlay window + key storage
   (EncryptedSharedPreferences for the Anthropic, CardSight and GitHub keys; never in a repo).
2. The overlay hosts a WebView running CardComp itself (`index.html` + `data.json`, cached on the device). That
   reuses search, bid math, the grid, profit buttons and `autoMatch` unchanged. The native side posts the same
   `cardcomp-auto` / `cardcomp-lot` messages the Chrome extension sends today, through a JS bridge, so
   `recog/auto-ui.js` and the lot strip work as they do on desktop.
3. Recognition in the native side: frame diff trigger (port `recog-whatnot.js`), card crop, then Claude and / or
   CardSight (pick from the side-by-side scores), then the picture match (port `imgmatch.js`, or run it in the
   WebView). On-device OCR of the number and set code could pre-filter cheaply.
4. A compact overlay layout for the phone: card name, the max bid big (tap copies), NM / LP row, expand for the grid.
   Keep CardComp's rules: whole dollars floored, net shown, worse condition never priced above a better one.
5. Phases: (0) capture + overlay + CardComp WebView + a "read now" button; (1) automatic trigger before the timer;
   (2) lot state from the frame, labels and the private log; (3) only if asked: bid entry.

## Questions for Derek at the start

- Android or iPhone? Model and Android version.
- Personal sideloaded app OK, or does it need the Play Store?
- Which recognition to start with: Claude, CardSight, or both side by side (needs the desktop scores first).
- Overlay size and position: how much of the stream can it cover? Tap to copy the bid enough, or must it fill
  Whatnot's Custom box?
- Should phone lots go to the same private log (stats and dashboard then include phone streams)?

## Rules carried over

- Never auto-press Place bid.
- API keys and the GitHub token live only on the device (or in extension Options on desktop), never in a repo or a chat.
- The log carries usernames and Derek's purchases: it stays in the private `cardcomp-data` repo.
- No em dashes in copy for Derek. Lean: build the smallest thing that answers the question first.
