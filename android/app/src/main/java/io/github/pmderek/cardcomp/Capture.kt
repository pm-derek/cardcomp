package io.github.pmderek.cardcomp

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Screen capture (MediaProjection) at the screen's own resolution, only when asked.
 * Between reads the virtual display has no surface, so nothing is composited or copied while the stream plays
 * (battery and heat over a long stream). [grab] attaches the ImageReader, takes the second new frame (the first
 * can be a stale buffer), converts it on the capture thread and detaches again.
 * Android 14+: consent is per session (the dialog in MainActivity), the foreground service must already be running
 * with type mediaProjection, and "A single app" in that dialog gives frames of Whatnot alone.
 */
class Capture(private val ctx: Context, private val onStopped: () -> Unit) {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private val main = Handler(Looper.getMainLooper())
    private val thread = HandlerThread("cardcomp-capture").apply { start() }
    private val bg = Handler(thread.looper)
    @Volatile private var pending: ((Bitmap?) -> Unit)? = null
    @Volatile private var seen = 0
    @Volatile private var stopping = false   // release() stops the projection itself: its onStop is not "the system stopped it"
    var width = 0
        private set
    var height = 0
        private set
    val running: Boolean get() = projection != null
    @Volatile var contentVisible = true
        private set
    val busy: Boolean get() = pending != null

    fun start(resultCode: Int, data: Intent, screenW: Int, screenH: Int, dpi: Int): Boolean {
        val mgr = ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = try { mgr.getMediaProjection(resultCode, data) } catch (_: Exception) { null } ?: return false
        width = (screenW / 2) * 2   // full resolution: the card's number needs every pixel
        height = (screenH / 2) * 2
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { val mine = !stopping; release(); if (mine) main.post { onStopped() } }
            // Android 14+, "A single app": false while that app is off screen (another app in front); frames stop then,
            // which is not a lost capture
            override fun onCapturedContentVisibilityChanged(isVisible: Boolean) { contentVisible = isVisible }
        }, main)
        val r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        r.setOnImageAvailableListener({ rd ->
            val img: Image = try { rd.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            val cb = pending
            if (cb == null || ++seen < 2) { img.close(); return@setOnImageAvailableListener }
            pending = null
            val bmp = try { toBitmap(img) } catch (_: Exception) { null }
            img.close()
            detach()
            main.post { cb(bmp) }
        }, bg)
        reader = r
        display = try {
            mp.createVirtualDisplay("cardcomp", width, height, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, bg)
        } catch (_: Exception) { null }
        if (display == null) { r.close(); reader = null; stopping = true; try { mp.stop() } catch (_: Exception) {}; return false }
        projection = mp
        detach()   // idle until the first read
        return true
    }

    private fun detach() { try { display?.surface = null } catch (_: Exception) {} }

    /** The next frame, or null after [timeoutMs]. One at a time: false (and no callback) while a grab is running. */
    fun grab(timeoutMs: Long = 2000, cb: (Bitmap?) -> Unit): Boolean {
        if (projection == null) { cb(null); return true }
        if (pending != null) return false
        seen = 0
        pending = cb
        try { display?.surface = reader?.surface } catch (_: Exception) { pending = null; cb(null); return true }
        main.postDelayed({ if (pending === cb) { pending = null; detach(); cb(null) } }, timeoutMs)
        return true
    }

    fun release() {
        stopping = true
        try { display?.release() } catch (_: Exception) {}
        display = null
        try { reader?.close() } catch (_: Exception) {}
        reader = null
        val mp = projection
        projection = null
        try { mp?.stop() } catch (_: Exception) {}
        pending = null
        thread.quitSafely()
    }

    private fun toBitmap(img: Image): Bitmap {
        val plane = img.planes[0]
        val buf = plane.buffer
        val ps = plane.pixelStride
        val rs = plane.rowStride
        val pad = (rs - ps * img.width) / ps
        val b = Bitmap.createBitmap(img.width + pad, img.height, Bitmap.Config.ARGB_8888)
        b.copyPixelsFromBuffer(buf)
        return if (pad == 0) b else Bitmap.createBitmap(b, 0, 0, img.width, img.height)
    }

    companion object {
        fun jpegDataUrl(b: Bitmap, quality: Int = 85): String {
            val bo = ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.JPEG, quality, bo)
            return "data:image/jpeg;base64," + Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP)
        }
    }
}
