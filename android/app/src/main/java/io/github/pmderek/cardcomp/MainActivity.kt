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
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Setup screen: permissions, keys, model, start / stop the overlay, updates, screen dumps. */
class MainActivity : Activity() {
    companion object {
        @Volatile var resumed = false
        const val RELEASE_API = "https://api.github.com/repos/pm-derek/cardcomp/releases/tags/phone-latest"
        const val APK_URL = "https://github.com/pm-derek/cardcomp/releases/download/phone-latest/cardcomp-phone.apk"
    }
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var keyIn: EditText
    private lateinit var tokIn: EditText
    private lateinit var keyNote: TextView
    private lateinit var updNote: TextView
    private lateinit var updBtn: Button
    private lateinit var dumpNote: TextView
    private var updChecked = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        val pad = dp(16)
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun text(s: String, size: Float = 14f): TextView = TextView(this).apply {
            text = s; textSize = size; setPadding(0, dp(6), 0, dp(6))
        }.also { col.addView(it) }
        fun head(s: String) = text(s, 17f).apply { setPadding(0, dp(18), 0, dp(4)) }
        fun button(label: String, on: () -> Unit): Button = Button(this).apply {
            text = label; isAllCaps = false; setOnClickListener { on() }
        }.also { col.addView(it) }

        text("CardComp over Whatnot", 22f)
        status = text("")

        head("Start")
        button("Start overlay") { start() }
        button("Stop overlay") {
            startService(Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_STOP)); status.postDelayed({ refresh() }, 300)
        }
        text("In the capture dialog pick \"A single app\" and choose Whatnot. Tap the gold bubble to read the card; " +
            "drag it anywhere; long press it to hide or show the panel. Move the panel by its top bar, change its width with ◢, " +
            "fold it into the bubble with –. Tap the bid to copy it, then paste it in Whatnot's Custom box.", 12f)

        head("Setup (once)")
        button("1. Allow display over other apps") {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        button("2. Allow notifications") { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1) }
        button("3. Screen reader (saves Whatnot's layout for phase 1)") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        text("Android blocks this switch for apps installed from a download. Try it once (it says the app was denied), " +
            "then tap Open App info below: ⋮ at the top right > Allow restricted settings. The ⋮ only appears after that denied try.", 12f)
        button("Open App info") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }

        head("Keys")
        text("Anthropic API key (reads the card on screen)", 13f)
        keyIn = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "sk-ant-..."; setText(prefs.anthropicKey)
        }
        col.addView(keyIn)
        text("GitHub token (lot log and verified prices: not used yet, phase 1)", 13f)
        tokIn = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "github_pat_... (optional)"; setText(prefs.ghToken)
        }
        col.addView(tokIn)
        button("Save keys and test the API key") { saveKeys(); testKey() }
        keyNote = text("", 12f)

        head("Bidding")
        col.addView(android.widget.CheckBox(this).apply {
            text = "A bid tap opens Whatnot's Custom bid and enters the amount (needs the screen reader). You press Submit."
            isChecked = prefs.fillBid; setOnCheckedChangeListener { _, v -> prefs.fillBid = v }
        })
        text("Off, or without the screen reader: the bid is copied, paste it in Custom yourself.", 12f)

        head("Model that reads the card")
        val models = listOf("haiku" to "Haiku (fastest, cheapest, weakest)", "sonnet" to "Sonnet (what desktop uses)", "opus" to "Opus (slowest, priciest)")
        val group = RadioGroup(this)
        models.forEachIndexed { i, (k, label) ->
            group.addView(RadioButton(this).apply { id = View.generateViewId(); text = label; tag = k; isChecked = prefs.model == k })
        }
        group.setOnCheckedChangeListener { g, id -> (g.findViewById<RadioButton>(id)?.tag as? String)?.let { prefs.model = it } }
        col.addView(group)

        head("Update")
        updNote = text("checking…", 12f)
        updBtn = button("Install update") { update() }
        updBtn.visibility = View.GONE

        head("Screen layouts (for the phase 1 reader)")
        text("With the screen reader on, nothing to do: during a stream it saves Whatnot's screen layout by itself whenever the auction changes " +
            "(lot starts, bids, Custom bid opened, sold). With the GitHub token saved they go to your private cardcomp-data repo, where Claude reads them.", 12f)
        dumpNote = text("", 12f)
        button("Share last screen dump") { lastDump()?.let { share(it) } ?: toast("no dump yet") }
        text("Version ${BuildConfig.VERSION_NAME} · build ${BuildConfig.BUILD_ID.take(7)}", 12f)

        val sv = ScrollView(this).apply { addView(col); fitsSystemWindows = true }   // targetSdk 35 draws edge to edge: keep clear of the status bar
        setContentView(sv)
    }

    // the overlay never covers this screen (it hid the Stop button)
    override fun onResume() {
        super.onResume(); resumed = true; OverlayService.instance?.appVisible(true); refresh()
        if (System.currentTimeMillis() - updChecked > 5 * 60_000) checkUpdate()
    }
    override fun onPause() { resumed = false; OverlayService.instance?.appVisible(false); super.onPause() }

    private fun refresh() {
        val overlay = Settings.canDrawOverlays(this)
        val notes = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        status.text = "display over apps ${mark(overlay)} · notifications ${mark(notes)} · API key ${mark(prefs.anthropicKey.isNotEmpty())} · " +
            "screen reader ${mark(WhatnotReader.connected())}\noverlay ${if (OverlayService.running) "running" else "stopped"}"
        val n = File(filesDir, "dumps").listFiles()?.size ?: 0
        val up = WhatnotReader.lastUpload
        dumpNote.text = "$n layouts saved on the phone" + when {
            prefs.ghToken.isEmpty() -> " · no GitHub token: tap Share below after a stream"
            up == "201" -> " · uploading to cardcomp-data ✓"
            up.isEmpty() -> ""
            up == "401" || up == "403" || up == "404" -> " · upload refused ($up): the token needs Contents read/write on cardcomp-data"
            else -> " · last upload: $up"
        }
    }
    private fun mark(b: Boolean) = if (b) "✓" else "✗"

    private fun saveKeys() {
        prefs.anthropicKey = keyIn.text.toString().trim()
        prefs.ghToken = tokIn.text.toString().trim()
        refresh()
    }

    /** a tiny text-only call (Haiku, 16 tokens) so a bad key shows here, not mid-stream */
    private fun testKey() {
        val key = prefs.anthropicKey
        if (key.isEmpty()) { keyNote.text = "no key saved"; return }
        keyNote.text = "testing…"
        Thread {
            val msg = try {
                val c = URL("https://api.anthropic.com/v1/messages").openConnection() as HttpURLConnection
                c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 10000; c.readTimeout = 20000
                c.setRequestProperty("content-type", "application/json")
                c.setRequestProperty("x-api-key", key)
                c.setRequestProperty("anthropic-version", "2023-06-01")
                val body = JSONObject().put("model", "claude-haiku-5-5").put("max_tokens", 16)
                    .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", "Reply with: ok")))
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = c.responseCode
                val txt = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                c.disconnect()
                when {
                    code in 200..299 -> "key works ✓"
                    code == 401 -> "key rejected (401): check it was pasted whole"
                    code == 403 -> "key not allowed to use this model (403)"
                    code == 400 && Regex("credit|balance", RegexOption.IGNORE_CASE).containsMatchIn(txt) -> "out of API credit"
                    else -> "API error $code: ${txt.take(120)}"
                }
            } catch (e: Exception) { "network: ${e.message}" }
            runOnUiThread { keyNote.text = msg }
        }.start()
    }

    private fun start() {
        if (!Settings.canDrawOverlays(this)) { toast("allow display over other apps first (Setup 1)"); return }
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
            moveTaskToBack(true)   // out of the way: the overlay shows once this screen is gone
        } else {
            toast("screen capture not allowed: the read button cannot work")
        }
        refresh()
    }

    // ---------------------------------------------------------------- in-app update (no browser download)
    /** The phone-latest release says which commit it was built from; a different one than this build = update. */
    private fun checkUpdate() {
        updChecked = System.currentTimeMillis()
        Thread {
            val (latest, err) = try {
                val c = URL(RELEASE_API).openConnection() as HttpURLConnection
                c.setRequestProperty("Accept", "application/vnd.github+json"); c.connectTimeout = 8000; c.readTimeout = 8000
                val body = c.inputStream.bufferedReader().use { it.readText() }; c.disconnect()
                Pair(Regex("built from ([0-9a-f]{7})").find(JSONObject(body).optString("body"))?.groupValues?.get(1), null)
            } catch (e: Exception) { Pair(null, e.message) }
            runOnUiThread {
                val mine = BuildConfig.BUILD_ID.take(7)
                when {
                    latest == null -> { updNote.text = "could not check for updates${if (err != null) " ($err)" else ""}"; updBtn.visibility = View.GONE }
                    latest == mine -> { updNote.text = "up to date ($mine)"; updBtn.visibility = View.GONE }
                    else -> { updNote.text = "update available: $latest (this is $mine)"; updBtn.visibility = View.VISIBLE }
                }
            }
        }.start()
    }

    private fun update() {
        if (!packageManager.canRequestPackageInstalls()) {
            toast("allow CardComp to install updates, then tap Install update again")
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            return
        }
        updBtn.isEnabled = false; updNote.text = "downloading…"
        Thread {
            val err = try {
                val f = File(cacheDir, "update.apk")
                val c = URL(APK_URL).openConnection() as HttpURLConnection
                c.instanceFollowRedirects = true; c.connectTimeout = 10000; c.readTimeout = 30000
                c.inputStream.use { inp -> f.outputStream().use { inp.copyTo(it) } }; c.disconnect()
                Updater.install(this, f); null
            } catch (e: Exception) { e.message ?: "failed" }
            runOnUiThread {
                updBtn.isEnabled = true
                updNote.text = err?.let { "update failed: $it" } ?: "confirm the install in the dialog"
            }
        }.start()
    }

    private fun lastDump(): File? = File(filesDir, "dumps").listFiles()?.maxByOrNull { it.lastModified() }

    private fun share(f: File) {
        var txt = f.readText()
        if (txt.length > 400_000) txt = txt.substring(0, 400_000) + "\n[cut]"
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, f.name).putExtra(Intent.EXTRA_TEXT, txt), "Share screen dump"))
    }

    @Suppress("unused")
    private fun copy(text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("CardComp dump", text))
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()
    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_SHORT).show()
}
