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
import android.os.Looper
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Screen capture (MediaProjection) into an ImageReader at about 720 px wide. Frames flow all the time while the
 * stream plays; nothing is kept or converted until [grab] asks for one, so the cost between reads is near zero.
 * Android 14+: consent is per session (the dialog in MainActivity), the foreground service must already be
 * running with type mediaProjection, and "A single app" in that dialog gives frames of Whatnot alone.
 */
class Capture(private val ctx: Context, private val onStopped: () -> Unit) {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var pending: ((Bitmap?) -> Unit)? = null
    var width = 0
        private set
    var height = 0
        private set
    val running: Boolean get() = projection != null

    fun start(resultCode: Int, data: Intent, screenW: Int, screenH: Int, dpi: Int): Boolean {
        val mgr = ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = try { mgr.getMediaProjection(resultCode, data) } catch (_: Exception) { null } ?: return false
        val k = if (screenW > 720) 720f / screenW else 1f
        width = ((screenW * k).toInt() / 2) * 2
        height = ((screenH * k).toInt() / 2) * 2
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { release(); onStopped() }
        }, main)
        val r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        r.setOnImageAvailableListener({ rd ->
            val img: Image = try { rd.acquireLatestImage() } catch (_: Exception) { null } ?: return@setOnImageAvailableListener
            val cb = pending
            if (cb == null) { img.close(); return@setOnImageAvailableListener }
            pending = null
            val bmp = try { toBitmap(img) } catch (_: Exception) { null }
            img.close()
            main.post { cb(bmp) }
        }, main)
        reader = r
        display = try {
            mp.createVirtualDisplay("cardcomp", width, height, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, main)
        } catch (_: Exception) { null }
        if (display == null) { r.close(); reader = null; try { mp.stop() } catch (_: Exception) {}; return false }
        projection = mp
        return true
    }

    /** The next frame, or null after [timeoutMs] (a still screen sends no new frame). Called on the main thread. */
    fun grab(timeoutMs: Long = 1500, cb: (Bitmap?) -> Unit) {
        if (projection == null) { cb(null); return }
        pending = cb
        main.postDelayed({ if (pending === cb) { pending = null; cb(null) } }, timeoutMs)
    }

    fun release() {
        try { display?.release() } catch (_: Exception) {}
        display = null
        try { reader?.close() } catch (_: Exception) {}
        reader = null
        val mp = projection
        projection = null
        try { mp?.stop() } catch (_: Exception) {}
        pending = null
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
