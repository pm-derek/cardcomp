# Handoff: CardComp on the phone, over the Whatnot app

Status: planned, not built. Written 2026-10-23; plan agreed in the follow-up conversation the same day (section "Plan" at the end). Read `CLAUDE.md` first (the whole app,
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
  for 5,000) runs side by side with Claude on desktop in extension 0.9.0: a coin per read picks which answer
  shows, both go on the log row (`recog.src`, `recog.alt`, `recog.cs`). 0.9.0 is on branch
  `claude/screenshot-test-setup-4marhe`, not on main (main is 0.8.2); the log had no CardSight rows on 2026-10-23.
  Score it before choosing the phone's reader.

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

## Plan (2026-10-23, after Derek's screenshots)

### Confirmed

- Android. Chrome for Android in the split-screen shot, Samsung-style status bar, and Derek had to turn on a
  setting before the PalletTrade overlay would show: that is "Display over other apps" (SYSTEM_ALERT_WINDOW), an
  Android-only permission. The red status-bar pill while it runs is MediaProjection screen capture. Both match the
  Android design above. Still to confirm: phone model and Android version (14+ asks for capture consent every
  session, and the capture notification is mandatory).
- Derek's phone flow today (domvault_card, a JP stream): Whatnot on top, Chrome with CardComp below, keyboard over
  half the screen. Nothing of the stream is left once he types. The overlay has to be small and keyboard-free most
  of the time.
- PalletTrade meters screen-capture minutes (Free 1 h a month, Pro $9.99 for 1 h plus unlimited tap-to-scan,
  Pro Auto $14.99 for 20 h, top-ups $4.99 an hour), so they recognize continuously. Our trigger reads per card
  (thumbnail diff, 2 pre-start reads per gap), about 2 Sonnet reads a lot: roughly $1 an hour at 100 lots an hour
  on Derek's own key, no subscription. Their key facts page: English only, vintage set disambiguation weak, stamped
  variants unsupported. CardComp already does JP (number over name), 1st Edition / Shadowless printings, promos and
  the bid math: that is the gap to fill, not raw prices.
- Desktop recognition, scored 2026-10-23 (`recog-score-log.js`, 974 lots logged, 108 with a card to score against):
  right 41%, listed but not picked 30%, wrong 16%, not listed 13%; picture match puts the card on top in 49 of 55
  (89%); strong suggestion wrong 0 of 4. Good enough to ship as "best guess marked, alternatives listed", which is
  how the phone overlay will show it too. CardSight numbers: none yet (see above).

### Decisions

1. Native Android app (Kotlin), sideloaded APK built by a GitHub Action, one signing key kept as a repo secret so
   updates install over the old build. No Play Store.
2. The overlay is a `TYPE_APPLICATION_OVERLAY` window holding a WebView that loads
   `https://pm-derek.github.io/cardcomp/`. Search, bid math, grid, profit buttons, cart, `autoMatch` and
   `auto-ui.js` run unchanged, and app logic keeps shipping through Pages PRs as today. The APK changes only when
   capture, overlay or OCR change.
3. Bridge = the extension's message protocol, nothing new. The app already talks to the extension with
   `window.postMessage` and accepts a message when `e.source === window && e.origin === location.origin`
   (`extPost`, the `cardcomp-*` handlers in `index.html`, `fromExt` in `auto-ui.js`). Native delivers messages with
   `evaluateJavascript("window.postMessage(<json>, location.origin)")`, which passes that check, and a small page
   script forwards the app's outbound messages to a `@JavascriptInterface`. `cardcomp-ext-ready` makes the app show
   the auto line and send bids through `sendToWhatnot`; the phone answers `cardcomp-bid-ack` after the clipboard
   write.
4. The extension's background role moves into a page script, `phone/bridge.js`, loaded only when `window.Android`
   exists: `recogRead` (fetch + SSE, works in a WebView), picture match (`imgmatch.js`, pure functions), the log
   writer (`store.js` logic; GitHub's contents API allows CORS), and the pre-start watcher port if it is not done in
   Kotlin. Keys (Anthropic, CardSight, GitHub token) live in EncryptedSharedPreferences and reach the page through
   the interface, exposed only to the pm-derek.github.io origin. Native keeps only what JS cannot do: capture,
   overlay window, ML Kit OCR, clipboard, the foreground service.
5. Capture: MediaProjection into an ImageReader at reduced size (about 720 px wide). Every 0.7 s a 32x40
   thumbnail of the card region (same constants as `recog-whatnot.js`) decides "new card held still"; a full frame
   goes to the bridge for a read. The capture includes our own overlay, so the card crop and the OCR strip exclude
   the panel's rectangle, and the panel sits where cards are not (top strip).
6. Overlay layout: a bubble that expands to a panel docked under the seller header, about 60% wide, draggable,
   collapse to the bubble with one tap. Panel shows: name, set, number, the max bid big (tap copies, whole dollars
   floored), NM / LP / MP row with net, "more" for the full grid and search. Keep it small: Android 12+ blocks
   touches to the app underneath only inside an opaque overlay's bounds, so a small window never gets in the way
   of Whatnot's bid buttons. Never over the lot row or the Bid / Custom buttons.
7. Lot state from the frame: ML Kit on-device text recognition on the bottom third of each capture (title "#82",
   "$1", timer, "Sold", "X won!", "Awaiting Next Item", "Bid $1", shipping line, "Near Mint · Card"). The OCR
   lines (text plus y position) feed the lot logic of `whatnot.js` once its text-to-state part is separated from
   the DOM walk, so the phone and desktop share one lot reader and the record v2 shape. Logged to the same private
   log, so stats and the dashboard include phone streams. No AccessibilityService for reading.
8. Bid entry: clipboard (today's phone flow; a foreground service may write the clipboard on Android 10+). The
   Custom box fill by AccessibilityService is phase 3 and only if Derek asks after using phase 0. Never press
   Place bid.
9. Recognizer: Claude Sonnet first (proven on desktop, streaming early fill). CardSight as an A/B once the 0.9.0
   desktop scores exist, through the same bridge; the overlay never shows a strong suggestion that is wrong
   (same rules as desktop).

### Phases

0. Shell: permission flow (overlay, capture consent, notifications), foreground service, overlay WebView with
   CardComp, a read-now button on the bubble: frame to bridge, Claude read, `autoMatch`, results in the panel, tap
   copies the bid. GitHub Action builds the APK. This already beats PalletTrade for Derek: max bid, JP, printings.
1. Automatic trigger: port the watcher (thumbnail diff, 2 reads per gap, no re-read of the sold card), the
   watcher line, and the lot timer from OCR so the start read lands about 1 s after the timer begins.
2. Lot state and the log: OCR strip to the shared lot reader, `cardcomp-lot` / `cardcomp-lot-end` into the app,
   labels from taps and opened cards, rows to `cardcomp-data` through the bridge, stats and haul in the panel.
3. Only if asked: AccessibilityService fills Whatnot's Custom bid box with the tapped bid.

### Open questions for Derek

- Phone model and Android version.
- Panel size and place: is a 60% wide strip under the seller header right, or a bubble only until a card is read?
- Same private log for phone lots (assumed yes).
- Clipboard enough for phase 0, or go straight to the Custom box fill?
