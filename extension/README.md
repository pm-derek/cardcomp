# CardComp to Whatnot (Chrome extension)

Desktop only. Tap a bid in CardComp, it appears in Whatnot's Custom bid box. You still press Place bid.

## Install (once, about 1 minute)

1. Download this repo (Code > Download ZIP) or `git clone`, so you have the `extension/` folder on disk.
2. Chrome: `chrome://extensions` > turn on **Developer mode** (top right) > **Load unpacked** > pick the `extension/` folder.
3. Pin the "CardComp to Whatnot" icon (puzzle piece > pin).

Edge and Brave work the same way. Firefox does not (no side panel API, different manifest).

## Use

1. Open the Whatnot show at whatnot.com in a tab.
2. Click the extension icon. CardComp opens in Chrome's side panel next to the stream.
   (A normal CardComp tab in another window works too.)
3. Search the card, tap the bid you want. The bid chip says `Whatnot $42` when it landed.
   In the Whatnot tab a toast at the top says one of:
   - `$42 entered ... Place the bid when ready.` -> the box is filled, press Place bid.
   - `$42 ready ... Tap Whatnot's Custom bid box.` -> the box was not found. Tap Custom bid; the first
     input you tap gets the amount (within 2 minutes).
   - `Could not enter $42. Type it: 42` -> the number is also on your clipboard, paste it.
4. Nothing happens in Whatnot: the chip said `copied $42` only. Check that a whatnot.com tab is open
   and reload it once (content scripts attach on load).

## Confirming the bid

The tap is the confirm. Nothing is sent until you tap a number, and the number you tap is the one that goes
in: the margin bid (exact or rounded), the b/e or profit bid, any condition row (NM / LP / MP ...), or a cart
row. With the extension connected the chips' hover text reads "tap: this bid goes into Whatnot". After the
tap you get two confirmations before any money moves: the chip flips to `Whatnot $42 ✓`, and the toast on
the Whatnot page names the card and the amount. Whatnot's own Place bid button is the final step and it is
always yours.

## Live TCGplayer price into the bid

Tap a condition's `LP ↗` (or its market price) in CardComp. The TCGplayer listing page opens in a tab; the
extension reads that condition's market price (lowest listing if no market) and sends it back. The row's
market gets a `✓ today` mark, its max bid is recomputed from the live number, and the chip is ready to
tap. Changing the condition filter on the TCGplayer page updates the matching row too.

## Verified prices on every device

Each live read is saved to `live.json` on the `live` branch of pm-derek/cardcomp (one small commit, batched
20 s; no Pages build, since Pages only builds `main`). CardComp on any device, the phone included, reads
that file on load and every 5 minutes. A verified row shows `✓ 3d` (gold within a week, dim after) and the
hover text says what was read and when. Reads older than 60 days are ignored.

What is stored is the ratio of the live price to the NM market at the time, plus the raw numbers. The ratio
is applied to today's NM, so a three-week-old LP read still moves with the market instead of freezing a
dollar figure.

Setup, once, on the desktop that does the clicking: right-click the extension icon > Options, and paste a
GitHub fine-grained token (repository access: only pm-derek/cardcomp; permission: Contents, read and write).
Test shows how many entries the store holds. Without a token, live reads still work for the session; they
just are not saved.

Click-outs open in a background tab (one tab, reused), so you stay on the stream. If you open one in the
foreground anyway, after the first read the extension switches you back to the Whatnot tab
(the TCGplayer tab stays open behind). If nothing could be read within 8 seconds, the open card says so
under its grid and you stay on TCGplayer.

## Your own bid

Under the bid table: `your bid $ −1 [ 14 ] +1 send`. It starts at the NM margin bid and then follows
whatever bid you last tapped (LP, flat, profit...). −1 / +1 step it by a dollar; Enter or send puts that
number into Whatnot (and the clipboard) like any tapped bid.

## Lot strip and auction log

With a Whatnot tab open, a strip above the search box shows the auction as it runs: `now $21 · next $23 ·
0:05 · 14 bids · ship $4.47 · lead eriper37185 · your max $19`. Gold normally, red once the current bid
passes the last bid you sent ("over your $19"), green while you lead. New lot: the title shows as a chip
("on stream: ...", tap to search it) and the search box is selected so typing replaces the old search.

When a lot ends the extension records it: title, final price, bid count, winner, everyone who led during
the lot, shipping, seller, time, and the card you last sent a bid on (name, condition, printing, market,
your max, rarity, era, speed tier, margin, verified or not), every bid you sent during the lot, the full
bid history (each lead change with amount and seconds into the lot), viewer count at start and end,
giveaway entries, and who was in the room (chat joins and lot leaders in the last 30 minutes). Lots you won
are flagged. Rows go to `log-YYYY-MM-DD.json` in a private repo, `pm-derek/cardcomp-data`, because they
carry other people's usernames and your purchase ledger, and the cardcomp repo is public.

Setup once: on github.com create a new repository named `cardcomp-data`, set it to Private, tick "Add a
README" (so the main branch exists), create. Then edit the token (Settings > Developer settings > tokens),
add `cardcomp-data` under Repository access, keep Contents: Read and write, save. Without this the log is
dropped with a console warning; prices still save.

The reader reacts to page changes rather than polling, so streams open in other tabs keep reporting
(mute them). Each tab is its own room; records carry the seller and URL. Over weeks this is the room read (what this seller's lots close at vs market, who the
aggressive bidders are) and your purchase ledger (what you paid, per card, per seller).

### What labels a lot with a card

- One lot is one record, however many times you tap. Tapping NM, then LP, then NM on the same card
  labels the lot with the last tap (NM) and keeps all three in the record.
- A bid counts when you tap it (any bid chip, the cart total, or send / Enter in "your bid"). Typing in
  "your bid" without sending does not. Each tap is marked if it landed in Whatnot's Custom bid box.
- Taps made while the seller is still showing the card, before the auction starts, count for that lot.
- Two cards in one lot: add both to the cart and tap the cart's max bid total. The lot is labeled with both
  cards and each one's share of the bid.
- Whether you actually placed the bid is shown by whether you were ever the leader during the lot.
- Just collecting data, no bid: open the card. A lot with no tap is labeled with the last card you opened
  since the previous lot ended, at the condition the seller shows ("Near Mint · Card").
- The strip's last line says what the current lot will be logged as: "logging: Jynx NM (viewed)", or
  "not labeled". After "Sold" it reads "next lot ...".
- Bids under $1 floor to $0. Nothing is copied or sent ("under $1"), but the tap still labels the lot.
- Your Whatnot username is learned the first time "You won" and "yourname won!" show together.
- If you edit the max by hand in Whatnot, the log uses what Whatnot shows ("Max bid added $13").

### Priced out

If the current lot's next bid is already above the max you tap, Custom bid is not opened. The chip reads
"under next $15", "your bid" is set to $15, and the strip shows "priced out: next bid $15 [bid $15]" with
what you would net at $15. Tap the button to bid the minimum, or pass.

### Stream stats

Tap "stats" in the strip. For the stream you are in (or any stream you have watched, all time): where lots
close as a % of market, where you win and lose, your margin on wins vs your target, profit left on the
table, a dot chart of every labeled lot, and a soft / even / hot verdict for whether to stay.

At the bottom: "Clear logged lots: last hour / today / everything". It asks first, then removes those lots from
the stats in this browser and from the log in your private `cardcomp-data` repo. Verified TCGplayer prices stay.

## Footer status

With the extension present, a line under the catalog count reads `Whatnot ✓ · store ✓`. `no Whatnot tab`
means tapping a bid will only copy; `store: no token` means click-outs are not being saved (see Options).

## What it does and does not do

- Only ever types the amount. It clicks Whatnot's "Custom" button to open the box when it is closed. It never clicks Place bid, Bid, or Buy.
- Fills one tab: the active Whatnot tab, else the one you touched last.
- Whole dollars, floored, same as the clipboard copy.

## Updating

`git pull` (or re-download) then `chrome://extensions` > reload icon on the extension.

## When Whatnot changes its page

The filler is heuristic (`whatnot.js`): it looks for a visible number-ish input whose label says bid /
amount / max, clicks a button whose text is "Custom bid" if the input is not open, and otherwise arms the
next input you tap. If a redesign breaks step 1 or 2, step 3 still works; fix the selectors in
`findBidInput` / `findCustomButton` with the real markup from DevTools (right-click the bid box > Inspect).

Mobile: the Whatnot app cannot be typed into from a browser (iOS has no path; Android would need an
accessibility service app). The clipboard copy stays the mobile path: copy, switch, paste from the
keyboard's clipboard chip.
<!-- RECOG-BEGIN: auto-recognition experiment, removed by scripts/strip-recog.js -->

## Recognition test (experiment)

Step 1 of docs/auto-recognition-handoff.md: can the extension grab a frame of the stream at all?

1. Reload the extension at chrome://extensions, then reload the Whatnot tab once.
2. On a live stream press **Alt+Shift+R** (Option+Shift+R on a Mac). If nothing happens, set the key at
   chrome://extensions/shortcuts ("Recognition test").
3. A blue box bottom-left says how the frame was grabbed. 5 s later it tries again with no key press, which
   says whether later lots can be captured on their own.
4. Results: Options > "the recognition test page" (thumbnails, method, size, brightness). Export or delete there.

Nothing is sent anywhere; frames stay in this extension. Remove the whole experiment: `node scripts/strip-recog.js`.
<!-- RECOG-END -->
