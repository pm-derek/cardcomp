package io.github.pmderek.cardcomp

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Toast

/**
 * Screen-capture consent without leaving the stream (Derek, 2026-10-29: "I often have to stop and restart the overlay
 * because scanning stops working when I switch screens"). Android ends a capture on its own at times (most of all a
 * "single app" capture when that app's screen changes); the bubble then reads "start", and a tap opens this invisible
 * screen: the system dialog only, then the capture starts again in the running overlay and the read goes ahead.
 * The dialog is Android's usual one: pick "A single app" and Whatnot, as in the setup screen.
 */
class ConsentActivity : Activity() {
    companion object {
        const val EXTRA_READ = "read"
        fun captureIntent(ctx: Context): Intent {
            // the user's choice, not forced to the entire screen (Derek, 2026-10-29: in split screen the whole screen
            // would put the other app in the frame and shrink the card; "A single app" (Whatnot) reads well)
            return ctx.getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent()
        }
    }

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        if (b != null) return   // recreated while the dialog is up: the result still comes here
        @Suppress("DEPRECATION")
        try { startActivityForResult(captureIntent(this), 8) } catch (e: Exception) { Toast.makeText(this, "could not ask for screen capture: ${e.message}", Toast.LENGTH_LONG).show(); finish() }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 8) return
        if (resultCode == RESULT_OK && data != null) {
            startForegroundService(Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_START)
                .putExtra(OverlayService.EXTRA_CODE, resultCode).putExtra(OverlayService.EXTRA_DATA, data)
                .putExtra(EXTRA_READ, intent.getBooleanExtra(EXTRA_READ, false)))
        } else Toast.makeText(this, "screen capture not allowed: the read button cannot work", Toast.LENGTH_SHORT).show()
        finish()
        @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
}
