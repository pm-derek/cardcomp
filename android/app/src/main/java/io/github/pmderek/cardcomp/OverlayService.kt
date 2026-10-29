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
import android.view.HapticFeedbackConstants
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
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
        /** what this APK's Bridge offers; phone/bridge.js says which it needs (PHONE_API) */
        const val NATIVE_API = 7
        /** After each page load: run the newest bridge that this APK can serve. The live site's copy (main) wins when its
         *  version is higher than the one built into the APK and it needs no newer native API; else the built-in one.
         *  So page-side fixes reach the phone with no new APK once they are merged. Indirect eval keeps the globals global. */
        val LOADER = """
            (async function(){
              if (window.__phone) return;
              var A = window.Android, mine = A.bundledVer(), code = null;
              var newer = function(a, b){ a = a.split('.').map(Number); b = b.split('.').map(Number);
                for (var i = 0; i < 3; i++) { if ((a[i]||0) !== (b[i]||0)) return (a[i]||0) > (b[i]||0); } return false; };
              try {
                var get = function(u){ return fetch(u + '?t=' + Date.now(), {cache: 'no-store'}).then(function(r){ if (!r.ok) throw new Error(u); return r.text(); }); };
                var br = await get('phone/bridge.js');
                var v = (/const VER = "([0-9.]+)"/.exec(br) || [])[1], api = +((/const PHONE_API = ([0-9]+)/.exec(br) || [])[1] || 99);
                if (v && newer(v, mine) && api <= $NATIVE_API) {
                  var parts = await Promise.all([get('extension/recog/recog-read.js'), get('extension/recog/imgmatch.js')]);
                  code = parts[0] + '\n;\n' + parts[1] + '\n;\n' + br;
                }
              } catch (e) {}
              if (window.__phone) return;
              if (code) { try { (0, eval)(code); } catch (e) { A.log('live bridge failed: ' + e); } }
              if (!window.__phone) (0, eval)(A.bundled());   // a bad merge on the live site never leaves the phone without a bridge
            })();
        """.trimIndent()
    }

    private lateinit var prefs: Prefs
    private lateinit var uiCtx: Context
    private lateinit var wm: WindowManager
    private val main = Handler(Looper.getMainLooper())
    private var capture: Capture? = null
    private var web: WebView? = null
    private var band: BandLayout? = null
    private var bandLp: WindowManager.LayoutParams? = null
    private var bubble: ReadButton? = null
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
        if (intent == null) { stopSelf(); return START_NOT_STICKY }   // restarted by the system: the capture token is gone
        when (intent.action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_DUMP -> { dump(); return START_NOT_STICKY }
            ACTION_READ -> { readNow("notification"); return START_NOT_STICKY }
            ACTION_START -> {
                startForeground(NOTE_ID, note(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                measure()
                if (web == null) { makeBand(); makeBubble(); appOpen = MainActivity.resumed; applyVisibility() }
                val code = intent.getIntExtra(EXTRA_CODE, 0)
                val data: Intent? = if (Build.VERSION.SDK_INT >= 34) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)   // the typed overload is broken on 33
                if (data != null) {
                    capture?.release()   // Start again (say, to switch to "a single app"): the new consent wins
                    var c: Capture? = null
                    c = Capture(this) {
                        main.post {
                            if (capture !== c) return@post
                            capture = null
                            captureLost("screen capture ended: tap start on the bubble")
                        }
                    }
                    capture = if (c.start(code, data, screenW, screenH, dpi)) c else null
                    if (capture == null) toast("screen capture did not start") else { noFrames = 0; bubbleIdle() }
                    // started from the bubble's "start": go ahead with the read once the dialog is gone
                    if (capture != null && intent.getBooleanExtra(ConsentActivity.EXTRA_READ, false)) main.postDelayed({ readNow("bubble") }, 700)
                }
                running = true
                return START_NOT_STICKY
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        try { pool.shutdownNow() } catch (_: Exception) {}
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
    private val GRIP get() = dp(if (wide) 40 else 26)   // taller in the full view, so its shrink button is a real target

    /** The page asks for its height (CSS px): the panel is exactly as tall as what it shows, never dead space. */
    private var typingNow = false
    private fun setContentHeight(cssPx: Int) {
        val lp = bandLp ?: return
        val want = (cssPx * resources.displayMetrics.density).roundToInt() + GRIP
        val cap = (screenH * (if (typingNow) 0.50 else 0.62)).toInt()   // typing: the keyboard takes the lower ~40%
        lp.height = want.coerceIn(GRIP + dp(40), cap)
        if (!wide) cardH = lp.height
        place()
    }

    /** Where Derek put the panel (homeY); a taller panel is lifted only as far as it must, and returns when it shrinks.
     *  Typing: a panel in the lower 3/4 moves to the top until the keyboard closes. */
    private var homeY = 0
    private fun place() {
        val lp = bandLp ?: return
        val b = band ?: return
        val top = (screenH * 0.06).toInt()
        val y = if (typingNow && homeY > (screenH * 0.25).toInt()) top else homeY
        lp.y = y.coerceIn(0, maxOf(0, screenH - lp.height))
        if (b.isAttachedToWindow) try { wm.updateViewLayout(b, lp) } catch (e: Exception) { Log.w(TAG, "place: ${e.message}") }
    }
    private fun typing(on: Boolean) { if (on != typingNow) { typingNow = on; place() } }

    /** The full view (results, grid, search) gets the whole width; the small card goes back to Derek's width and place. */
    private var wide = false
    private var userW = 0
    private var userX = 0
    private var cardH = 0
    private fun widen(on: Boolean) {
        val lp = bandLp ?: return
        val b = band ?: return
        if (on == wide) return
        wide = on
        if (on) { userX = lp.x; userW = lp.width; lp.x = dp(8); lp.width = screenW - dp(16) }
        else {
            lp.width = userW.coerceIn(dp(200), screenW); lp.x = userX.coerceIn(0, maxOf(0, screenW - lp.width))
            if (cardH > 0) lp.height = cardH   // the small card's last height at once; the page refines it (never stuck tall)
            typingNow = false
        }
        styleCollapse(on)
        if (b.isAttachedToWindow) try { wm.updateViewLayout(b, lp) } catch (_: Exception) {}
        place()
    }
    /** back to the small card from anywhere: native first (works whatever the page is doing), then the page */
    private fun toCard() {
        setFocusable(false, false)
        widen(false)
        js("window.__phone&&(window.__phone.blur&&window.__phone.blur(),window.__phone.setMode&&window.__phone.setMode('card'))")
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
            if (ime) { wantIme = true; if (b.hasWindowFocus()) showIme() }   // else onWindowFocusChanged shows it
        } else {
            wantIme = false
            web?.let { imm.hideSoftInputFromWindow(it.windowToken, 0) }
        }
    }
    private var wantIme = false
    private fun showIme() {
        val w = web ?: return
        wantIme = false
        w.requestFocus()
        getSystemService(InputMethodManager::class.java).showSoftInput(w, 0)
    }

    /** collapsed = only the bubble; the panel comes back on the next read, a bubble long press, or its own button */
    private var collapsed = false
    private var appOpen = false
    private var collapseBtn: TextView? = null
    private fun showPanel(show: Boolean) {
        if (!show && wide) toCard()   // folded away from the full view: it comes back as the small card
        collapsed = !show
        applyVisibility()
    }
    private fun applyVisibility() {
        if (collapsed || appOpen) setFocusable(false, false)   // a hidden window gets no outside touch: drop focus now, or it takes Whatnot's keyboard when it shows again
        band?.visibility = if (collapsed || appOpen) View.GONE else View.VISIBLE
        bubble?.visibility = if (appOpen) View.GONE else View.VISIBLE
    }
    /** MainActivity in front: hide every overlay window so nothing covers its buttons */
    fun appVisible(v: Boolean) { main.post { appOpen = v; applyVisibility() } }

    // ---------------------------------------------------------------- the panel: grip (drag, resize, collapse) + CardComp in a WebView
    inner class BandLayout(ctx: Context) : LinearLayout(ctx) {
        override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_OUTSIDE -> { setFocusable(false, false); js("window.__phone&&(window.__phone.blur&&window.__phone.blur(),window.__phone.outside&&window.__phone.outside())") }
            }
            return super.dispatchTouchEvent(ev)
        }
        override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
            super.onWindowFocusChanged(hasWindowFocus)
            if (hasWindowFocus && wantIme) main.postDelayed({ showIme() }, 50)
        }
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                if (event.action == KeyEvent.ACTION_UP) { js("window.__phone&&window.__phone.back&&window.__phone.back()"); setFocusable(false, false) }
                return true
            }
            return super.dispatchKeyEvent(event)
        }
    }

    /** Full view: a gold "▾ shrink" pill back to the small card (Derek, 2026-10-29: the ✕ was "very small, hard to find");
     *  small card: the plain – that folds the panel into the bubble. */
    private fun styleCollapse(full: Boolean) {
        val c = collapseBtn ?: return
        if (full) {
            c.text = "▾ shrink"; c.textSize = 14f; c.setTextColor(Color.BLACK)
            c.background = GradientDrawable().apply { setColor(Color.parseColor("#f5b301")); cornerRadius = dp(9).toFloat() }
            c.layoutParams = LinearLayout.LayoutParams(dp(112), ViewGroup.LayoutParams.MATCH_PARENT).apply { setMargins(dp(4), dp(4), dp(4), dp(4)) }
        } else {
            c.text = "–"; c.textSize = 18f; c.setTextColor(Color.parseColor("#8b97a5")); c.background = null
            c.layoutParams = LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.MATCH_PARENT)
        }
        (c.parent as? View)?.let { bar -> bar.layoutParams = bar.layoutParams?.apply { height = GRIP } }
    }
    private fun gripText(t: String, sizeSp: Float, color: String): TextView = TextView(uiCtx).apply {
        text = t; textSize = sizeSp; setTextColor(Color.parseColor(color)); gravity = Gravity.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }

    /** CardComp's WebView (also rebuilt in place when its renderer dies) */
    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWeb(): WebView {
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
            // Page scale locked at 1 (Derek's screenshots, 2026-10-23: after the panel's width changed, the page stayed
            // magnified ~2.5x). No wide viewport, no overview zoom, no built-in zoom, no system font boost.
            useWideViewPort = false
            loadWithOverviewMode = false
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)   // chrome://inspect would expose the keys: debug builds only
        wv.setBackgroundColor(Color.parseColor("#0b0d10"))
        wv.addJavascriptInterface(Bridge(), "Android")
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.toString().startsWith(APP_URL)) return false
                openExternal(u.toString())   // TCGplayer and the rest open in the browser over Whatnot
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { pageUrl = url }
            // no network at start: retry instead of leaving Chromium's error page in the panel
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) main.postDelayed({ if (web === view) view.loadUrl(APP_URL) }, 5000)
            }
            // the renderer was killed (memory) or crashed: build a new WebView instead of taking the whole app down
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                main.post { rebuildWeb(view) }
                return true
            }
            override fun onPageFinished(view: WebView, url: String) {
                // the bridge and the shared reader ship inside the APK (copied from phone/ and extension/recog/ at
                // build time), so the app works whatever branch the live site is on
                if (url.startsWith(APP_URL)) view.evaluateJavascript(LOADER, null)
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.d(TAG, "js: ${m.message()} @${m.lineNumber()}"); return true }
            // A WebView outside an Activity cannot show dialogs (BadTokenException): alerts become a toast, confirms and
            // prompts answer "cancel" (only stats clean-up uses them, and that is desktop only)
            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean { toast(message); result.confirm(); return true }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean { toast("not on the phone: $message".take(120)); result.cancel(); return true }
            override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean { result.cancel(); return true }
            override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean { result.confirm(); return true }
        }
        return wv
    }

    @Volatile private var pageUrl = ""
    private fun rebuildWeb(dead: WebView) {
        val root = band ?: return
        if (web !== dead) return
        val i = root.indexOfChild(dead)
        try { root.removeView(dead); dead.destroy() } catch (_: Exception) {}
        val wv = makeWeb()
        root.addView(wv, if (i >= 0) i else root.childCount, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        web = wv; pageUrl = ""
        wv.loadUrl(APP_URL)
        toast("CardComp reloaded (the page ran out of memory)")
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
        collapseBtn = collapse
        val dots = gripText("⠿ drag", 11f, "#5b6573")
        val resize = gripText("◢", 14f, "#8b97a5")
        grip.addView(collapse, LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.MATCH_PARENT))
        grip.addView(dots, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        grip.addView(resize, LinearLayout.LayoutParams(dp(44), ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(grip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, GRIP))

        val wv = makeWeb()
        root.addView(wv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        // small card by default: ~60% of the width (Derek, 2026-10-23: "taking up most of the left-to-right"); ◢ changes it
        val w0 = if (prefs.panelW2 > 0) prefs.panelW2.coerceIn(dp(200), screenW) else (screenW * 0.6).toInt().coerceAtLeast(dp(220))
        userW = w0
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
        homeY = lp.y
        userX = lp.x
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
        lp.fitInsetsTypes = 0   // the drag clamps use the full display: let the window go there (nav bar strip included)

        dots.setOnTouchListener(dragListener(lp, root, onTap = {}, onLong = {}, save = { if (!wide) { prefs.panelX = lp.x; userX = lp.x }; prefs.panelY = lp.y; homeY = lp.y; typingNow = false }))
        collapse.setOnClickListener { if (wide) toCard() else showPanel(false) }
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
                    lp.width = (w0 + (e.rawX - x0)).toInt().coerceIn(dp(200), screenW - lp.x)
                    try { wm.updateViewLayout(win, lp) } catch (_: Exception) {}
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { if (!wide) { prefs.panelW2 = lp.width; userW = lp.width }; return true }
            }
            return false
        }
    }

    // ---------------------------------------------------------------- the bubble: read now; drag; long press hides the band
    @SuppressLint("ClickableViewAccessibility")
    private fun makeBubble() {
        val tv = ReadButton(uiCtx)   // drawn by hand: viewfinder, scan sweep while reading, red "start" when capture is off
        if (capture?.running != true) tv.setMode(ReadButton.Mode.OFF)
        val size = dp(60)
        val lp = WindowManager.LayoutParams(
            size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.fitInsetsTypes = 0
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
                    if (v is ReadButton) v.isPressed = true
                    main.postDelayed(longRun, 550)
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - sx; val dy = e.rawY - sy
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) { moved = true; main.removeCallbacks(longRun); if (v is ReadButton) v.isPressed = false }
                    if (moved) {
                        lp.x = (ox + dx).toInt().coerceIn(0, maxOf(0, screenW - win.width))
                        lp.y = (oy + dy).toInt().coerceIn(0, maxOf(0, screenH - win.height))
                        try { wm.updateViewLayout(win, lp) } catch (_: Exception) {}
                    }
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(longRun)
                    if (v is ReadButton) v.isPressed = false
                    if (moved) save()
                    else if (!longFired && e.actionMasked == MotionEvent.ACTION_UP) { v.performClick(); onTap() }
                    return true
                }
            }
            return false
        }
    }

    // ---------------------------------------------------------------- capture lost -> "start" on the bubble, one tap to re-allow
    private var noFrames = 0
    private fun captureLost(why: String) {
        toast(why)
        bubbleIdle()
        js("window.__phone&&window.__phone.captureLost&&window.__phone.captureLost()")
    }
    /** the system's screen-capture dialog over the stream; with read = true the read follows once it is allowed */
    private fun askCapture(read: Boolean) {
        try { startActivity(Intent(this, ConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION).putExtra(ConsentActivity.EXTRA_READ, read)) }
        catch (e: Exception) { toast("could not ask for screen capture: open the CardComp app") }
    }
    /** the bubble at rest: gold "read", or red "start" when the capture is gone */
    private fun bubbleIdle() {
        main.post {
            val b = bubble ?: return@post
            if (readingSince > 0) return@post
            b.setMode(if (capture?.running != true) ReadButton.Mode.OFF else ReadButton.Mode.IDLE)
        }
    }
    private fun flashBubble(txt: String, ms: Long = 1200) {
        val b = bubble ?: return
        if (readingSince > 0) return   // the reading look stays until the read is done
        b.flash(txt, "copied", ms)
    }

    // ---------------------------------------------------------------- reading look (Derek: "clearer feedback when a search
    // is happening, sometimes I tap too many times"): the bubble's scan sweeps (ReadButton READING) until the page says the read is done
    // (Bridge.reading), at most 25 s. Taps meanwhile buzz and only make the page say "still reading".
    private var readingSince = 0L
    private val readTimeout = Runnable { setReading(false) }
    private fun reading() = readingSince > 0 && SystemClock.elapsedRealtime() - readingSince < 25000
    private fun setReading(on: Boolean) {
        val b = bubble ?: return
        main.removeCallbacks(readTimeout)
        if (on) {
            readingSince = SystemClock.elapsedRealtime()
            b.setMode(ReadButton.Mode.READING)
            main.postDelayed(readTimeout, 25000)
        } else {
            readingSince = 0L
            bubbleIdle()
        }
    }

    // ---------------------------------------------------------------- actions
    private fun readNow(src: String) {
        if (web == null) return
        bubble?.performHapticFeedback(HapticFeedbackConstants.CONFIRM)   // the tap registered
        if (reading()) { js("window.__phone&&window.__phone.stillReading&&window.__phone.stillReading()"); return }
        if (capture?.running != true) { askCapture(true); return }   // one tap: the system dialog, then the read
        setReading(true)
        js("window.__phone&&window.__phone.blur&&window.__phone.blur()")   // the keyboard sits above every overlay: it would be in the frame
        setFocusable(false, false)
        if (src == "bubble" && wide) toCard()
        main.postDelayed({ js("window.__phone&&window.__phone.readNow(" + JSONObject.quote(src) + ")") }, 120)
    }

    private fun dump() {
        val r = WhatnotReader.instance
        if (r == null) { toast("screen reader is off: turn on CardComp under Settings > Accessibility"); return }
        toast("dumping the screen…")
        pool.execute {
            val txt = try { r.dump() } catch (e: Exception) { "dump failed: ${e.message}" }
            main.post {
                copy(txt)
                toast("screen dump copied (${txt.length} chars), also saved in the app")
                js("window.__phone&&window.__phone.dumpNote&&window.__phone.dumpNote('screen dump copied')")
            }
        }
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
        listOf("recog-read.js", "imgmatch.js", "bridge.js").joinToString("\n;\n") { assets.open(it).bufferedReader().readText() }.also { bundledJs = it }
    } catch (e: Exception) { Log.w(TAG, "bundled js: ${e.message}"); "" }

    private val pool = java.util.concurrent.Executors.newFixedThreadPool(8)
    private fun fetchDataUrl(url: String): String {
        val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 8000; c.readTimeout = 8000
        c.setRequestProperty("User-Agent", "CardComp/" + BuildConfig.VERSION_NAME)
        try {
            if (c.responseCode != 200) return ""
            val type = (c.contentType ?: "image/jpeg").substringBefore(';').trim()
            if (!type.startsWith("image/")) return ""
            val bytes = c.inputStream.use { it.readBytes() }
            if (bytes.size > 3_000_000) return ""
            return "data:$type;base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        } finally { c.disconnect() }
    }

    /** Whatnot's screen texts from WhatnotReader -> the page's lot reader */
    fun pushScreen(json: String) { js("window.__phone&&window.__phone.screen&&window.__phone.screen($json,${screenW},${screenH})") }

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

        @JavascriptInterface fun key(name: String): String = if (!pageUrl.startsWith(APP_URL)) "" else when (name) {
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

        /** the page's read state: true when a read starts (also automatic ones), false when its reply is in or it failed */
        @JavascriptInterface fun reading(on: Boolean) { main.post { if (on != (readingSince > 0)) setReading(on) } }

        /** one frame of the screen -> window.__phone.frame(req, dataUrl, w, h), or frameFail(req, why) */
        @JavascriptInterface fun grab(req: String): String {
            val c = capture ?: run { main.post { askCapture(false) }; return "screen capture is off: allow it in the dialog, then read again" }
            if (!c.contentVisible) return "Whatnot is not on screen (the capture is set to Whatnot only): bring it up, then read"
            val q = JSONObject.quote(req)
            main.post {
                // a whole-screen capture would include the panel and bubble: hide them for the frame (~0.2 s blink).
                // Capturing "a single app" leaves them out anyway.
                band?.alpha = 0f; bubble?.alpha = 0f
                main.postDelayed({ val started = c.grab { bmp ->
                    band?.alpha = 1f; bubble?.alpha = 1f
                    if (bmp == null) {
                        // two empty grabs in a row: the capture is alive in name only (its app gone): treat it as ended
                        if (c.contentVisible && ++noFrames >= 2 && capture === c) { c.release(); capture = null; captureLost("screen capture stopped giving pictures: tap start on the bubble") }
                        js("window.__phone.frameFail($q,'no frame from the screen capture: tap start on the bubble if it says so')")
                    }
                    else Thread {
                        noFrames = 0
                        val f = cardBand(bmp)
                        val url = Capture.jpegDataUrl(f, 88)
                        js("window.__phone.frame($q,${JSONObject.quote(url)},${f.width},${f.height})")
                    }.start()
                }
                    if (!started) { band?.alpha = 1f; bubble?.alpha = 1f; js("window.__phone.frameFail($q,'still reading the last card')") }
                }, 150)
            }
            return "ok"
        }

        /** phase 0: the bid goes to the clipboard; phase 1 fills Whatnot's Custom bid box through WhatnotReader */
        /** Copies the bid; with the screen reader on (and the setting), also opens Whatnot's Custom sheet and enters it.
         *  Then answers later through window.__phone.bidAck({ok} / {why:"under", min} / {why:"sold"} / {why}). */
        @JavascriptInterface fun bid(amount: String, name: String): String {
            main.post { copy(amount); flashBubble("\$$amount", 1500) }
            val r = WhatnotReader.instance
            val v = amount.toIntOrNull()
            if (r == null || v == null || v < 1 || !prefs.fillBid) return JSONObject().put("ok", false).put("why", "copied").toString()
            r.fillBid(v) { res -> js("window.__phone&&window.__phone.bidAck(" + res.toString() + ")") }
            return JSONObject().put("pending", true).toString()
        }

        /** a candidate's card photo for the picture match -> window.__phone.img(req, dataUrl or "") (the CDN allows no
         *  cross-origin reads from the page, so the app fetches it) */
        @JavascriptInterface fun img(url: String, req: String) {
            val q = JSONObject.quote(req)
            if (!(url.startsWith("https://tcgplayer-cdn.tcgplayer.com/") || url.startsWith("https://images.pokemontcg.io/"))) { js("window.__phone.img($q,'')"); return }
            pool.execute {
                val data = try { fetchDataUrl(url) } catch (_: Exception) { "" }
                js("window.__phone.img($q,${JSONObject.quote(data)})")
            }
        }
        /** A file shipped in the APK (assets/): the extension's store.js and tcgfast.js, run in the page with shims */
        @JavascriptInterface fun asset(name: String): String = if (!Regex("^[a-z0-9-]+\\.js$").matches(name)) "" else try { assets.open(name).bufferedReader().readText() } catch (_: Exception) { "" }
        /** HTTP for the TCGplayer fast read (its data services refuse cross-origin calls from a page) ->
         *  window.__phone.http(req, status, body). TCGplayer hosts only. */
        @JavascriptInterface fun http(req: String, method: String, url: String, body: String) {
            val q = JSONObject.quote(req)
            val host = try { java.net.URL(url).host } catch (_: Exception) { "" }
            if (!url.startsWith("https://") || !(host == "tcgplayer.com" || host.endsWith(".tcgplayer.com"))) { js("window.__phone.http($q,0,'')"); return }
            pool.execute {
                var code = 0; var txt = ""
                try {
                    val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    c.connectTimeout = 5000; c.readTimeout = 6000
                    c.setRequestProperty("Accept", "application/json")
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 15) CardCompPhone/" + BuildConfig.VERSION_NAME)
                    if (method == "POST") {
                        c.requestMethod = "POST"; c.doOutput = true
                        c.setRequestProperty("Content-Type", "application/json")
                        c.outputStream.use { it.write(body.toByteArray()) }
                    }
                    code = c.responseCode
                    txt = ((if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: "").take(2_000_000)
                    c.disconnect()
                } catch (_: Exception) { code = 0 }
                js("window.__phone.http($q,$code,${JSONObject.quote(txt)})")
            }
        }
        @JavascriptInterface fun copy(text: String) { main.post { this@OverlayService.copy(text) } }
        @JavascriptInterface fun bundled(): String = this@OverlayService.bundled()
        @JavascriptInterface fun bundledVer(): String = Regex("const VER = \"([0-9.]+)\"").find(bundled())?.groupValues?.get(1) ?: "0"
        @JavascriptInterface fun open(url: String) { if (url.startsWith("https://")) main.post { openExternal(url) } }
        @JavascriptInterface fun focus(want: Boolean) { main.post { setFocusable(want, want) } }
        /** the page's mode changed (card, list, typing) or a read landed: the panel shows, collapsed or not */
        @JavascriptInterface fun layout(s: String) { main.post {
            val card = s.startsWith("card")
            typing(s == "typing"); widen(!card)
            if (!card || s == "card-show") showPanel(true)
        } }
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
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("CardComp over Whatnot")
            .setContentText("tap the gold bubble to read the card on screen")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(icon, "Dump screen", act(ACTION_DUMP, 2)).build())
            .addAction(Notification.Action.Builder(icon, "Stop", act(ACTION_STOP, 3)).build())
            .build()
    }
}
