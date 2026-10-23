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

    // ---------------------------------------------------------------- the bid into Whatnot's Custom sheet (the phone twin of whatnot.js's fill)
    // Opens Custom, enters the amount, and stops: Derek presses Submit Max Bid. Never presses Submit or Bid.
    // Rules as on desktop: a lot already sold / "Awaiting Next Item" enters nothing; a max under the next bid ("Bid $5")
    // does not open the sheet ({why:"under", min}). The amount goes in by ACTION_SET_TEXT when the sheet's amount is a
    // text field; else by the sheet's − / + buttons, reading the amount back after every press (works whatever the step).
    private class N(val node: AccessibilityNodeInfo, val text: String, val r: Rect)
    private fun nodes(): List<N> {
        val out = ArrayList<N>()
        val wins = try { windows } catch (_: Exception) { null } ?: emptyList()
        val roots = wins.mapNotNull { try { it.root } catch (_: Exception) { null } }.filter { it.packageName?.toString() != packageName }
        fun walk(n: AccessibilityNodeInfo, d: Int) {
            if (d > 60 || out.size > 4000) return
            val r = Rect(); n.getBoundsInScreen(r)
            out.add(N(n, (n.text ?: n.contentDescription ?: "").toString().replace('\n', ' ').trim(), r))
            for (i in 0 until n.childCount) { val c = try { n.getChild(i) } catch (_: Exception) { null } ?: continue; walk(c, d + 1) }
        }
        for (r in (if (roots.isEmpty()) listOfNotNull(rootInActiveWindow) else roots)) walk(r, 0)
        return out
    }
    private fun clickable(n: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var c: AccessibilityNodeInfo? = n; var i = 0
        while (c != null && i < 6) { if (c.isClickable) return c; c = c.parent; i++ }
        return null
    }
    private val MONEY = Regex("""^\$\s?([0-9][0-9,]*)$""")
    private fun dollars(t: String): Int? = MONEY.find(t)?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull()

    fun fillBid(amount: Int, done: (org.json.JSONObject) -> Unit) {
        bg.post {
            val res = try { fill(amount) } catch (e: Exception) { org.json.JSONObject().put("ok", false).put("why", "error: ${e.message}") }
            done(res)
        }
    }
    private fun fill(amount: Int): org.json.JSONObject {
        fun no(why: String) = org.json.JSONObject().put("ok", false).put("why", why)
        var all = nodes()
        if (all.none { it.text.startsWith("Say something") } && all.none { it.text == "Submit Max Bid" }) return no("Whatnot live screen not in front")
        if (all.any { it.text.equals("Awaiting Next Item", true) || it.text == "Sold" }) return no("sold")
        val next = all.mapNotNull { Regex("""^Bid \$([0-9,]+)""").find(it.text)?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull() }.firstOrNull()
        if (next != null && amount < next) return no("under").put("min", next)
        if (all.none { it.text == "Submit Max Bid" }) {
            val custom = all.firstOrNull { it.text.equals("Custom", true) } ?: return no("no Custom button on screen")
            val target = clickable(custom.node) ?: return no("Custom is not tappable")
            target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            var t = 0
            while (t < 20) { Thread.sleep(100); all = nodes(); if (all.any { it.text == "Submit Max Bid" }) break; t++ }
            if (all.none { it.text == "Submit Max Bid" }) return no("Custom sheet did not open")
        }
        val submit = all.first { it.text == "Submit Max Bid" }
        // the sheet: everything between its title row and Submit; the amount is the biggest "$N" there
        val sheet = all.filter { it.r.top >= submit.r.top - (submit.r.height() * 12) && it.r.bottom <= submit.r.bottom }
        val edit = sheet.firstOrNull { it.node.isEditable }
        if (edit != null) {
            val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, amount.toString()) }
            if (edit.node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
                Thread.sleep(150)
                return org.json.JSONObject().put("ok", true).put("how", "typed")
            }
        }
        fun amountNode(list: List<N>) = list.filter { dollars(it.text) != null && it.r.bottom < submit.r.top }.maxByOrNull { it.r.height() }
        var am = amountNode(sheet) ?: return no("no amount in the Custom sheet")
        val row = sheet.filter { it.node.isClickable && it.r.centerY() in am.r.top..am.r.bottom && it !== am }
        val minus = row.filter { it.r.centerX() < am.r.left }.maxByOrNull { it.r.centerX() }
        val plus = row.filter { it.r.centerX() > am.r.right }.minByOrNull { it.r.centerX() }
        if (minus == null || plus == null) return no("no − / + in the Custom sheet")
        var stuck = 0; var last = dollars(am.text) ?: return no("amount unreadable")
        for (i in 0 until 60) {
            if (last == amount) return org.json.JSONObject().put("ok", true).put("how", "stepped")
            (if (last < amount) plus else minus).node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            Thread.sleep(90)
            val now = nodes().filter { it.r.top >= submit.r.top - (submit.r.height() * 12) && it.r.bottom <= submit.r.bottom }
            am = amountNode(now) ?: return no("amount gone")
            val v = dollars(am.text) ?: return no("amount unreadable")
            if (v == last) { if (++stuck >= 3) return no("the amount does not move: set it by hand") } else stuck = 0
            // overshoot on a coarse step: stop at the highest value not above the max (never bid over it)
            if (last < amount && v > amount) { minus.node.performAction(AccessibilityNodeInfo.ACTION_CLICK); Thread.sleep(90); return org.json.JSONObject().put("ok", true).put("how", "stepped, below max (step)") }
            last = v
        }
        return no("too many steps: set it by hand")
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
