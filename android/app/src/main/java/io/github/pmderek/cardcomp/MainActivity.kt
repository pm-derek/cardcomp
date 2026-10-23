package io.github.pmderek.cardcomp

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File

/** Setup screen: permissions, keys, start / stop the overlay, share the last screen dump. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var keyIn: EditText
    private lateinit var tokIn: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = dp(16)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun text(s: String, size: Float = 14f): TextView = TextView(this).apply {
            text = s; textSize = size; setPadding(0, dp(6), 0, dp(6))
        }.also { col.addView(it) }
        fun button(label: String, on: () -> Unit): Button = Button(this).apply {
            text = label; setOnClickListener { on() }
        }.also { col.addView(it) }

        text("CardComp over Whatnot", 22f)
        status = text("")
        text("Once: the three switches below. Then Start overlay, allow the screen capture, open Whatnot.", 13f)
        button("1. Allow display over other apps") {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        button("2. Allow notifications") { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) }
        button("3. Turn on the screen reader (Accessibility)") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        text("Sideloaded app: if the Accessibility switch is greyed out, open this app's App info, menu, Allow restricted settings, then try again.", 12f)

        text("Anthropic API key (reads the card on screen)")
        keyIn = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "sk-ant-..."; setText(prefs.anthropicKey)
        }
        col.addView(keyIn)
        text("GitHub token (lot log and verified prices, phase 1)")
        tokIn = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "github_pat_..."; setText(prefs.ghToken)
        }
        col.addView(tokIn)
        button("Save keys") {
            prefs.anthropicKey = keyIn.text.toString().trim()
            prefs.ghToken = tokIn.text.toString().trim()
            toast("saved"); refresh()
        }

        button("Start overlay") { start() }
        button("Stop overlay") {
            startService(Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_STOP)); refresh()
        }
        text("In the overlay: tap the gold bubble to read the card, drag it anywhere, long press to hide or show CardComp. " +
            "The notification has Read, Dump screen and Stop. A dump copies Whatnot's screen layout to the clipboard for the phase 1 reader.", 12f)
        button("Copy last screen dump") { lastDump()?.let { copy(it.readText()); toast("copied ${it.name}") } ?: toast("no dump yet") }
        button("Share last screen dump") { lastDump()?.let { share(it) } ?: toast("no dump yet") }
        text("Version ${BuildConfig.VERSION_NAME} build ${BuildConfig.BUILD_ID}", 12f)
        setContentView(ScrollView(this).apply { addView(col) })
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        val overlay = Settings.canDrawOverlays(this)
        val notes = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        status.text = "overlay permission ${mark(overlay)} · notifications ${mark(notes)} · screen reader ${mark(WhatnotReader.connected())} · " +
            "API key ${mark(prefs.anthropicKey.isNotEmpty())} · overlay ${if (OverlayService.running) "running" else "stopped"}"
    }
    private fun mark(b: Boolean) = if (b) "✓" else "✗"

    private fun start() {
        if (!Settings.canDrawOverlays(this)) { toast("allow display over other apps first (button 1)"); return }
        if (prefs.anthropicKey.isEmpty()) toast("no API key yet: reads will fail until you add one")
        val mgr = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(mgr.createScreenCaptureIntent(), 7)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 7) return
        if (resultCode == RESULT_OK && data != null) {
            val i = Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_START)
                .putExtra(OverlayService.EXTRA_CODE, resultCode).putExtra(OverlayService.EXTRA_DATA, data)
            startForegroundService(i)
            toast("overlay started: open Whatnot")
        } else {
            toast("screen capture not allowed: the read button cannot work")
        }
        refresh()
    }

    private fun lastDump(): File? = File(filesDir, "dumps").listFiles()?.maxByOrNull { it.lastModified() }

    private fun share(f: File) {
        var txt = f.readText()
        if (txt.length > 400_000) txt = txt.substring(0, 400_000) + "\n[cut]"
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, f.name).putExtra(Intent.EXTRA_TEXT, txt), "Share screen dump"))
    }

    private fun copy(text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("CardComp dump", text))
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()
    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_SHORT).show()
}
