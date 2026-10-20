# Handoff: auto-recognize the card on a Whatnot stream

Status: idea, not built. Written 2026-10-16 to start a fresh conversation. Read `CLAUDE.md` first; this file
only covers what is specific to this idea.

## The ask (Derek)

"Is it possible for us to start reading the Whatnot stream and taking screenshots of the card to auto search
for cards?" He wanted scope and cost before any build.

## Why it matters

1. Speed: no typing. The card is searched and opened before Derek reaches for the keyboard.
2. Data (the bigger win): most sellers run generic lots ("$1 START SINGLES #76") and never name the card, so
   today a lot is labeled with a card only when Derek taps a bid or opens a card (`label: "tap"` / `"view"`).
   Lots he ignores are logged unlabeled, which leaves holes in stream stats ("selling at % of market") and in
   bidder data. Auto-recognition would label nearly every lot (`label: "auto"`).

## What already exists to build on

- Chrome extension in `extension/` (MV3, side panel iframes CardComp). Message flow: CardComp page posts
  `cardcomp-*` messages to its window and parent; `cardcomp.js` / `panel.js` forward to `bg.js`; `bg.js` talks
  to the Whatnot tab (`whatnot.js`) and the TCGplayer tab (`tcgplayer.js`).
- `whatnot.js` already reads the lot every page change: title, seller condition line, price, timer, bids,
  leader, sold / won, "Awaiting next item". A new lot (title change, or bid count reset) is the natural trigger
  for capture. See the "Real layout" bullets in `CLAUDE.md` for the exact on-screen text.
- CardComp search already resolves "maushold ex 233/182": the number must match exactly and the set's printed
  size (`sz`) must include 182. So the model only needs to return name + collector number + language.
- Lot labeling: `LAST_TAP` / `LAST_VIEW` in `index.html`, `viewLabel()`, `cardSnap()`. An auto label would be a
  third source, lower priority than a tap or an open.
- Stream stats (`recordLotStat`, `lotStats`, `paintLotStats`) already consume labeled lots.
- Secrets pattern: the GitHub token lives in `chrome.storage.local`, set on `extension/options.html`. An
  Anthropic API key would follow the same pattern and stay in the extension (never in the public page).

## Proposed pipeline

1. Trigger: `whatnot.js` sees a new lot or "Awaiting next item" followed by a new card on camera.
2. Capture: every ~1 s until two consecutive frames are near-identical (card held still), max ~6 frames.
   - Option A: `chrome.tabs.captureVisibleTab` from `bg.js`. Works while the Whatnot tab is the visible tab
     (it is, the side panel sits beside it). Verify the permission it needs in MV3 (`activeTab` vs host
     permission vs `<all_urls>`); adding `<all_urls>` would widen the install prompt.
   - Option B: draw the `<video>` element to a canvas in `whatnot.js`. Cheaper and no permission change, but the
     canvas is tainted if the stream is cross-origin without CORS. Test first.
3. Crop: the video's center region, then downscale (~600 x 840 for a held card). Image cost scales with pixel
   area (about one token per 28 x 28 patch), so a crop is ~650 tokens.
4. Identify: one Claude vision call from `bg.js` (key from Options). Ask for strict JSON:
   `{name, number, set_total, language, foreground_card_confidence, notes}`. Prompt must say "the card held in
   front, ignore cards on stands in the background" (quagstradingco's table has Vulpix / Nidoran behind).
   Use structured outputs; never forced tool_choice (400 on current models).
5. Search: post `cardcomp-auto` to CardComp with the query; CardComp runs it, opens the top match, shows
   "auto: Maushold ex PAR 233 · tap to confirm", and sets an auto label for the lot.
6. Never bid. Never press anything in Whatnot. Derek still confirms and taps.

## Cost (Anthropic first-party prices, cached 2026-10-06; re-check before building)

| Model | $/MTok in / out | Per card (~900 in, ~200 out) | Per month at ~2,600 lots |
|---|---|---|---|
| claude-haiku-5-5 | 0.10 / 0.50 | ~$0.0002 | ~$0.50 |
| claude-sonnet-5-5 | 2 / 10 | ~$0.004 | ~$10 |
| claude-opus-5-5 | 4 / 20 | ~$0.008 | ~$20 |

Volume assumption: 4 streams a week x 90 min x ~100 lots an hour. Multiple frames per lot multiply the cost.
Billing is a separate Anthropic API key (console.anthropic.com), not Derek's Claude subscription.
Latency target: under ~3 s from card held still to card opened (Haiku ~1-2 s).

## Risks

- Background cards in frame: the crop and the prompt must pick the foreground card.
- Glare, sleeves, top-loaders, fingers over the collector number: the name usually survives, the number does
  not always; without the number, reprints map to the wrong set. Fall back to name-only search + "pick set".
- Printing (reverse holo vs holo, 1st Edition stamp): hard from compressed video. Keep the printing chips.
- Condition: not judgeable from video. Keep the seller's line (`sellerCond`).
- Japanese cards: name text in Japanese; the number still helps. Test separately.
- Privacy: frames go to the Anthropic API. Only the crop, never the chat panel.
- Whatnot: reading pixels is the same posture as the existing text reader; it does not bid.

## Alternatives considered

- Free in-browser OCR (e.g. Tesseract.js): no per-card cost, but weak on stylized card fonts at stream
  resolution. Expect roughly half of names right, numbers worse.
- Image matching against every catalog image (embeddings index over ~all `img` URLs in data.json): best at
  telling art and sets apart, no text reading needed, but about a week to build and host. Could be a later
  second stage behind the vision call.

## Suggested first step (cheap, decides everything)

1. Derek saves ~50 screenshots during a stream (mix of modern, vintage, JP, sleeved, glare).
2. Run them through Haiku 5.5 and Sonnet 5.5 with the same prompt; score name, number and final CardComp match.
   Total cost under $0.50.
3. Pick the cheapest model that clears the bar (suggest: right card in the top result 85%+ of the time).
4. Only then build the capture + trigger + UI.

## Open questions for the next conversation

- Which capture path works on Whatnot (canvas vs captureVisibleTab), and what permission it costs.
- How to detect "card held still" cheaply (frame diff on a tiny thumbnail).
- Auto-open the card, or only show a suggestion chip? (Derek dislikes UI that jumps; the strip already shows
  "logging: ...".)
- Should an auto label count in stream stats the same as a tap / view, or be flagged as lower confidence?

## Conventions to keep

- No em dashes in copy for Derek. Terse, numbers first.
- One PR per round; Derek merges (or says "merge").
- Test against mocks in headless Chromium (Playwright is preinstalled; `/opt/pw-browsers/chromium-1194`), since
  whatnot.com is not reachable from the cloud session.

## Screenshot test: how to run (built 2026-10-16, not yet run on real frames)

`scripts/recog-test.js` is the first step above, ready to run. It needs Derek's screenshots and an API key; the
cloud session has neither (no key in the environment, and the image hosts are blocked), so it was verified
with mock frames in `--fake` mode (labels fed back as the model's answer, scored through the real app) and
`--dry-run` (image prep + the exact request body). Request shape checked against the structured-outputs and
vision docs on 2026-10-16.

1. Save 30-50 screenshots of held cards during a stream into one folder (PNG or JPG, the whole browser window
   is fine; the script can crop). Mix modern, vintage, JP, sleeved, glare, finger over the number.
2. Add `labels.csv` beside them:
   ```
   file,name,number,total,lang,notes
   IMG_0001.png,Maushold ex,233,182,en,sleeved
   IMG_0002.png,Charizard,4,102,en,glare
   IMG_0003.png,Pikachu,25,,en,promo
   ```
   `total` blank for promos; `lang` en or jp (default en); notes free text.
3. Key from console.anthropic.com (separate billing from the subscription), then:
   ```
   npm i playwright && npx playwright install chromium     # once, in the repo dir
   ANTHROPIC_API_KEY=sk-ant-... node scripts/recog-test.js --shots ~/shots
   ```
   50 shots x 2 models is well under $0.50. Writes `results.md` / `results.json` into the shots folder:
   per model name %, number %, CardComp top-1 %, top-3 %, median and p90 latency, $ per card; then one row
   per shot with what each model read and which card the app opened on it.
4. Options: `--crop 0.2,0,0.5,1` (fraction x,y,w,h of the frame; try the video region), `--max-edge 1000`,
   `--effort low|medium`, `--models haiku,sonnet,opus`. Rerun with a crop if background cards leak in.

What the harness already told us (mock frames, real data.json):
- The app resolves `name number/total` for the mock labels (Maushold ex 233/182, Charizard 4/102, Pikachu 25,
  JP Pikachu 20/103 in JP mode). The harness reports a "label resolves" ceiling so a bad label is not blamed
  on the model.
- Owner-prefixed names miss: "Team Rocket's Meowth 18" parses "Team Rocket" as the set and searches "s meowth"
  in Team Rocket (returns Dark Alakazam #18). "meowth 18" finds the WOTC promo. The model will read the name as
  printed, so the pipeline (or `parse`) needs to treat "<set name>'s" as an owner prefix. Only set names
  collide: Misty's / Brock's / Erika's / Rocket's (Gym sets) parse as names and resolve (checked headless).
- Image cost: one visual token per 28x28 patch. A 1280x720 frame is ~1,150 tokens; cropped to the middle
  half and downscaled to 640x720 it is ~600. Haiku 5.5 and Sonnet 5.5 both take `output_config.format`
  (structured outputs, no beta header); the script falls back to plain-JSON text if a model rejects it.

## Results: 20 real Whatnot screenshots read by Claude (2026-10-16)

Derek pasted 20 frames from 4 sellers into the session; Claude (Opus 5.5) read each blind, Derek gave the
truth, and each reading was searched in the real app headless. Per-shot detail: `docs/recog-shots-2026-10-16.csv`.
The images themselves stay out of this public repo (they show chat usernames). This is a ceiling: Haiku /
Sonnet still need the API run (`scripts/recog-test.js`) before picking a model.

| | count |
|---|---|
| name right | 20 / 20 (incl. 2 JP, 1 vintage behind a wall of other cards) |
| number exact | 5 / 20 (one more off by one digit) |
| number unreadable | 14 / 20 (motion blur, or camera a few feet back: zenzoogie 0 / 10) |
| card not in catalog (under $1.50 floor) | 5 / 20 |
| app showed a WRONG card on the reading | 6 / 20 |
| right card first, of the 15 in catalog | 13 |

Every wrong card came from one of two app behaviours, not from misreading:
- Under-floor card, name search lands on a pricier sibling: Radiant Heatran (Prize Pack $21), Jellicent ex
  (SIR $25). (Cynthia's Garchomp ex UR #215 is in the catalog at $3.98; a SIR read sends it to #232 at $185.)
- Number given but no exact match, so `run()` falls back to "closest by name", a different Pokemon with that
  number: Mewtwo ex, Beedrill V, Sinistcha ex.

Other findings:
- During "Sold" / "Awaiting next item" every seller already shows the NEXT lot's card (9 of 20 frames). A frame
  labels the lot whose timer is running; Sold-time frames belong to the next lot.
- Name + rarity read (IR, SIR, full art) pinned 7 cards with no number. The model should return rarity.
- Number legibility depends on the seller's camera, not the model: close cameras (munchingcards) gave clean
  numbers, far ones none. Grab frames when the card is largest, not only when it is still.

## Two use cases (Derek, 2026-10-16)

1. **Scouting**: several streams open, the extension labels lots by itself and shows each seller's
   sell % of market, so Derek can pick where to buy. Unattended, so only high-confidence labels count.
2. **Live buying**: Derek is on one stream, sees the auto result next to the card and validates every one
   by eye ("obviously bulk but the result is not bulk" means wrong card, no tap). Speed matters, a miss is cheap
   because a human checks.

Match rules for an auto query (both use cases; the difference is only what happens on low confidence):
- Exact: name + number exact (or within one digit) + set total consistent. Open it.
- Unique: name + rarity resolves to one card. Open it, marked "no number".
- Ambiguous: several printings (Mew ex 21, Scrafty 2, Snorunt 2). Live: show them as chips, no open.
  Scouting: skip the lot.
- Not in catalog: name found but no printing matches number / rarity, or no hit. Show "not in catalog,
  likely under $1.50". Never the closest-by-name fallback, never a pricier sibling. Scouting: count it as
  bulk (sold price only, no % of market).
- Price-spread guard: when the candidates for a name span more than ~5x (Garchomp UR vs SIR), require the
  number before opening, whatever the use case. Rarity is a tie-break, never a filter that picks the pricier card.

Scouting extra constraints, to test before building: `captureVisibleTab` only sees the visible tab, so several
streams need a `<video>`-to-canvas grab in `whatnot.js` (cross-origin taint untested) or one window per stream.
Chrome may stop painting video in hidden tabs. Cost at Haiku prices is small even for 4 streams
(about 400 lots an hour, about $0.10 an hour at one frame per lot).

Build order: (1) the match rules in `index.html` as an `auto` query path, testable now with the CSV readings
as fixtures; (2) API run of Haiku / Sonnet on the same 20 frames; (3) capture + trigger in the extension for
live buying; (4) scouting across streams, after confirming background capture works.

## Model test: Haiku vs Sonnet vs Opus on the same 20 frames (2026-10-16)

No API key in the cloud session, so each model ran as a Claude Code subagent (Haiku, Sonnet) reading the
same images with the same blind prompt; Opus is Claude's own read from the conversation. Same scorer for all:
the reading goes into the real app headless (name + number/total + "ir"/"sir" when the model said so).
Readings: `docs/recog-reads/*.jsonl`. Caveats: not the raw API path (image handling and system prompt
differ), so no latency or cost numbers yet; treat as relative accuracy.

| | Haiku | Sonnet | Opus |
|---|---|---|---|
| name right | 19 / 20 | 19 / 20 | 20 / 20 |
| numbers read / right | 4 / 2 | 5 / 4 | 7 / 6 |
| right card first (15 in catalog) | 9 | 9 | 13 |
| wrong card shown | 10 / 20 | 10 / 20 | 6 / 20 |

- Names are solid on every model. Haiku and Sonnet each fumbled one name (Haiku "Time Distortion",
  Sonnet "Giovanni's Exit"); the app still found Time-Space Distortion.
- Haiku invents numbers (Ursaring 063/090, Cetitan 216). A wrong number is worse than none.
- Haiku and Sonnet over-call "Special Illustration Rare" on full arts (Sonnet 5 times, Haiku 3). Fed to the
  search that pushes toward the expensive printing: both sent Cynthia's Garchomp ex (UR, $3.98) to the
  $185 SIR. Illustration Rare reads were right on every model.
- Every model fell into the same app traps (closest-by-name fallback 4 times each; under-floor siblings).
  Those are app fixes and help all models equally.
- Cost if Opus wins: ~1,300 input tokens a frame at $4/MTok is about $0.006 a lot, about $15 a month at
  2,600 lots (one frame). Haiku would be about $0.50. The accuracy gap (13 vs 9 of 15) is worth that.

## Agreed plan (Derek, 2026-10-16)

Status: planned, not built. Derek is not yet convinced, so it must be removable in one step and promotable
without a rewrite.

Decisions:
- One extension, not two (Chrome shows one side panel at a time; a second copy would double-send bids).
  Recognition lives in `extension/recog/` plus a handful of hook lines tagged `RECOG`, each a no-op when the
  folder is gone. Separate storage. A strip script removes the folder and tagged lines; a headless check
  proves the app and extension still work after stripping.
- Off by default, armed per stream. Arming is a keyboard shortcut on the Whatnot tab (counts as a user
  gesture, so the visible-tab screenshot fallback needs no broad permission; the icon keeps opening the panel).
  First choice for capture is drawing Whatnot's `<video>` to a canvas; the panel reports which method worked.
- What shows (Derek): it pulls up a real search result, like typing it. The best guess is marked as the
  suggestion, more strongly when certain (exact name + number), and the other candidates stay listed like a
  normal "charizard ex" search. Never the closest-by-name fallback; "not in catalog, likely under $1.50" when
  nothing fits. Fills the search only if Derek has not typed since the lot started. Never bids.
- Model: selectable in the panel (Haiku / Sonnet / Opus). Test with cheaper models; every lot records which
  model ran, and frames are kept so any model can be replayed on the same lots later.
- Recording per lot: cropped video frame (no chat), capture timing and method, model, latency, tokens, cost,
  raw answer, query, outcome type, top candidates with prices, what Derek tapped / opened, lot facts.
  Local only, frames kept 30 days, wipe button, one-click export. Debug page: summary on top (agreement,
  outcome mix, latency, spend), one row per lot, mismatches first. Replay of recorded frames for tuning.
- Truth: Derek's taps and opens, now sharper because "picked a different candidate than the suggestion" is a
  direct miss. Plus ~20 random untapped lots marked on the debug page after a stream, so bulk is measured too.
- Pass / strip bar: not set yet. Set it together after stream 1 from the debug page. Metric to watch from day
  one: how often the strong suggestion was the wrong card.
- Safety: monthly spend cap in the Anthropic console before any live call; per-hour call cap in the extension;
  API failures show "auto: unavailable" and never block bidding.

Build order:
1. Capture check (tiny): a grab-frame action that saves one frame and reports the method. Derek tries it on
   any stream for 5 minutes. If nothing works, stop here.
2. Match rules as a separate function beside `run()` (manual search unchanged; a few hundred typical queries
   diffed before / after). The 20 confirmed frames become fixtures.
3. Model call, recording, debug page, suggestion display, behind the switch. Tested on a fake stream: the 20
   frames played as a video in the mock Whatnot page with a resetting lot timer. Failure cases tested.
4. Streams in the test mode; replay to tune; then decide: promote, keep tuning, or strip.

## Build status (2026-10-16)

Steps 1 and 2 built on `claude/screenshot-test-setup-4marhe`; `node scripts/recog-check.js` passes all 30 checks.
- Step 1, capture check: Alt+Shift+R on a Whatnot stream grabs one frame (video copy, else a screenshot
  cropped to the video), retries 5 s later with no key press, and shows the result in a toast. Results page:
  extension Options > "the recognition test page". Waiting on Derek to try it on a real stream.
- Step 2, match rules: `recog/automatch.js` (`autoMatch(read)`). On the 20 confirmed frames, no model gets a
  strong suggestion wrong; Opus reads give 9 right suggestions and 6 "right card in top 5"; the one wrong
  suggestion for every model is Radiant Heatran (only the Prize Pack printing is in the catalog). A read set
  total that does not fit the set downgrades a number match to weak (Haiku invented Ursaring 063/090).
- Removal: `node scripts/strip-recog.js`; tested to restore index.html, bg.js, options.html, README, CLAUDE.md
  and the manifest byte for byte against main.

## Build status: step 3 (2026-10-16)

Built and checked (`node scripts/recog-check.js`, 53 checks, mock Whatnot page + mocked API); not yet run live.
- Trigger: a lot's timer running (not Sold / Awaiting) -> one frame 1 s later at full resolution (1080x1920 on
  Derek's test stream). Second frame 2 s later only if the read says no card, no number, confidence < 0.6, or the
  same card as the previous lot. Sold within the first second: no call.
- Call: straight from the extension to api.anthropic.com, structured output, effort low; fallbacks on for
  Sonnet / Opus. Model picked in the panel. 240 reads an hour cap. Errors (bad key, no credit, timeout) show on
  the line and never block bidding.
- CardComp: "auto on/off" + model under the lot strip, only when the extension is present. Fills the search
  with autoMatch's candidates in order, best guess marked; never overwrites a search Derek touched this lot.
- Records: every lot (frames, reads, model, latency, cost, match, what Derek tapped / opened, final price) in the
  extension's IndexedDB, 30 days, export / delete on the results page, review buttons for unlabeled lots.
- Cost, measured token counts pending: Haiku about $0.001 a lot, Opus $0.02 to $0.03 (full-size frame ~2,700
  image tokens). Max plan includes $100 a month of API credit.

## Pre-start reads (Derek, 2026-10-16: "cards show up before the timer starts", short / sudden-death timers)

Between lots (no timer running, Sold, Awaiting next item, not started), `recog-whatnot.js` takes a 24x42 grayscale
thumbnail of the video every 0.7 s (local, no API call). A big change (mean difference > 14 of 255) followed by two
still samples (< 5) means a new card is being held up: that full frame is read at once, unless it still looks like the
last card read (< 10), which is how a sold card the seller keeps holding is skipped. At most 4 such reads per gap, 3 s
apart. When the timer starts and the picture has not changed since that read, the reading is reused for the lot
(`recog-adopt`, no second call); otherwise the usual read ~1 s after the start. CardComp shows "before start: read ...".
Thresholds are guesses from a mock: each record stores the change value (`diff`) so they can be tuned from real lots.
The watcher pauses when the Whatnot tab is hidden, and needs the video copy to work (it does on Derek's test stream).

## First live test (Derek, 2026-10-16, Haiku): 23 lots, 3 sellers

Export scored against Derek's review buttons and the cards he tapped / opened (`docs/recog-reads/live-2026-10-16.json`;
frames kept out of the repo). Same frames then read blind by Sonnet and Opus (`live-sonnet.jsonl`, `live-opus.jsonl`).
Right card picked = strong or "auto?" suggestion was the card; of the 17 lots with a known card:

| reads | strong right | strong wrong | guess right | guess wrong | listed, no pick | not listed |
|---|---|---|---|---|---|---|
| Haiku as streamed, old rules | 3 | 1 (replay) | 1 | 2 | 8 | 2 |
| Haiku, new rules | 4 | 0 | 0 | 2 | 10 | 1 |
| Sonnet, new rules | 4 | 0 | 8 | 0 | 5 | 0 |
| Opus, new rules | 4 | 0 | 8 | 0 | 5 | 0 |

What the live test showed:
- Stream resolution decides whether numbers exist: calipokehouse streams 1080x1920 and every number Haiku read was
  right; fugidust84 / pokegamez stream 720x1280 and all 7 numbers Haiku read there were invented (some match real
  cards in other sets: Pikachu ex 238/191 is a real Surging Sparks card, it was an Ascended Heroes one). Sonnet and
  Opus left those blank.
- Haiku misnamed Ancient Mew (Mewtwo) and guessed sets badly (Lugia as Neo Genesis, a $1,300 card). Sonnet / Opus got
  every name, and both reported the 30th Celebration Pikachu stamp on every fugidust84 card.
- Latency (Haiku): 1.0 to 2.7 s a read. One "Failed to fetch".

Rule changes from it (recog/automatch.js, checks in section 1b):
- `stamp` asked for and used: 30th / 25th anniversary logos, Prerelease, Staff, Pokemon Center, Black Star promo.
- Off a stream under 1000 px on the short side, a number never gives a strong pick, and is ignored when its set total
  contradicts the catalog (Mew ex "232/191": Paldean Fates #232 exists but that set has 91 cards).
- Set guesses narrow the list only for Sonnet / Opus reads; a set or premium-rarity pick 5x the cheapest printing
  is dropped unless a stamp backs it.
- LV.X / LVX / Lv. X are one token (Rhyperior LV.X DP29 is "Rhyperior LVX DP29" in the catalog).
- One retry on a network failure. Default model for a fresh install: Sonnet.
Cost per read: Haiku ~$0.0002, Sonnet ~$0.005, Opus ~$0.01 (about 2,100 input tokens for a 720x1280 frame).

## Second live session (Derek, 2026-10-16): "slower", "sometimes does not react", Chinese cards

Causes found in the code (no export needed to see them):
- Pre-start change check compared a 24x42 thumbnail of the whole frame by average difference. On a 720p portrait
  stream a card is a small part of that, so a new card in the same sleeve / hand read as "no change", and at timer
  start the lot reused the previous card's reading. Now: 32x40 of the middle of the frame, and "new card?" is judged
  on the 15% most-changed pixels (stillness still on the average). Reuse only when the reading is under 10 s old and
  that peak difference is under 30. Mock now has a far-camera card swap (a whole-frame average missed it).
- "Touched" was measured from the lot object's start, which can be well before its card is shown; a tap on the
  previous card's result blocked the new reading. Now measured from the frame's capture time (minus 1.5 s).
- Speed: thinking switched off (Haiku `disabled`, Sonnet 5.5 `between_tools`; Opus 5.5 cannot, low effort), the
  server-side fallback beta dropped, and any option the API rejects is remembered per model so it never costs a
  second round trip again.
Chinese cards: TCGplayer (and so the catalog) has English and Japanese only. The prompt now tells Japanese (kana) from
Chinese (no kana, Simplified or Traditional) and Korean (Hangul); a Chinese / Korean reading gets kind `foreign`: no
suggestion, English printings listed for reference, a red "Chinese card: no Chinese prices" note on the line and status.

## "No reads before the timer" (Derek, third session) and "read now"

Likely causes, all fixed: (1) "live" was any visible timer, and Whatnot can show a lot's timer before the auction
starts, which paused the watcher for exactly that window; now live = the timer value changed in the last 2.5 s.
(2) Hold-still needed two near-still samples; now one (threshold 8), or after 3.5 s of a roughly steady card in a
moving hand. (3) The 4-reads-per-gap cap only reset when a lot went live, so a seller whose timer is never read was
capped for the whole stream; it now resets on every new lot. Added: "read now" on the auto line (Ctrl+Shift+Y on the
Whatnot tab while auto is on), always fills even over typing, and a status readout of what the watcher is doing.

## Second live session (lots 24-56 of the export, mostly Sonnet): stamps

Review meanings from here on (Derek): right = auto correct; listed = auto wrong but the card was in the list;
wrong = the card was not in the list; no card = nothing on screen. Session 1's buttons used earlier meanings.
Fixture: `docs/recog-reads/live-2026-10-16b.json` (19 lots with a known card).
- Sonnet as streamed: 2.0 s median per read, p90 2.5 s; 56 lots cost $0.20 in total.
- All 5 wrong picks were stamped cards. TCGplayer lists stamped promos as their own products ("Flareon ex 014 131
  Prismatic Evolutions Stamp", 154 in the catalog), and an anniversary logo means a Classic Collection reprint that
  keeps its original number (Shining Celebi 106/105 is Neo Destiny and the 30th Celebration Classic Collection).
- Fixes: a set-logo stamp matches the stamped product by name; anniversary stamps fall back to any anniversary
  reprint when the 25th / 30th guess is wrong; a product whose name carries "NNN TTT" counts as fitting the total;
  the prompt says where stamps hide and to look inside a seller's marker circle. Result: 12 right, 1 wrong (was 8 / 5);
  the one left is a Flareon whose stamp the model never mentioned.
- Two lots had "no frame: 1 video element(s), none showing a picture" (dustyjsmith79, safamtb): the stream's
  video had no picture at that moment; read now or the next lot covers it.

## Read now vs automatic reads; results page as a backlog (Derek, 2026-10-16)

- Double entries were a read now plus the automatic read at timer start (only skipped within 10 s on a near-identical
  picture). Two reads of the same moment add little: same frame quality, same mistakes (Haiku read "232/191" twice
  on one Mew ex). Now a read now is the lot's reading: during a running lot it is added to that lot and nothing
  automatic follows; before the timer it is reused at the start within 60 s unless the card clearly changed.
- Auto replaced results after a read now and collapsed the opened card. Now, once Derek engages with a lot (read now,
  typing, tapping or opening a result), automatic readings only offer "show" until the lot ends.
- Results page: "to review" lots first; a lot where Derek tapped a bid or opened a card is scored from that card
  automatically (no buttons); the summary says how many of each. The tapped printing (Reverse Holofoil...) and
  condition are recorded; right / wrong stays at card level, and the model's rarity read is not used to pick a
  printing (Haiku called the Celebrations Lugia "Reverse Holo").
- CardComp: pictures bigger on desktop / side panel (list 60x84, opened card 120x168); phone unchanged (a bigger
  picture squeezed card names from 76 px to 24 px); tiles keep their crop.

## Read triggers (Derek: presses read now every lot; small target, mouse lives mid-screen, Ctrl+Shift+Y awkward)

Right-click anywhere in CardComp (text fields keep their menu, Shift+right-click keeps the browser menu), the mouse's
thumb back button, the ` key (works while typing in the search box, types nothing), a 66x52 "read" button left of the
search box (sticky row, shows "reading" until the reply), and Ctrl+Shift+Y. A ring under the pointer confirms. A double
press within 1.5 s is one read. Not a click-anywhere zone: taps on results, chips and bids would fire reads.

## Printing and outcome fixes (export 2026-10-16_2, gametower Master Ball Sylveon won at $21)

- The results page said "you did not tap or open a card" for 10 of 12 lots where the auction log has the opened card
  (the Sylveon win included: log = Sylveon Master Ball Holofoil NM, opened, max $22 set in Whatnot, no CardComp tap).
  Not reproducible with one CardComp copy, so the likely cause is a second copy reporting the same lot with nothing,
  last write winning. Now the richest report wins (tap > opened card > nothing), and the log row itself
  (`cardcomp-log-save`) also fills the outcome of a lot that was read, so the results page matches the log.
- Taps on a collapsed result recorded printing "". They now record the top printing, which is what the collapsed bid
  is priced from (Sylveon 040: Master Ball $30.51; Holofoil $0.38, Reverse $0.49, Poké Ball $2.78).
- The model said "Reverse Holo" for the Master Ball Sylveon. Ball patterns are reverse holos, and the prompt does not
  ask for the pattern; the match (sv8pt5-40) was right. Picking the printing stays with Derek.
- The results page shows the max (set in Whatnot, else the tapped bid) next to the card.
- Derek did tap the Sylveon bid in CardComp (the extension filled $22; he led at $2 three seconds in). The tap was
  wiped by the app's "Sold seen, no lot end" safety net: between lots the sold row flickered, the net fired, moved the
  tap window past his pre-start tap and dropped it; the opened card survived because views have their own window.
  The net now ignores a "Sold" whose lot end was already sent (`endSent` from whatnot.js, else the title of the lot that
  just ended). Reproduced in headless Chromium before the fix, passing after.
- Printing read: the prompt asks for `finish` (non-holo / holo / reverse holo / poke ball pattern / master ball pattern /
  other pattern / unknown); `autoMatch` maps it to the suggested card's printing key (`m.printing`), only for cards with
  2+ printings. The auto line names it and warns when the collapsed bid is priced from another printing ("tile bid is
  Master Ball Holofoil $30.51, read Reverse Holofoil $0.49: open the card"); opening the card selects it (`PRINT_HINT`,
  exact key first). The results page scores it against the printing Derek picked. Not yet tried on real frames.

## Scoring from the log (2026-10-18)

Derek's export reached 109 MB (full frames) and could not be uploaded; reviewing lots by hand was getting tiring.
Each logged lot now carries the auto reading (`recog`), so scoring runs on the private log with
`node scripts/recog-score-log.js <cardcomp-data dir> [since]` (strong wrong, right / listed / not listed, printing read,
every miss with what was read, what was suggested with its rarity, and the card Derek picked). No uploads, no hand
review: lots where he tapped or opened a card score themselves; the rest are optional and listed last on the results page.

## pullsafaritcg, 2026-10-20 (cheap JP Art Rares, 1080p)

13 lots read (Sonnet), 5 with an opened card: 0 right. Numbers were read on 2 of 13 (cards held far / in toploaders),
so matches leaned on rarity, and the rarity check was broken: "Illustration Rare" contained the word "rare", so plain
Rares passed as rarity matches and beat the Art Rares (Ninjask picked its Rare; Sunflora narrowed to two Rares). Fixed:
replayed, Sunflora and Ninjask now pick the Art Rare (Sunflora matches the card Derek opened). Still open: language
(Rowlet read as JP, Derek opened the EN Perfect Order twin), and numbers on far cards. Opened cards are weak truth (one
"Budew" lot was Derek looking up the Braviary he had just won).
Speed: streamed replies fill the search once name / number are written (about 0.5-0.8 s sooner); short keys trim output.
- Export of the same stream (169 readings in ~27 min, ~375/hour, the same card often read 4 times before the timer;
  Derek hit the 240/hour cap and read-nows failed): modes off / manual / auto, separate allowances, 2 pre-start reads
  per gap. The frames show the card ~300 px wide in a toploader in the middle of a busy playmat; Derek: numbers are
  unreadable on this stream at any zoom (soft camera). Zoomed re-read added for streams where the card is small but
  sharp; for soft streams the best case is the right name and rarity with its printings listed.
- Collapsed-tile bids on that stream: 10 wins had a max set in Whatnot but no tap in the log (the tap reached Whatnot,
  the app dropped it). Taps are now tagged with their lot when tapped (see CLAUDE.md, "Taps carry their lot").

## Cleanup (2026-10-20)

Removed: the step-1 capture check (Ctrl+Shift+Y grab + 5 s retry toast, the "Recognition test: grab a frame"
right-click menu and its `contextMenus` permission, the results page's capture-checks section) and
`scripts/recog-test.js` (the one-off screenshot harness above; in git history if a model comparison is ever re-run).
Ctrl+Shift+Y now only means read now. The capture tests in recog-check.js go through read now instead.
The watcher status is sent to CardComp when its words change (or every 20 s), not every 2 s.
