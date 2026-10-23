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
 * Phase 0: only [dump], a text listing of every window on screen (class, id, text, bounds, flags), saved under
 * files/dumps and copied to the clipboard, so the lot reader and the bid fill (phase 1) can be written from
 * what Whatnot's Android app really shows. Nothing here acts on the screen.
 */
class WhatnotReader : AccessibilityService() {
    companion object {
        @Volatile var instance: WhatnotReader? = null
        @Volatile var lastPackage: String = ""
        fun connected(): Boolean = instance != null
    }

    override fun onServiceConnected() {
        instance = this
        serviceInfo = (serviceInfo ?: AccessibilityServiceInfo()).apply {
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val p = event?.packageName?.toString() ?: return
        if (p.isNotEmpty()) lastPackage = p
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
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
            dir.listFiles()?.sortedByDescending { it.lastModified() }?.drop(20)?.forEach { it.delete() }
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
