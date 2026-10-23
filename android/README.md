# CardComp over Whatnot (Android)

The phone app from `docs/mobile-overlay-handoff.md`: CardComp floats over the Whatnot app, reads the card on
screen with one tap, and (phase 0) copies the max bid to the clipboard. Phase 1 adds the Whatnot reader and the
bid fill. Personal, sideloaded build; no Play Store.

## What it is

- `OverlayService.kt`: a foreground service (type mediaProjection) that owns the screen capture (`Capture.kt`),
  the band window (CardComp from `https://pm-derek.github.io/cardcomp/` in a WebView) and the gold read bubble.
  The page is the real CardComp, so every fix to `index.html` reaches the phone on the next load; the APK changes
  only when capture, overlay or the reader change.
- `phone/bridge.js` (repo root, injected into the page): plays the Chrome extension's part with the same messages
  (`cardcomp-ext-ready`, `cardcomp-auto`, `cardcomp-bid-ack`), reads frames with `extension/recog/recog-read.js`
  (shared with the extension), and lays the page out as a strip / typing band / bottom panel.
- `WhatnotReader.kt`: accessibility service. Phase 0: "Dump screen" writes Whatnot's view tree (class, id, text,
  bounds) to the clipboard and `files/dumps/` so the phase 1 reader and bid fill can be written from the real
  layout. It never acts on the screen.
- `MainActivity.kt`: the setup screen (permissions, keys, start / stop, share a dump).

## Install (once)

1. Download the APK from the Actions run (artifact) or the `phone-latest` release, open it, allow installing from
   this source.
2. Open CardComp: button 1 (display over other apps), 2 (notifications), 3 (accessibility: CardComp screen reader).
   On a sideloaded app Android greys the accessibility switch out until App info > menu > Allow restricted settings.
3. Paste the Anthropic API key, Save keys.

## Every stream

Start overlay, allow the screen capture ("A single app" and pick Whatnot gives frames without the overlay in them),
open Whatnot. The strip sits under the seller header, the bubble is draggable. Tap the bubble (or CardComp's read
button) to read the card; the result list opens in the bottom panel; pick the card; tap a bid: it is copied, paste it
into Whatnot's Custom bid box. Stop from the notification or the app.

## Build

`.github/workflows/android.yml` builds `assembleRelease` on every push touching `android/`. Signing: to install
updates over the old build, add repo secrets `CC_KEYSTORE_B64`, `CC_KEYSTORE_PASS` (and `CC_KEY_ALIAS` if not
`cardcomp`):

```
keytool -genkeypair -keystore cardcomp.jks -storepass <pass> -keypass <pass> -alias cardcomp -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=CardComp"
base64 -w0 cardcomp.jks   # -> CC_KEYSTORE_B64
```

Without them each build is signed with a throwaway key and the previous build must be uninstalled first.

Local build: Android Studio or `gradle -p android assembleDebug` with the SDK installed (platform 35).
Debugging the page: desktop Chrome, chrome://inspect, with the phone on USB (WebView debugging is on).
Logs: `adb logcat -s CardComp`.
