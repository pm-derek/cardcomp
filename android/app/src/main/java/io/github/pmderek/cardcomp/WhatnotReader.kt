package io.github.pmderek.cardcomp

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The phone twin of extension/whatnot.js: reads the Whatnot app's view tree instead of the web page's DOM.
 * Phase 0: [dump], a text listing of every window on screen (class, id, text, bounds, flags), saved under
 * files/dumps, so the lot reader and the bid fill (phase 1) can be written from what Whatnot's Android app really
 * shows. Dumps are taken by themselves (Derek, 2026-10-23: pulling down the notification mid-stream is not a thing
 * he will do): while a Whatnot live screen is up ("Say something" chat box), whenever the auction words on screen
 * change (timer start, bids, Sold / won, Custom bid sheet, Awaiting next item), at most one per 8 s, 60 kept.
 * With a GitHub token saved, each dump is also uploaded to the private repo pm-derek/cardcomp-data (phone-dumps/),
 * where Claude reads them. Nothing here acts on the screen.
 */
class WhatnotReader : AccessibilityService() {
    companion object {
        @Volatile var instance: WhatnotReader? = null
        @Volatile var lastPackage: String = ""
        /** HTTP status of the last dump upload ("201" = saved in cardcomp-data), shown on the setup screen */
        @Volatile var lastUpload: String = ""
        fun connected(): Boolean = instance != null
    }

    override fun onServiceConnected() {
        instance = this
        serviceInfo = (serviceInfo ?: AccessibilityServiceInfo()).apply {
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
    }

    private val worker = android.os.HandlerThread("cardcomp-reader").apply { start() }
    private val bg = android.os.Handler(worker.looper)
    private var lastSig = ""
    private var lastDumpAt = 0L
    private val check = Runnable { autoDump() }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val p = event?.packageName?.toString() ?: return
        if (p.isEmpty() || p == packageName || p == "com.android.systemui") return
        lastPackage = p
        bg.removeCallbacks(check); bg.postDelayed(check, 1500)   // settle: Whatnot re-renders in bursts
    }

    /** auction words on screen, as a signature: a new one means a new state worth a dump */
    private val AUCTION = Regex("""^(Sold|Custom|Submit Max Bid|Max Bid|Awaiting Next Item|Bid \$[0-9,]+.*|\$[0-9,]+|[0-9]{1,2}:[0-9]{2}|[0-9]+ Bids?|.* won!?|.* is winning!?|Won the auction!?|Set Max Bid.*)$""", RegexOption.IGNORE_CASE)
    private fun autoDump() {
        try {
            val root = rootInActiveWindow ?: return
            val texts = ArrayList<String>()
            collect(root, texts, 0)
            if (texts.none { it.startsWith("Say something") }) return   // not a Whatnot live screen
            val sig = texts.filter { AUCTION.matches(it) }.map { if (Regex("^[0-9]{1,2}:[0-9]{2}$").matches(it)) "timer" else it }.distinct().sorted().joinToString("|")
            val now = System.currentTimeMillis()
            if (sig == lastSig || now - lastDumpAt < 8000) return
            lastSig = sig; lastDumpAt = now
            val txt = dump()
            upload(txt)
        } catch (_: Exception) {}
    }
    private fun collect(n: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
        if (depth > 60 || out.size > 2000) return
        n.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { out.add(it.replace('\n', ' ')) }
        for (i in 0 until n.childCount) { val c = try { n.getChild(i) } catch (_: Exception) { null } ?: continue; collect(c, out, depth + 1) }
    }

    /** to the private log repo, so Derek never has to share anything (needs Contents write on cardcomp-data) */
    private fun upload(txt: String) {
        val tok = Prefs(this).ghToken
        if (tok.isEmpty()) return
        val name = "phone-dumps/dump-" + SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date()) + ".txt"
        try {
            val c = java.net.URL("https://api.github.com/repos/pm-derek/cardcomp-data/contents/$name").openConnection() as java.net.HttpURLConnection
            c.requestMethod = "PUT"; c.doOutput = true; c.connectTimeout = 10000; c.readTimeout = 20000
            c.setRequestProperty("Authorization", "Bearer $tok")
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("Content-Type", "application/json")
            val body = org.json.JSONObject().put("message", "phone screen dump").put("branch", "main")
                .put("content", android.util.Base64.encodeToString(txt.toByteArray(), android.util.Base64.NO_WRAP))
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            lastUpload = "${c.responseCode}"
            c.disconnect()
        } catch (e: Exception) { lastUpload = "error: ${e.message}" }
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        worker.quitSafely()
        instance = null
        super.onDestroy()
    }

    fun dump(): String {
        val ts = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
        val sb = StringBuilder()
        sb.append("CardComp screen dump ").append(ts).append(" last event from ").append(lastPackage).append('\n')
        val wins = try { windows } catch (_: Exception) { null } ?: emptyList()
        for (w in wins) {
            val root = try { w.root } catch (_: Exception) { null } ?: continue
            sb.append("== window type=").append(w.type).append(" layer=").append(w.layer)
                .append(" pkg=").append(root.packageName).append(" title=").append(w.title ?: "").append('\n')
            walk(root, 0, sb)
        }
        if (wins.isEmpty()) {
            val root = rootInActiveWindow
            if (root != null) { sb.append("== active pkg=").append(root.packageName).append('\n'); walk(root, 0, sb) }
            else sb.append("(no windows readable)\n")
        }
        val txt = sb.toString()
        try {
            val dir = File(filesDir, "dumps"); dir.mkdirs()
            File(dir, "dump-$ts.txt").writeText(txt)
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(60)?.forEach { it.delete() }
        } catch (_: Exception) {}
        return txt
    }

    private fun walk(n: AccessibilityNodeInfo, depth: Int, sb: StringBuilder) {
        if (depth > 60) return
        val r = Rect(); n.getBoundsInScreen(r)
        val cls = (n.className ?: "").toString().substringAfterLast('.')
        val id = n.viewIdResourceName?.substringAfter('/') ?: ""
        val t = n.text?.toString()?.replace('\n', ' ') ?: ""
        val d = n.contentDescription?.toString()?.replace('\n', ' ') ?: ""
        val flags = buildString {
            if (n.isClickable) append('c'); if (n.isEditable) append('e'); if (n.isFocusable) append('f')
            if (n.isScrollable) append('s'); if (!n.isVisibleToUser) append('h')
        }
        if (t.isNotEmpty() || d.isNotEmpty() || id.isNotEmpty() || n.isClickable || n.isEditable) {
            sb.append("  ".repeat(depth)).append(cls).append(' ')
                .append(r.left).append(',').append(r.top).append('-').append(r.right).append(',').append(r.bottom)
            if (flags.isNotEmpty()) sb.append(" [").append(flags).append(']')
            if (id.isNotEmpty()) sb.append(" #").append(id)
            if (t.isNotEmpty()) sb.append(" \"").append(t).append('"')
            if (d.isNotEmpty()) sb.append(" (").append(d).append(')')
            sb.append('\n')
        }
        for (i in 0 until n.childCount) {
            val c = try { n.getChild(i) } catch (_: Exception) { null } ?: continue
            walk(c, depth + 1, sb)
        }
    }
}
