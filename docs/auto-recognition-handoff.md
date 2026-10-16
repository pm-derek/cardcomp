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
