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

## What it does and does not do

- Only ever types the amount. It never clicks Place bid, Bid, or Buy.
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
