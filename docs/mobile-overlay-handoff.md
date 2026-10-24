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

### Whatnot Android app layout (Derek's screenshots 2026-10-23, domvault_card, S25+ full screen)

Same vocabulary as the web page, so the lot reader's rules carry over; differences noted.
- Header, top 9%: avatar, seller name, "★ 5.0 • 🚚 <1d", viewer count with the red live icon, a chevron (leave
  the stream). Under it, left, a junk "Earn more points / Check here" badge (y 14 to 20%).
- Video fills the screen; the held card sits in the middle, roughly y 22 to 75%, x 15 to 85%. Right rail, x 85%+,
  y 35 to 80%: More, Boost, Clip, Share (count), Wallet, Shop (count, thumbnail).
- Chat, left, y 50 to 72%: avatar + username line + message line; "joined 👋" for joins. "Say something..." box
  at y 72 to 78% with the "RUN IT" button.
- Leader / winner line above the lot card, y 80%: "onestop_collectables is winning!", "caydenarterbury won!".
  End screen mid-video: big avatar, the username in yellow, "Won the auction!" (web says "won the auction!").
- Lot card, y 82 to 90%: thumbnail, title "Card on screen #141", condition line "Mint" (one word; the web shows
  "Near Mint · Card"), "$0.38 Shipping + Taxes"; right column price "$4" with "💀 00:01" (timer) or red "Sold".
- Buttons, y 91 to 96%: "Custom" and "Bid $5 >>" (next bid); after a sale the row reads "Awaiting Next Item".
- Custom bid is a bottom sheet over the lower 40%: title, "$2 +Ship/Tax", "00:02 💀", a stepper "−  $3  +" with
  the amount big in the middle, "Max Bid (i) When on, we'll automatically place bids for you, up to this price."
  with a toggle (on), "Submit Max Bid" (web: "Set Max Bid $N"). The keyboard only matters if the amount is
  tapped to type it; the stepper is the default. The fill should set the amount node directly (`ACTION_SET_TEXT`
  if it is editable, else tap the amount then set) and never step "+" dozens of times; a view-tree dump of this
  sheet decides which.
- Split screen (Derek's current flow): Whatnot's half keeps the header, chat box, leader line, lot card and
  buttons and shows almost no video; with the Custom sheet open the video is gone. This is the case for the
  overlay: Whatnot stays full screen, and the card stays visible.
- domvault_card sells Simplified Chinese cards (铁斑叶ex, 洛奇亚V). The reader returns kind `foreign` for them
  and CardComp has no Chinese catalog (TCGplayer carries none), so they stay unmatched; JP prices are not a
  substitute. Out of scope.

### Decisions

Derek, 2026-10-23: Galaxy S25+ (One UI 7 per Derek; check Settings > About phone, One UI 7 ships Android 15 and
One UI 8 Android 16/17; every rule below holds from Android 14 up). Panel: functional, not blocking much, enough
information, ideally everything the web page shows. Bidding: help place the bid if possible. Tracking: the phone
works like the browser extension and everything merges into one log.

1. Native Android app (Kotlin), sideloaded APK built by a GitHub Action, one signing key kept as a repo secret so
   updates install over the old build. No Play Store. Sideloaded apps need "Allow restricted settings" (App info
   menu) once before the accessibility toggle unlocks (Android 13+); the install guide covers it.
2. The overlay is a `TYPE_APPLICATION_OVERLAY` window holding a WebView that loads
   `https://pm-derek.github.io/cardcomp/`. Search, bid math, grid, profit buttons, cart, `autoMatch` and
   `auto-ui.js` run unchanged, and app logic keeps shipping through Pages PRs as today. The APK changes only when
   capture, overlay or the accessibility reader change.
3. Keyboard rule (the PalletTrade bug: Derek could not open Whatnot's Custom bid keyboard while their overlay was
   up). Only one window holds input focus, and the keyboard follows the focused window. An overlay created
   focusable keeps the focus, so Whatnot's own text box never raises the keyboard. Ours is `FLAG_NOT_FOCUSABLE`
   by default; tapping CardComp's search box flips the window to focusable (`updateViewLayout`), the keyboard
   opens over the overlay, and done / Esc / tapping outside flips it back. Whatnot's Custom box then works as if
   the overlay were not there.
4. Bridge = the extension's message protocol, nothing new. The app already talks to the extension with
   `window.postMessage` and accepts a message when `e.source === window && e.origin === location.origin`
   (`extPost`, the `cardcomp-*` handlers in `index.html`, `fromExt` in `auto-ui.js`). Native delivers messages with
   `evaluateJavascript("window.postMessage(<json>, location.origin)")`, which passes that check, and a small page
   script forwards the app's outbound messages to a `@JavascriptInterface`. `cardcomp-ext-ready` makes the app show
   the auto line and send bids through `sendToWhatnot`; the phone answers `cardcomp-bid-ack` like `bg.js` does.
5. Whatnot reader and bid fill = an AccessibilityService, the phone twin of `whatnot.js`. It reads the Whatnot
   app's view tree (text, bounds, view ids) on every change, exactly as the content script reads the web page:
   title, price, timer, bids, leader, Sold / "X won!", "Awaiting Next Item", seller, chat joins; same
   `cardcomp-lot` / `cardcomp-lot-end` records. It also fills the bid: tap a bid in CardComp, the service presses
   Whatnot's "Custom" button, writes the amount into the max bid box (`ACTION_SET_TEXT`), and stops there; Derek
   presses Set Max Bid. Same rules as the extension: under the next bid means Pass, a lot already sold means
   nothing is entered, never Place bid. Clipboard copy stays as the fallback when the service is off. Sideloaded
   only (Play restricts the API), which is fine for one phone. OCR of the frame is not needed for lot state; keep
   it as the fallback if Whatnot's views carry no text (then ML Kit on the bottom strip).
6. The extension's background role moves into a page script, `phone/bridge.js`, loaded only when `window.Android`
   exists: `recogRead` (fetch + SSE, works in a WebView), picture match (`imgmatch.js`, pure functions), the log
   writer (`store.js` logic; GitHub's contents API allows CORS). TCGplayer fast reads (`tcgfast.js`) go through a
   native fetch, since those APIs block cross-origin pages, and land as `cardcomp-tcg-price` like today, so
   verified conditions and `live.json` come from the phone too. Keys (Anthropic, CardSight, GitHub token) live in
   EncryptedSharedPreferences and reach the page through the interface, exposed only to the pm-derek.github.io
   origin. Native keeps only what JS cannot do: capture, overlay window, accessibility, clipboard, the foreground
   service.
7. Capture: MediaProjection, and on Android 14+ pick "A single app" (Whatnot) in the consent dialog: the frame
   then holds Whatnot alone, without our overlay, so no crop tricks. Reduced size (about 720 px wide) into an
   ImageReader. Every 0.7 s a 32x40 thumbnail of the card region (same constants as `recog-whatnot.js`) decides
   "new card held still"; a full frame goes to the bridge for a read. Consent is asked once per session (Android
   14+), with the capture notification.
8. Overlay layout (Derek, 2026-10-23: "it can't cover up damage"; he reads the card's condition off the stream
   before deciding the bid). Rule: the card band, y 22 to 72%, is never covered, except while the keyboard is up.
   Two bands, both remembered:
   - Top strip, y 9 to 22%, under the header, over the "Earn more points" badge and nothing else: card name, set
     and number, the max bid chip (tap sends), NM / LP / MP with net, fast / slow pill, and the lot line (timer,
     price, leader, over your max) from the reader, so the Whatnot lot card can be covered below. The search box
     lives here too; while typing, the keyboard rises from the bottom and the strip grows down to about 40% for
     the suggestion chips and the first results (typing means Derek is not inspecting), then shrinks back when a
     result is picked or the keyboard closes.
   - Bottom panel, y 72 to 100%, on demand (tap the strip's name or "more"): the open card's condition grid,
     profit buttons, cart, stats. It covers the chat box, leader line, lot card and bid buttons, which the strip
     mirrors. It closes on a bid tap, when Whatnot's Custom sheet opens (the reader sees "Submit Max Bid"; the
     sheet must never be hidden), or on a tap outside it.
   - Bubble: the read-now button, drag anywhere, default home top right under the viewer count; also hides both
     bands with a long press when Derek wants the whole stream.
   No full page over the card. Android 12+ blocks touches to the app underneath only inside an opaque overlay's
   bounds, so with both bands closed Whatnot works untouched.
9. One log: phone rows carry the same record v2 shape plus `src:"phone"`, written to `cardcomp-data` through the
   bridge; stats, haul, buyers and the dashboard need no change. `cardcomp-log-read` on load merges desktop and
   phone rows as it does for a second computer today.
10. Recognizer: Claude Sonnet first (proven on desktop, streaming early fill). CardSight as an A/B once the 0.9.0
    desktop scores exist, through the same bridge; the overlay never shows a strong suggestion that is wrong
    (same rules as desktop).

### Phases

Derek's flow (2026-10-23, confirmed): one stream, Whatnot full screen; a card is shown; read by tap or
automatically; the result list shows the best guess and alternatives (search will miss, so the list stays); he
picks the card, confirms the condition, pulls the TCGplayer LP price with one tap (else opens TCGplayer himself);
taps the bid and it lands in the Custom box; he submits; every lot is logged as on desktop.

0. Shell: permission flow (overlay, capture consent, notifications, accessibility), foreground service, the two
   bands plus bubble, the keyboard focus rule, read now: frame to bridge, Claude read, `autoMatch`, result list
   in the bottom panel, grid on pick, tap copies the bid. A "dump screen" button saves Whatnot's view tree for
   phase 1 (and proves the app exposes its text). GitHub Action builds the APK.
1. Whatnot reader and bid fill (accessibility): lot state into `cardcomp-lot` / `cardcomp-lot-end`, the lot line
   in the strip, labels from taps and opened cards, rows to `cardcomp-data`; the bid fill into the Custom sheet
   with the bid-ack flow (Whatnot $X, under next $N, lot sold). TCGplayer fast read through a native fetch
   (`tcgfast.js` logic, all conditions in one tap) and `live.json` writes, so verified conditions come from the
   phone too.
2. Automatic trigger: port the watcher (thumbnail diff, 2 reads per gap, no re-read of the sold card), the
   watcher line, start read about 1 s after the timer begins, picture match.
3. Stats and haul in the strip, CardSight A/B.

### Open questions for Derek

- Android version from Settings > About phone (One UI 7 would be Android 15).
- Top strip plus bottom panel, card band never covered except while typing: right?
- OK to share a few Whatnot view-tree dumps from the phone (lot row, Custom bid modal, end screen) for phase 1?
### Open questions for Derek

- Phone model and Android version.
- Panel size and place: is a 60% wide strip under the seller header right, or a bubble only until a card is read?
- Same private log for phone lots (assumed yes).
- Clipboard enough for phase 0, or go straight to the Custom box fill?

## Built: phase 0 (2026-10-23)

Branch `ccr-0906818a-47v4iz`. APK from the "Phone app" Action (artifact `cardcomp-phone-<sha>`; on main also the
`phone-latest` pre-release). Not yet run on a phone: the cloud sandbox cannot reach dl.google.com, so the Kotlin was
compiled only by the Action (first build green) and the page half was checked in headless Chromium
(`node scripts/phone-check.js`, 25 checks). First live try on the S25+ decides what is wrong.

- `android/` (Kotlin, no library dependencies, minSdk 33, targetSdk 35): `OverlayService` (foreground service of type
  mediaProjection: screen capture in `Capture.kt`, the band window holding CardComp in a WebView, the gold read
  bubble, the notification with Read / Dump screen / Stop), `WhatnotReader` (accessibility service; phase 0 only
  dumps the view tree of every window to the clipboard and `files/dumps/`), `MainActivity` (permission buttons, keys,
  start / stop, copy / share the last dump), `Prefs` (app-private storage; EncryptedSharedPreferences was skipped
  to keep the app dependency-free, the sandbox is the protection).
- `phone/bridge.js`: injected after each page load; plays the extension's background: `cardcomp-ext-ready`,
  `cardcomp-auto-state` (reports protocol 0.9.0 so the app asks for the picture match, which it answers "not on the
  phone yet"), `cardcomp-auto-read` / bubble -> `Android.grab` -> `__phone.frame` -> `recogRead` ->
  `cardcomp-auto` (partial early fill, then the full reading, then the zoom re-read when no number was read),
  `cardcomp-bid` -> `Android.bid` (clipboard) -> `cardcomp-bid-ack {why:"copied"}`, `cardcomp-open-bg` ->
  `Android.open` (TCGplayer in the browser over Whatnot). Log save / read, live store, fast read and snapshot are
  answered "not on the phone yet" or logged: phase 1.
- Layout: `body.phone` plus `ph-strip` / `ph-typing` / `ph-panel`. The strip is the search row (read button, box,
  EN/JP) and `#phonebar`: card name, set and number, the max bid button (taps the card's own chip, so `copyAmt`,
  `LAST_TAP` and the lot label work as on desktop), NM / LP / MP, and a ▼ / ▲ to the bottom panel. The card on the
  strip is the open card, else the best guess, else the top result of a typed search (never the default list).
  A read opens the panel; a bid tap or a tap outside returns to the strip; focusing the search box grows the
  band to 42% (typing) and back. The auto line is clamped to 2 lines (tap to unfold).
- Keyboard rule in `OverlayService`: the band is `FLAG_NOT_FOCUSABLE`; a tap inside makes it focusable (so the
  page's field can raise the keyboard, `Android.focus(true)` shows it), a touch outside or Back drops it.
- Capture: 720 px wide ImageReader, frames discarded until a grab; grab waits up to 1.5 s for a new frame (a still
  screen sends none). "A single app" in the consent dialog keeps the overlay out of the frame.
- `extension/recog/recog-read.js`: the model call moved out of `recog-bg.js` (which imports it with
  `importScripts`); `recog-check.js` loads both. The extension is otherwise unchanged (0.8.2).
- Known gaps for the first try: the WebView's `navigator.clipboard` may fail (the native copy is what counts);
  `fitQ` and the "new lot selects the search box" behaviour will flip the band to typing when the reader lands in
  phase 1 (gate it on the phone); the `#readbig` button still says "read" but the bubble is the primary trigger;
  the Custom bid sheet of Whatnot opens over the bottom panel (phase 1 closes the panel when the reader sees it).

Phase 1 next: a few screen dumps from a stream (lot row, Custom bid sheet with the amount, end screen) -> the
reader in `WhatnotReader.kt` (same `cardcomp-lot` / `cardcomp-lot-end` records as `whatnot.js`), the bid fill,
the log through the bridge (`store.js` logic with the token from `Android.key("github")`), TCGplayer fast reads
through a native fetch.

## First live try (Derek, 2026-10-23, gldshark / maniacocollectibles) and v0.2

What went wrong in 0.1:
- The band was a fixed full-width window pinned under the header or at the bottom, sized as a share of the screen
  whatever it showed: dead black space under the card line, the page scrolled inside it (search row scrolled off),
  it could not be moved, it blocked Whatnot's controls and it covered the app's own Stop button.
- Reads came back "no number read" (Espeon ex read as Mew, Ralts and Yanma "pick 1 of 27"): the capture was
  downscaled to 720 px wide, so a collector number was a few pixels tall, and the zoom re-read only enlarged those
  pixels.

0.2:
- One floating panel: a grip bar on top (drag to move, ◢ at its right drags the width, – folds it into the bubble);
  place and width are remembered. The page reports its own height (`Android.size`), so the panel is exactly as tall
  as what it shows; the native side caps it at 62% of the screen and the list scrolls inside.
- Page modes: card (compact: name with ‹ n/N › through the candidates, the max bid button, NM / LP / MP, 🔍, ▾, and
  a status line with what was read and a "frame" link that shows the frame), list (search, auto line, results,
  the open card's grid), typing (list while the box has focus; a panel in the lower 3/4 moves to the top until the
  keyboard closes). A read lands in card mode with the best guess; Back steps typing -> list -> card -> bubble.
- Every overlay window hides while the CardComp app screen is in front; Start sends the app to the background.
- Capture at the screen's own resolution; a read sends the card band (7% to 84% of the height) at up to 1600 px.
- Checked: `node scripts/phone-check.js` (card ~62 css px empty, ~119 with a result).

## 0.3 (2026-10-23): review before the second install

Derek: the APK download was blocked by Google on the phone (he went through Google Drive from his PC).
- In-app update: the setup screen checks the `phone-latest` release ("built from <sha>") against its own build and
  offers "Install update" (download in the app, platform PackageInstaller, Android asks to confirm; needs "install
  unknown apps" for CardComp once). Works only between builds signed with one key: repo secrets `CC_KEYSTORE_B64` +
  `CC_KEYSTORE_PASS`. Without them each build gets a throwaway key and the update reports "signed with a different key".
- Loader (`OverlayService.LOADER`): after each page load, runs the live site's `phone/bridge.js` (plus
  `recog-read.js`, `imgmatch.js`) when its `VER` is newer than the APK's built-in copy and its `PHONE_API` is <=
  `NATIVE_API`; else the built-in one. Once merged, page-side changes reach the phone with no new APK.

Review findings fixed:
- A WebView outside an Activity cannot show dialogs: a `<select>` dropdown or `confirm()` would crash or fail.
  Alerts are toasts, confirm / prompt answer cancel, every `<select>` is hidden on the phone (model picker moved to
  the app's setup screen; the auto mode switch is hidden, the phone only has off / manual).
- `copyAmt` tries `navigator.clipboard`, refused in an unfocused overlay, then focuses a hidden textarea: that
  would raise the keyboard on every bid. The bridge replaces `navigator.clipboard.writeText` with `Android.copy`,
  and ignores focus on invisible fields.
- Long press fires `contextmenu`, which auto-ui maps to read now: blocked on the phone.
- Keyboard: the panel becomes focusable on touch-down and the keyboard is requested when the window actually gains
  focus (`onWindowFocusChanged`), not after a fixed delay.
- Placement: the panel keeps its dragged position (`homeY`); a taller list lifts it only as needed, it returns when
  the list closes; typing moves a low panel to the top and caps it at 50%.
- Frames: panel and bubble go transparent for ~0.2 s around a grab, so an "Entire screen" capture never puts
  CardComp's own results (card pictures) in front of the model.
- The service is never restarted by the system without a capture token (START_NOT_STICKY, stop on a null intent).
- Condition links: "opened on TCGplayer in your browser: check the price there" instead of "reading every
  condition" (there is no TCGplayer reader on the phone yet).
- Picture match: `cardcomp-auto-img` is answered on the phone. Photos come through `Android.img` (the CDN refuses
  cross-origin reads), ranked with `imgmatch.js` exactly as `recog-bg.js` does; card-line taps count as touching
  the results so a late ranking never reorders under the finger.
- Setup screen: sections (Start, Setup, Keys, Model, Update, Screen dumps), status bar insets, "Open App info"
  for the restricted-settings step, "Save keys and test the API key" (16-token Haiku call).

Independent review of the Android code (fresh agent, same day), fixed in 0.3.1:
- Focus on touch-down would have closed Whatnot's keyboard whenever a bid was tapped and sent Back to the panel.
  The panel is now never focusable on its own: the page asks (`pointerdown` / `focusin` on a visible text field),
  a touch outside drops it, and hiding the panel (–, app in front) drops it too.
- `onRenderProcessGone` rebuilds the WebView in place (a killed renderer used to take the whole app down);
  `onReceivedError` on the main frame retries every 5 s.
- Loader: a live bridge that throws falls back to the built-in one.
- The release (download link, in-app update) is only published from main or a manual "Run workflow".
- Capture: frames are taken on a capture thread, the virtual display has no surface between reads (nothing is
  composited while the stream plays), the second frame after attaching is used, one read at a time ("still reading
  the last card"), a new Start consent replaces the running capture, and our own stop no longer toasts "capture
  stopped".
- Screen dump runs off the main thread. Before a read the keyboard is closed (it would be in the frame). The
  notification lost its Read action (it left the shade open over the frame); the bubble reads.
- Keys go only to the CardComp page (main-frame URL under the app path); WebView debugging only in debug builds;
  navigation inside the panel only within the app path.
- Overlay windows use the whole display (`fitInsetsTypes = 0`), matching the drag limits; monochrome status icon.
- Not changed: the screen reader gets events from every app (no `packageNames` until Whatnot's package id is known
  from a dump); keep it off unless dumping, since it also makes the WebView build its accessibility tree.

## 0.4 (2026-10-23, after Derek's second live try, mewcollector05)

Reads worked (Zeraora V TG16/TG30 exact; Mewtwo-EX 54/99 after the zoomed re-read). Feedback: the panel was hard to
read ("not very aesthetic"), show the card picture, PalletTrade's layout was fine; pulling down the notification to
dump the screen mid-stream is not a thing he will do.
- Compact card redone: card picture on the left (tap: full view), 🔍 and ▾ under it; name, "set · #num · printing",
  ‹ best guess 1/3 ›; a table NM / LP / MP / HP with the price bids use and the max bid as a gold button (whole
  dollars, what gets copied). The rows mirror the card's real condition grid: the card is opened in the hidden
  results and each button taps the grid's own `.bd.cpy`, so cascade, verified prices, lot label and log match the
  full view. System sans-serif. About 215 css px tall with a result.
- Screen layouts are saved by the screen reader itself: on a Whatnot live screen ("Say something" box), when the set of
  auction words changes (timer start, price, bids, Sold / won, Custom bid sheet, Awaiting next item), at most one per
  8 s, 60 kept. With the GitHub token saved they are uploaded to `cardcomp-data/phone-dumps/`. Setup screen shows the
  count and the upload status.
- Restricted settings on One UI 7: the ⋮ "Allow restricted settings" item in App info only appears after a denied
  attempt to turn on the accessibility switch for this install (a reinstall resets it).

## 0.5 (2026-10-23, third live try)

- Typing lost focus on every keystroke (Derek searching Reshiram & Charizard GX SM247): the compact card opened the
  top result to mirror its grid, and opening a card blurs `#q` (index.html row click). Cards are now opened only in
  the compact view, never while the search box is in use. Checked: typing "reshiram charizard sm247" keeps focus and
  the SM247 promo ($44.46) is the top result. The card was in the catalog all along.
- Not in the catalog: when the typed (or read) number matches none of the shown card's, the compact card says "no
  card #X in the catalog (likely under $1.50 or not on TCGplayer): closest by name" and dims the bid buttons.
- Compact card at half height (~100 css px): 46 x 64 thumbnail, one header line (name; set · # · printing · best
  guess; ‹ n/N ›; 🔍), and four condition buttons side by side (cond, max bid, price), each 44 px tall. The read line
  shows only while reading or on an error; the full view (tap the name or picture) shows it with the frame link.
- Custom bid fill (`WhatnotReader.fillBid`, needs the screen reader): a bid tap copies, then opens Whatnot's Custom
  sheet and enters the amount; Derek presses Submit Max Bid. Sold / "Awaiting Next Item" enters nothing; a max under
  "Bid $N" does not open the sheet ({why:"under", min}). Amount by ACTION_SET_TEXT if the sheet's amount is a text
  field, else by its − / + buttons with the amount read back after each press (never above the max). Written from
  the screenshots, not from a dump: the first live use (or the automatic layouts) will show which path runs. Setting
  on the setup screen (on by default). NATIVE_API 4 (bid answers later through `__phone.bidAck`).

## 0.6 (2026-10-23): port what the extension already has

Derek: Custom fill worked once, then failed 2-3 times; port whatever is easy, list the rest (docs/mobile-parity.md).
- Custom fill: also finds the button once it reads "Max bid added $N" (the desktop notes say Whatnot swaps Custom for
  that after a max is set: the likely cause), runs on its own thread, shows why on the small card when it fails, and
  saves + uploads the screen at that moment.
- Lot reader: WhatnotReader streams every text on Whatnot's screen with bounds (~3 a second at most) to
  `__phone.screen`; `readLotPhone` reads the lot from it (layout from Derek's screenshots) and whatnot.js's
  lotTick / endLot run unchanged after it, so the app's lot strip, labels, finishLot and the log work as on desktop.
  Chat lines above "Say something" are never a title; "You won" is checked before "X won!".
- store.js and tcgfast.js run in the page unchanged (`new Function` with a token stand-in and a fetch through the
  app for TCGplayer hosts). Log save / read / edit / prune and live-price saves are answered; a condition link runs the
  fast read and opens the browser only when it fails.
- The page's own focus calls (new lot selects the search box) are undone on the phone (no keyboard per lot).
- Automatic read when a lot's timer starts (setup screen switch, off by default), keyed to the lot.
- Checked in headless Chromium against Android-layout screen texts: 53 checks (live lot, Custom sheet, sale, next lot,
  own win, tap label in the log row, auto read once per lot, fast read then browser).

## 0.7 (2026-10-23): background condition read, DMG, narrower panel, bigger card

Derek: run the quick TCGplayer check on LP / MP / HP / DMG every time a card opens; DMG was missing; show two or three
pills at a time and scroll sideways; the panel takes most of the width; bigger card.
- Every card the small card shows gets the fast read in the background (`autoFast`): same request a condition link
  sends, put in the app's own `FAST_REQ` slot so its ack handler applies every condition and the grid (mirrored by
  the pills) re-renders. Once per printing per 10 min, 0.6 s after the card settles (stepping with ‹ › does not fire
  a read per step). A failed automatic read stays quiet (no "reading the page instead" note, no browser). The
  controls row says "TCG" (pulsing while reading, green when read, struck through when it failed), else the match
  label (guess / pic).
- Pills NM / LP / MP / HP / DMG in a sideways scroller (scroll snap), two fully visible with the next peeking; the
  scroll position is kept across repaints of the same card.
- Card picture 78 x 109 on the left; name, set line, then ‹ n/N › / status / 🔍; pills under them. ~133 css px tall
  at 250 px wide.
- Native: the small card starts at 60% of the screen width (new pref `panelW2`, so the old full-width setting is not
  carried over); the full view (list / typing) widens to the whole width and returns to Derek's width and place.

## 0.8 (2026-10-23): prices and alerts only; getting back to the small card

Derek: too much text under the card ("I just need pricing and any alerts"), text can be smaller; after tapping 🔍 a
few times he could not shrink the panel again.
- The small card hides the lot strip (it is still read: stats, labels, log) and shows only its alerts in
  `#phonealert`: "⚠ sharp / whale / rival buyer leads", "over your $X", "priced out: next bid $N" with its "bid $N"
  button (taps the strip's own), and the late-tap note. Name 13 px, set line 10 px, status 10.5 px.
- Back to the small card: a result tapped in the full view returns to the small card showing it; a touch on Whatnot
  outside the panel (ACTION_OUTSIDE -> `__phone.outside`) returns from the full view, and from typing.

## 0.9 (2026-10-23): still stuck after 🔍

Derek, on 0.8: still stuck after the magnifying glass. The headless check returned to the small card, so the stuck
state was on the device. Three paths fixed:
- The panel's top-left button is native: "✕" while the full view is open (back to the small card), "–" on the small
  card (fold into the bubble). ✕ restores the small card's width and its last height natively (`cardH`), drops
  focus and the keyboard, then tells the page; it works whatever state the page is in.
- Folding with – from the full view resets to the small card, and `layout("card")` never unfolds a folded panel
  (only "card-show", sent when a read lands, and the full view do). Before, the panel came back still in the full view.
- 🔍 makes the window focusable before it focuses the search box (Chromium holds focus events in an unfocused window,
  so the box could sit focused with no keyboard and no typing mode). setMode always reports the height afterwards and
  survives a paint error.
- NATIVE_API / PHONE_API 6.

## 0.10 (2026-10-23): the page was magnified, not stuck

Derek's screenshots on 0.9: the panel's contents were magnified ~2.5x (giant "now $18", the card picture cropped, a
huge MP pill), in the full view and the small card alike. "Zoom out doesn't work" meant that, not the panel size:
after the panel's width changed (🔍 widens it, ✕ narrows it), the WebView kept a page scale above 1. The headless
check had shown the same crop once (0.8, "phone-card-alert.png") and it was wrongly put down to the test browser.
- Page scale locked at 1: WebView `useWideViewPort=false`, `loadWithOverviewMode=false`, no built-in zoom,
  `textZoom=100`; the bridge rewrites the viewport meta to `minimum-scale=1,maximum-scale=1,user-scalable=no` and
  sets `text-size-adjust:100%`. Check: `visualViewport.scale` is 1 after full view -> small card.
- Pinch (Derek's idea): two fingers on the panel set the contents' size, 60% to 160% (CSS zoom on <html>, remembered
  in localStorage `cardcomp_phone_zoom`); the panel height follows (offsetHeight x zoom). Pinching together past
  the smallest size folds the panel into the bubble and keeps the size. `touch-action: pan-x pan-y` keeps scrolling.

## 0.11 (2026-10-23): market and break-even on every pill

Derek: each bid button should show market price, break-even and the suggested bid. Pill: condition, suggested max
bid (big, what a tap sends), "mkt" (the price bids use: TCGplayer's market or the estimate, from the grid's
data-mkt) and "b/e" (the app's `bidForMargin(price, 0)`: fees, shipping, list markup, 0% margin; the desktop tiles'
"b/e"), whole dollars rounded down. Checked: b/e equals the app's math and is never below the suggested bid.

## 0.12 (2026-10-23): pick the card unless the read is sure

Derek: "sometimes the wrong card is delivered... unless the result is an exact auto plus picture match, don't show
the card with the NM / LP pricing; show the likely cards and I'll pick."
- After a read (results marked "· auto" in #status), the small card prices a card straight away only when it is
  sure: a strong exact match ("✓ auto", never wrong on desktop) or the text read and the picture agreeing ("auto +
  picture", `.byboth`). Otherwise it shows "Which card? read <what was read>" and a sideways row of the likely
  cards (photo, name, set #, NM price), best guess first in gold, ~3 visible. Tapping one prices it (and counts as
  touching the results, so a late picture ranking never reorders under the finger); ≡ goes back to the choices.
- Nothing is opened (no background TCGplayer read) until a card is picked. Typed searches work as before.

## 0.12.1 (2026-10-23): phone wins on the desktop tracker

Derek: wins on mobile showed as "no card" in the browser stats (rudeboi75404). Both devices log the same lot with their
own timestamps, so the log held two rows per lot (desktop: no card; phone: the card). 11 of tonight's 17 phone rows had a
desktop twin. `store.js` `mergeRows` and the app's `storeLotRows` now fold rows from different devices with the same
seller, title, final and winner within 2 min (richer row kept, the other fills card / recog / max). The app re-reads the
last 2 days of the log 90 s after each lot, so phone wins reach an open desktop within ~3 min. The phone reader also
dropped a repeat of the lot that just sold (#79 logged twice, 18 s apart, after the sold screen flickered back to a
timer). Tested on tonight's real log: 77 rows -> 67, wins with a card 15 -> 17; phone-check adds the flicker case.
Desktop needs index.html on main and the unpacked extension's store.js updated; the phone bundles store.js.

## 0.13 (2026-10-23): printing chips on the small card

Derek: "How do you select printing like reverse Holo and Holo? Need an easy flow." The small card priced whatever
printing the open card picked (the most expensive one) and switching meant the full view. Now a card with several
printings shows a row of chips under the set line ("Master Ball $30.13 · Poké Ball $2.85 · Reverse $0.49 · Holo $0.31",
NM market each): one tap picks it in the open card, so the pills, the fast read, the bid and the logged printing all
follow. When a read names the finish (automatch.js `finishKey`: reverse, holo, Poké Ball, Master Ball, non-holo), the
card starts on that printing and its chip has a dashed edge; a chip Derek tapped is never overridden. Only cards with
2+ printings get the row (161 px tall at 250 px wide with it). Bridge 0.13.0, no APK change (the live bridge loads).
