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
    private var lastPush = 0L
    private val push = Runnable { pushScreen() }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val p = event?.packageName?.toString() ?: return
        if (p.isEmpty() || p == packageName || p == "com.android.systemui") return
        lastPackage = p
        bg.removeCallbacks(check); bg.postDelayed(check, 1500)   // settle: Whatnot re-renders in bursts
        // the lot reader: at most ~3 snapshots a second, the last change always sent
        if (!bg.hasCallbacks(push)) bg.postDelayed(push, maxOf(0L, 350L - (System.currentTimeMillis() - lastPush)))
    }

    /** Every text on Whatnot's screen with its bounds, to the CardComp page (phone/bridge.js reads the lot from it,
     *  like extension/whatnot.js reads the web page). Only while a Whatnot live screen is up. */
    private fun pushScreen() {
        lastPush = System.currentTimeMillis()
        val svc = OverlayService.instance ?: return
        val all = try { nodes() } catch (_: Exception) { return }
        if (all.none { it.pkg == WHATNOT && LIVE.containsMatchIn(it.text) }) return   // chat minimized: the bid row still says it is live
        val arr = org.json.JSONArray()
        for (n in all) {
            // Whatnot's own window only (2026-10-30: in split screen the other half, Chrome on eBay / TCGplayer / CardComp,
            // was sent too, and its prices and headings were logged as $1,500 "wins")
            if (n.pkg != WHATNOT) continue
            // on screen only (2026-10-31 audit: 300 hidden nodes with a size in 159 dumps, a stale "Sold" / "X won!" under the
            // keyboard among them, read as a sale)
            if (!n.node.isVisibleToUser) continue
            if (n.text.isEmpty() || n.r.width() <= 0 || n.r.height() <= 0) continue
            arr.put(org.json.JSONObject().put("t", n.text.take(160)).put("l", n.r.left).put("y", n.r.top).put("r", n.r.right).put("b", n.r.bottom)
                .put("c", if (n.node.isClickable) 1 else 0))
            if (arr.length() > 600) break
        }
        svc.pushScreen(arr.toString())
    }

    /** auction words on screen, as a signature: a new one means a new state worth a dump */
    private val AUCTION = Regex("""^(Sold|Custom|Submit (Max |Exact )?Bid|Max Bid|Awaiting Next Item|Bid \$[0-9,]+.*|\$[0-9,]+|[0-9]{1,2}:[0-9]{2}|[0-9]+ Bids?|.* won!?|.* is winning!?|Won the auction!?|Set Max Bid.*|.*\b(coupons?|promo code|discount)\b.*)$""", RegexOption.IGNORE_CASE)   // coupon: dump the screen so its switch can be read (2026-10-31)
    private fun autoDump() {
        try {
            val texts = nodes().map { it.text }.filter { it.isNotEmpty() }
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
    private val WHATNOT = "com.whatnot_mobile"
    // The Custom sheet's button reads "Submit Max Bid" with its Max Bid switch on and "Submit Exact Bid" with it off
    // (2026-10-28 dumps: both); only the first was known, so with the switch off the sheet looked closed.
    private val SUBMIT = Regex("""^Submit (Max |Exact )?Bid$""", RegexOption.IGNORE_CASE)
    // A Whatnot live screen: its bid row, the Custom sheet, a sold lot or the chat box (the chat can be minimized)
    private val LIVE = Regex("""^(Custom|Submit (Max |Exact )?Bid|Awaiting Next Item|Sold|Bid \$[0-9,]+)$|^Say something|^Max bid added""", RegexOption.IGNORE_CASE)
    private class N(val node: AccessibilityNodeInfo, val text: String, val r: Rect, val pkg: String = "")
    private fun nodes(): List<N> {
        val out = ArrayList<N>()
        val wins = try { windows } catch (_: Exception) { null } ?: emptyList()
        val roots = wins.mapNotNull { try { it.root } catch (_: Exception) { null } }.filter { it.packageName?.toString() != packageName }
        fun walk(n: AccessibilityNodeInfo, d: Int, pkg: String) {
            if (d > 60 || out.size > 4000) return
            val r = Rect(); n.getBoundsInScreen(r)
            out.add(N(n, (n.text ?: n.contentDescription ?: "").toString().replace('\n', ' ').trim(), r, pkg))
            for (i in 0 until n.childCount) { val c = try { n.getChild(i) } catch (_: Exception) { null } ?: continue; walk(c, d + 1, pkg) }
        }
        for (r in (if (roots.isEmpty()) listOfNotNull(rootInActiveWindow) else roots)) walk(r, 0, r.packageName?.toString() ?: "")
        return out
    }
    private fun clickable(n: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var c: AccessibilityNodeInfo? = n; var i = 0
        while (c != null && i < 6) { if (c.isClickable) return c; c = c.parent; i++ }
        return null
    }
    private val MONEY = Regex("""^\$\s?([0-9][0-9,]*)$""")
    private fun dollars(t: String): Int? = MONEY.find(t)?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull()

    // its own thread: never queued behind a screen save or a screen push (a fill must land within a second or two)
    private val fillThread = android.os.HandlerThread("cardcomp-fill").apply { start() }
    private val fillBg = android.os.Handler(fillThread.looper)
    fun fillBid(amount: Int, done: (org.json.JSONObject) -> Unit) {
        fillBg.removeCallbacksAndMessages(null)   // a newer tap replaces one still waiting
        fillBg.post {
            val res = try { fill(amount) } catch (e: Exception) { org.json.JSONObject().put("ok", false).put("why", "error: ${e.message}") }
            done(res)
            // the screen as the fill left it, so the next fix is written from facts (uploaded with a token)
            if (!res.optBoolean("ok") && res.optString("why") !in setOf("sold", "under")) try { upload("custom fill: ${res.optString("why")}\n" + dump()) } catch (_: Exception) {}
        }
    }
    private fun fill(amount: Int): org.json.JSONObject {
        fun no(why: String) = org.json.JSONObject().put("ok", false).put("why", why)
        // Whatnot's window only (split screen puts Chrome or Claude beside it: Chrome's "Customize and control" once
        // matched as Custom). Live = its bid row or sheet is on screen; the chat box is often not readable, so it is not
        // required (28 of 31 failed fills before 2026-10-29 had Custom and "Bid $N" on screen and stopped here).
        fun wn() = nodes().filter { it.pkg == WHATNOT }
        var all = wn()
        if (all.none { LIVE.containsMatchIn(it.text) }) return no(if (all.isEmpty()) "Whatnot not on screen" else "Whatnot live screen not in front")
        if (all.any { it.text.equals("Awaiting Next Item", true) || it.text == "Sold" }) return no("sold")
        val next = all.mapNotNull { Regex("""^Bid \$([0-9,]+)""").find(it.text)?.groupValues?.get(1)?.replace(",", "")?.toIntOrNull() }.firstOrNull()
        if (next != null && amount < next) return no("under").put("min", next)
        if (all.none { SUBMIT.matches(it.text) }) {
            val customRx = Regex("^(custom|max bid added|edit max|increase max|your max)", RegexOption.IGNORE_CASE)
            fun findCustom() = all.firstOrNull { it.text.equals("Custom", true) } ?: all.firstOrNull { customRx.containsMatchIn(it.text) }
            var custom = findCustom()
            var w = 0
            while (custom == null && w < 10 && all.none { SUBMIT.matches(it.text) }) { Thread.sleep(100); all = wn(); custom = findCustom(); w++ }   // buttons still animating in
        }
        if (all.none { SUBMIT.matches(it.text) }) {
            val custom = (all.firstOrNull { it.text.equals("Custom", true) } ?: all.firstOrNull { Regex("^(custom|max bid added|edit max|increase max|your max)", RegexOption.IGNORE_CASE).containsMatchIn(it.text) })
                ?: return no("no Custom button on screen")
            val target = clickable(custom.node) ?: return no("Custom is not tappable")
            if (!target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return no("Whatnot refused the tap on Custom")
            var t = 0
            while (t < 20) { Thread.sleep(100); all = wn(); if (all.any { SUBMIT.matches(it.text) }) break; t++ }
            if (all.none { SUBMIT.matches(it.text) }) return no("Custom sheet did not open")
        }
        var submit = all.first { SUBMIT.matches(it.text) }
        // Max bids only (Derek, 2026-10-29: "I'll never want an exact bid; check it is a max bid and correct it"): the sheet's
        // Max Bid switch off reads "Submit Exact Bid". Turn it on (the switch, else its row) and wait for "Submit Max Bid";
        // if it stays off the amount is still entered and the result says exact, so the small card warns before Submit.
        var exact = submit.text.contains("Exact", true)
        var switched = false
        if (exact) {
            val zone = all.filter { it.r.top >= submit.r.top - (submit.r.height() * 12) && it.r.bottom <= submit.r.bottom }
            val toggle = zone.firstOrNull { (it.node.viewIdResourceName ?: "").contains("toggle", true) }?.let { clickable(it.node) }
                ?: zone.firstOrNull { it.text.equals("Max Bid", true) }?.let { clickable(it.node) }
            if (toggle != null && toggle.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                var t = 0
                while (t < 12) {
                    Thread.sleep(100); all = wn()
                    val s2 = all.firstOrNull { SUBMIT.matches(it.text) }
                    if (s2 != null) submit = s2
                    if (s2 != null && !s2.text.contains("Exact", true)) { exact = false; switched = true; break }
                    t++
                }
            }
            // still off: enter nothing (Derek, 2026-10-29: "we shouldn't put in the price for me to accidentally bid incorrectly,
            // give me a signal"); the small card shows a red warning instead
            if (exact) return no("exact")
        }
        // the sheet: everything between its title row and Submit; the amount is the biggest "$N" there
        val sheet = all.filter { it.r.top >= submit.r.top - (submit.r.height() * 12) && it.r.bottom <= submit.r.bottom }
        val edit = sheet.firstOrNull { it.node.isEditable }
        if (edit != null) {
            // Clear, type, read back (2026-10-31 audit: $19 sent became a $1,919 max, $16 became $116: the box kept what was
            // in it, the fill said ok without looking, and the amount was pasted on top). Only an exact read-back is ok; a box
            // that will not hold the amount is cleared, so a wrong number never waits behind Submit.
            fun setBox(v: String) = edit.node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,
                android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, v) })
            fun boxAmount(): Int? {
                val e = wn().firstOrNull { it.node.isEditable && it.r.bottom <= submit.r.bottom && it.r.top >= submit.r.top - submit.r.height() * 12 } ?: return null
                return e.text.replace(Regex("[^0-9]"), "").toIntOrNull()
            }
            var got: Int? = null
            for (attempt in 0 until 3) {
                setBox(""); Thread.sleep(80)
                if (!setBox(amount.toString())) continue
                Thread.sleep(150)
                got = boxAmount()
                if (got == amount) {
                    val fin = wn().firstOrNull { SUBMIT.matches(it.text) }   // still a max bid after the amount went in
                    return org.json.JSONObject().put("ok", true).put("how", "typed").put("exact", fin?.text?.contains("Exact", true) ?: exact).put("maxOn", switched)
                }
            }
            setBox("")
            return no("the box would not hold $" + amount + (if (got != null) " (it showed $" + got + ")" else "") + ": cleared it, type the amount")
        }
        fun amountNode(list: List<N>) = list.filter { dollars(it.text) != null && it.r.bottom < submit.r.top }.maxByOrNull { it.r.height() }
        var am = amountNode(sheet) ?: return no("no amount in the Custom sheet")
        val row = sheet.filter { it.node.isClickable && it.r.centerY() in am.r.top..am.r.bottom && it !== am }
        val minus = row.filter { it.r.centerX() < am.r.left }.maxByOrNull { it.r.centerX() }
        val plus = row.filter { it.r.centerX() > am.r.right }.minByOrNull { it.r.centerX() }
        if (minus == null || plus == null) return no("no − / + in the Custom sheet")
        var stuck = 0; var last = dollars(am.text) ?: return no("amount unreadable")
        for (i in 0 until 60) {
            if (last == amount) return org.json.JSONObject().put("ok", true).put("how", "stepped").put("exact", exact).put("maxOn", switched)
            (if (last < amount) plus else minus).node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            Thread.sleep(90)
            val now = wn().filter { it.r.top >= submit.r.top - (submit.r.height() * 12) && it.r.bottom <= submit.r.bottom }
            am = amountNode(now) ?: return no("amount gone")
            val v = dollars(am.text) ?: return no("amount unreadable")
            if (v == last) { if (++stuck >= 3) return no("the amount does not move: set it by hand") } else stuck = 0
            // overshoot on a coarse step: stop at the highest value not above the max (never bid over it)
            if (last < amount && v > amount) { minus.node.performAction(AccessibilityNodeInfo.ACTION_CLICK); Thread.sleep(90); return org.json.JSONObject().put("ok", true).put("how", "stepped, below max (step)").put("exact", exact).put("maxOn", switched) }
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
        worker.quitSafely(); fillThread.quitSafely()
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
