package io.github.pmderek.cardcomp

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.Icon
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.Display
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The floating CardComp: a foreground service (type mediaProjection) that owns the screen capture, two overlay
 * windows (the band holding CardComp in a WebView, and the read bubble) and the bridge the page talks to
 * (phone/bridge.js in the cardcomp repo, injected after each page load).
 *
 * Layout (docs/mobile-overlay-handoff.md): the band is a top strip (under Whatnot's header), grows while typing,
 * or sits at the bottom as a panel; the card band of the stream is never covered except while the keyboard is up.
 * Keyboard rule: the band window is not focusable until a text field in the page takes focus, and drops focus on
 * any touch outside it, so Whatnot's own Custom bid box keeps its keyboard.
 */
class OverlayService : Service() {
    companion object {
        const val ACTION_START = "io.github.pmderek.cardcomp.START"
        const val ACTION_STOP = "io.github.pmderek.cardcomp.STOP"
        const val ACTION_DUMP = "io.github.pmderek.cardcomp.DUMP"
        const val ACTION_READ = "io.github.pmderek.cardcomp.READ"
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        const val APP_URL = "https://pm-derek.github.io/cardcomp/"
        const val APP_HOST = "pm-derek.github.io"
        private const val CHANNEL = "overlay"
        private const val NOTE_ID = 1
        private const val TAG = "CardComp"
        @Volatile var running = false
        @Volatile var instance: OverlayService? = null
    }

    private lateinit var prefs: Prefs
    private lateinit var uiCtx: Context
    private lateinit var wm: WindowManager
    private val main = Handler(Looper.getMainLooper())
    private var capture: Capture? = null
    private var web: WebView? = null
    private var band: BandLayout? = null
    private var bandLp: WindowManager.LayoutParams? = null
    private var bubble: TextView? = null
    private var bubbleLp: WindowManager.LayoutParams? = null
    private var screenW = 0
    private var screenH = 0
    private var dpi = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        instance = this
        val disp = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        val base = createDisplayContext(disp).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        uiCtx = ContextThemeWrapper(base, android.R.style.Theme_DeviceDefault_NoActionBar)
        wm = uiCtx.getSystemService(WindowManager::class.java)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY   // restarted by the system: the capture token is gone, wait for the app
        when (intent.action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_DUMP -> { dump(); return START_STICKY }
            ACTION_READ -> { readNow("notification"); return START_STICKY }
            ACTION_START -> {
                startForeground(NOTE_ID, note(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                measure()
                if (web == null) { makeBand(); makeBubble(); appOpen = MainActivity.resumed; applyVisibility() }
                val code = intent.getIntExtra(EXTRA_CODE, 0)
                val data: Intent? = intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                if (data != null && capture?.running != true) {
                    val c = Capture(this) {
                        main.post {
                            capture = null
                            toast("screen capture stopped: start again from the CardComp app")
                            js("window.__phone&&window.__phone.captureLost&&window.__phone.captureLost()")
                        }
                    }
                    capture = if (c.start(code, data, screenW, screenH, dpi)) c else null
                    if (capture == null) toast("screen capture did not start")
                }
                running = true
                return START_STICKY
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        instance = null
        capture?.release(); capture = null
        try { band?.let { wm.removeView(it) } } catch (_: Exception) {}
        try { bubble?.let { wm.removeView(it) } } catch (_: Exception) {}
        try { web?.destroy() } catch (_: Exception) {}
        web = null; band = null; bubble = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------- geometry
    private fun measure() {
        val b = wm.currentWindowMetrics.bounds
        screenW = b.width(); screenH = b.height()
        dpi = resources.displayMetrics.densityDpi
    }
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()
    private val GRIP get() = dp(26)

    /** The page asks for its height (CSS px): the panel is exactly as tall as what it shows, never dead space. */
    private fun setContentHeight(cssPx: Int) {
        val lp = bandLp ?: return
        val b = band ?: return
        val want = (cssPx * resources.displayMetrics.density).roundToInt() + GRIP
        lp.height = want.coerceIn(GRIP + dp(40), (screenH * 0.62).toInt())
        lp.y = lp.y.coerceIn(0, maxOf(0, screenH - lp.height))
        if (b.isAttachedToWindow) try { wm.updateViewLayout(b, lp) } catch (e: Exception) { Log.w(TAG, "size: ${e.message}") }
    }

    /** Typing: the keyboard covers the lower half, so a low panel moves to the top until the keyboard closes. */
    private var yBeforeTyping = -1
    private fun typing(on: Boolean) {
        val lp = bandLp ?: return
        val b = band ?: return
        if (on && yBeforeTyping < 0 && lp.y > (screenH * 0.25).toInt()) { yBeforeTyping = lp.y; lp.y = (screenH * 0.06).toInt() }
        else if (!on && yBeforeTyping >= 0) { lp.y = yBeforeTyping; yBeforeTyping = -1 }
        else return
        if (b.isAttachedToWindow) try { wm.updateViewLayout(b, lp) } catch (_: Exception) {}
    }

    private fun setFocusable(want: Boolean, ime: Boolean) {
        val lp = bandLp ?: return
        val b = band ?: return
        val f = if (want) lp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() else lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        if (f != lp.flags) {
            lp.flags = f
            if (b.isAttachedToWindow) try { wm.updateViewLayout(b, lp) } catch (e: Exception) { Log.w(TAG, "focus: ${e.message}") }
        }
        val imm = getSystemService(InputMethodManager::class.java)
        if (want) {
            web?.requestFocus()
            if (ime) main.postDelayed({ web?.let { imm.showSoftInput(it, 0) } }, 120)
        } else {
            web?.let { imm.hideSoftInputFromWindow(it.windowToken, 0) }
        }
    }

    /** collapsed = only the bubble; the panel comes back on the next read, a bubble long press, or its own button */
    private var collapsed = false
    private var appOpen = false
    private fun showPanel(show: Boolean) {
        collapsed = !show
        applyVisibility()
    }
    private fun applyVisibility() {
        band?.visibility = if (collapsed || appOpen) View.GONE else View.VISIBLE
        bubble?.visibility = if (appOpen) View.GONE else View.VISIBLE
    }
    /** MainActivity in front: hide every overlay window so nothing covers its buttons */
    fun appVisible(v: Boolean) { main.post { appOpen = v; applyVisibility() } }

    // ---------------------------------------------------------------- the panel: grip (drag, resize, collapse) + CardComp in a WebView
    inner class BandLayout(ctx: Context) : LinearLayout(ctx) {
        override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_OUTSIDE -> { setFocusable(false, false); js("window.__phone&&window.__phone.blur&&window.__phone.blur()") }
                MotionEvent.ACTION_UP -> main.post { setFocusable(true, false) }   // a tap inside: the page may now want the keyboard
            }
            return super.dispatchTouchEvent(ev)
        }
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                if (event.action == KeyEvent.ACTION_UP) { js("window.__phone&&window.__phone.back&&window.__phone.back()"); setFocusable(false, false) }
                return true
            }
            return super.dispatchKeyEvent(event)
        }
    }

    private fun gripText(t: String, sizeSp: Float, color: String): TextView = TextView(uiCtx).apply {
        text = t; textSize = sizeSp; setTextColor(Color.parseColor(color)); gravity = Gravity.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun makeBand() {
        val root = BandLayout(uiCtx)
        root.orientation = LinearLayout.VERTICAL
        val bg = GradientDrawable(); bg.setColor(Color.parseColor("#0b0d10")); bg.cornerRadius = dp(12).toFloat()
        bg.setStroke(dp(1), Color.parseColor("#3a4350"))
        root.background = bg
        root.clipToOutline = true

        // grip: drag anywhere on it to move; ◢ at the right drags the width; – collapses to the bubble
        val grip = LinearLayout(uiCtx)
        grip.orientation = LinearLayout.HORIZONTAL
        grip.setBackgroundColor(Color.parseColor("#1b2026"))
        val collapse = gripText("–", 18f, "#8b97a5")
        val dots = gripText("⠿ drag", 11f, "#5b6573")
        val resize = gripText("◢", 14f, "#8b97a5")
        grip.addView(collapse, LinearLayout.LayoutParams(dp(44), GRIP))
        grip.addView(dots, LinearLayout.LayoutParams(0, GRIP, 1f))
        grip.addView(resize, LinearLayout.LayoutParams(dp(44), GRIP))
        root.addView(grip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, GRIP))

        val wv = WebView(uiCtx)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = userAgentString + " CardCompPhone/" + BuildConfig.VERSION_NAME
            setSupportZoom(false)
        }
        WebView.setWebContentsDebuggingEnabled(true)   // chrome://inspect from a desktop Chrome
        wv.setBackgroundColor(Color.parseColor("#0b0d10"))
        wv.addJavascriptInterface(Bridge(), "Android")
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == APP_HOST) return false
                openExternal(u.toString())   // TCGplayer and the rest open in the browser over Whatnot
                return true
            }
            override fun onPageFinished(view: WebView, url: String) {
                // the bridge and the shared reader ship inside the APK (copied from phone/ and extension/recog/ at
                // build time), so the app works whatever branch the live site is on
                if (url.startsWith(APP_URL)) view.evaluateJavascript("!!window.__phone") { has ->
                    if (has != "true") view.evaluateJavascript(bundled(), null)   // top level: the reader's globals must stay global
                }
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.d(TAG, "js: ${m.message()} @${m.lineNumber()}"); return true }
        }
        root.addView(wv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val w0 = if (prefs.panelW > 0) prefs.panelW.coerceIn(dp(240), screenW) else screenW - dp(16)
        val lp = WindowManager.LayoutParams(
            w0, GRIP + dp(70),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = if (prefs.panelX >= 0) prefs.panelX.coerceIn(0, maxOf(0, screenW - w0)) else dp(8)
        lp.y = if (prefs.panelY >= 0) prefs.panelY.coerceIn(0, (screenH * 0.85).toInt()) else (screenH * 0.09).toInt()
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING

        dots.setOnTouchListener(dragListener(lp, root, onTap = {}, onLong = {}, save = { prefs.panelX = lp.x; prefs.panelY = lp.y; yBeforeTyping = -1 }))
        collapse.setOnClickListener { showPanel(false) }
        resize.setOnTouchListener(widthListener(lp, root))

        wm.addView(root, lp)
        band = root; bandLp = lp; web = wv
        wv.loadUrl(APP_URL)
    }

    private fun widthListener(lp: WindowManager.LayoutParams, win: View): View.OnTouchListener = object : View.OnTouchListener {
        var x0 = 0f; var w0 = 0
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { x0 = e.rawX; w0 = lp.width; return true }
                MotionEvent.ACTION_MOVE -> {
                    lp.width = (w0 + (e.rawX - x0)).toInt().coerceIn(dp(240), screenW - lp.x)
                    try { wm.updateViewLayout(win, lp) } catch (_: Exception) {}
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { prefs.panelW = lp.width; return true }
            }
            return false
        }
    }

    // ---------------------------------------------------------------- the bubble: read now; drag; long press hides the band
    @SuppressLint("ClickableViewAccessibility")
    private fun makeBubble() {
        val tv = TextView(uiCtx)
        tv.text = "read"
        tv.setTextColor(Color.parseColor("#f5b301"))
        tv.textSize = 13f
        tv.typeface = Typeface.DEFAULT_BOLD
        tv.gravity = Gravity.CENTER
        val bg = GradientDrawable()
        bg.shape = GradientDrawable.OVAL
        bg.setColor(Color.parseColor("#E614181D"))
        bg.setStroke(dp(2), Color.parseColor("#f5b301"))
        tv.background = bg
        val size = dp(56)
        val lp = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = if (prefs.bubbleX >= 0) prefs.bubbleX else screenW - size - dp(8)
        lp.y = if (prefs.bubbleY >= 0) prefs.bubbleY else (screenH * 0.26).toInt()
        tv.setOnTouchListener(dragListener(lp, tv, onTap = { readNow("bubble") }, onLong = { showPanel(collapsed) }, save = { prefs.bubbleX = lp.x; prefs.bubbleY = lp.y }))
        wm.addView(tv, lp)
        bubble = tv; bubbleLp = lp
    }

    private fun dragListener(lp: WindowManager.LayoutParams, win: View, onTap: () -> Unit, onLong: () -> Unit, save: () -> Unit): View.OnTouchListener = object : View.OnTouchListener {
        val slop = ViewConfiguration.get(this@OverlayService).scaledTouchSlop
        var sx = 0f; var sy = 0f; var ox = 0; var oy = 0; var moved = false; var longFired = false
        val longRun = Runnable { longFired = true; onLong() }
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    sx = e.rawX; sy = e.rawY; ox = lp.x; oy = lp.y; moved = false; longFired = false
                    main.postDelayed(longRun, 550)
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - sx; val dy = e.rawY - sy
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) { moved = true; main.removeCallbacks(longRun) }
                    if (moved) {
                        lp.x = (ox + dx).toInt().coerceIn(0, maxOf(0, screenW - win.width))
                        lp.y = (oy + dy).toInt().coerceIn(0, maxOf(0, screenH - win.height))
                        try { wm.updateViewLayout(win, lp) } catch (_: Exception) {}
                    }
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(longRun)
                    if (moved) save()
                    else if (!longFired && e.actionMasked == MotionEvent.ACTION_UP) { v.performClick(); onTap() }
                    return true
                }
            }
            return false
        }
    }

    private fun flashBubble(txt: String, ms: Long = 1200) {
        val b = bubble ?: return
        b.text = txt
        main.postDelayed({ if (b.text.toString() == txt) b.text = "read" }, ms)
    }

    // ---------------------------------------------------------------- actions
    private fun readNow(src: String) {
        if (web == null) return
        if (capture?.running != true) { toast("screen capture is off: start the overlay from the CardComp app"); return }
        flashBubble("…", 3000)
        js("window.__phone&&window.__phone.readNow(" + JSONObject.quote(src) + ")")
    }

    private fun dump() {
        val r = WhatnotReader.instance
        if (r == null) { toast("screen reader is off: turn on CardComp under Settings > Accessibility"); return }
        val txt = try { r.dump() } catch (e: Exception) { "dump failed: ${e.message}" }
        copy(txt)
        toast("screen dump copied (${txt.length} chars), also saved in the app")
        js("window.__phone&&window.__phone.dumpNote&&window.__phone.dumpNote('screen dump copied')")
    }

    private fun copy(text: String) {
        try {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("CardComp", text))
            if (Build.VERSION.SDK_INT < 33 && text.length < 40) toast("copied $text")
        } catch (e: Exception) { toast("copy failed: ${e.message}") }
    }

    private fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (e: Exception) { toast("cannot open: ${e.message}") }
    }

    /** The part of the screen a held card is in (below the seller header, above the lot row), at full resolution:
     *  the collector number is a few pixels tall in a downscaled frame, which is why 720 px reads came back without one. */
    private fun cardBand(b: android.graphics.Bitmap): android.graphics.Bitmap {
        val y0 = (b.height * 0.07).toInt()
        val h = (b.height * 0.84).toInt() - y0
        var out = android.graphics.Bitmap.createBitmap(b, 0, y0, b.width, h)
        val k = 1600f / maxOf(out.width, out.height)
        if (k < 1f) out = android.graphics.Bitmap.createScaledBitmap(out, (out.width * k).toInt(), (out.height * k).toInt(), true)
        return out
    }

    private var bundledJs: String? = null
    private fun bundled(): String = bundledJs ?: try {
        (assets.open("recog-read.js").bufferedReader().readText() + "\n;\n" + assets.open("bridge.js").bufferedReader().readText()).also { bundledJs = it }
    } catch (e: Exception) { Log.w(TAG, "bundled js: ${e.message}"); "" }

    private fun js(code: String) { main.post { web?.evaluateJavascript(code, null) } }
    private fun toast(t: String) { main.post { Toast.makeText(this, t, Toast.LENGTH_SHORT).show() } }

    // ---------------------------------------------------------------- the bridge the page calls (phone/bridge.js); runs off the main thread
    inner class Bridge {
        @JavascriptInterface fun cfg(): String = JSONObject()
            .put("ver", BuildConfig.VERSION_NAME).put("build", BuildConfig.BUILD_ID)
            .put("model", prefs.model).put("mode", prefs.mode)
            .put("hasKey", prefs.anthropicKey.isNotEmpty()).put("hasToken", prefs.ghToken.isNotEmpty())
            .put("reader", WhatnotReader.connected()).put("capture", capture?.running == true)
            .put("w", screenW).put("h", screenH).toString()

        @JavascriptInterface fun key(name: String): String = when (name) {
            "anthropic" -> prefs.anthropicKey
            "github" -> prefs.ghToken
            else -> ""
        }

        @JavascriptInterface fun setCfg(json: String) {
            try {
                val o = JSONObject(json)
                if (o.has("mode") && !o.isNull("mode")) prefs.mode = o.getString("mode")
                if (o.has("model") && !o.isNull("model")) prefs.model = o.getString("model")
            } catch (_: Exception) {}
        }

        /** one frame of the screen -> window.__phone.frame(req, dataUrl, w, h), or frameFail(req, why) */
        @JavascriptInterface fun grab(req: String): String {
            val c = capture ?: return "screen capture is off: start the overlay from the CardComp app"
            val q = JSONObject.quote(req)
            main.post {
                c.grab { bmp ->
                    if (bmp == null) js("window.__phone.frameFail($q,'no frame from the screen capture')")
                    else Thread {
                        val f = cardBand(bmp)
                        val url = Capture.jpegDataUrl(f, 88)
                        js("window.__phone.frame($q,${JSONObject.quote(url)},${f.width},${f.height})")
                    }.start()
                }
            }
            return "ok"
        }

        /** phase 0: the bid goes to the clipboard; phase 1 fills Whatnot's Custom bid box through WhatnotReader */
        @JavascriptInterface fun bid(amount: String, name: String): String {
            main.post { copy(amount); flashBubble("\$$amount", 1500) }
            return JSONObject().put("ok", false).put("why", "copied").toString()
        }

        @JavascriptInterface fun open(url: String) { if (url.startsWith("https://")) main.post { openExternal(url) } }
        @JavascriptInterface fun focus(want: Boolean) { main.post { setFocusable(want, want) } }
        /** the page's mode changed (card, list, typing) or a read landed: the panel shows, collapsed or not */
        @JavascriptInterface fun layout(s: String) { main.post { typing(s == "typing"); showPanel(true) } }
        @JavascriptInterface fun size(cssPx: Int) { main.post { setContentHeight(cssPx) } }
        @JavascriptInterface fun collapse() { main.post { showPanel(false) } }
        @JavascriptInterface fun toast(t: String) { this@OverlayService.toast(t) }
        @JavascriptInterface fun log(s: String) { Log.d(TAG, "page: $s") }
        @JavascriptInterface fun dump() { main.post { this@OverlayService.dump() } }
    }

    // ---------------------------------------------------------------- notification (keeps the service alive; read / dump / stop)
    private fun note(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "CardComp overlay", NotificationManager.IMPORTANCE_LOW))
        fun act(action: String, code: Int): PendingIntent = PendingIntent.getService(
            this, code, Intent(this, OverlayService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val icon = Icon.createWithResource(this, R.drawable.ic_launcher)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("CardComp over Whatnot")
            .setContentText("tap the bubble to read the card on screen")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(icon, "Read", act(ACTION_READ, 1)).build())
            .addAction(Notification.Action.Builder(icon, "Dump screen", act(ACTION_DUMP, 2)).build())
            .addAction(Notification.Action.Builder(icon, "Stop", act(ACTION_STOP, 3)).build())
            .build()
    }
}
