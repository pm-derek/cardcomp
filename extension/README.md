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
market gets a gold `live` mark, its max bid is recomputed from the live number, and the chip is ready to
tap. Changing the condition filter on the TCGplayer page updates the matching row too. Live numbers last
until you reload CardComp.

## Your own bid

Under the condition grid: `your bid $ [ 14 ] send`. It is prefilled with the NM margin bid. Change it to
15, press Enter or send, and that number goes to Whatnot (and the clipboard) like any tapped bid.

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
