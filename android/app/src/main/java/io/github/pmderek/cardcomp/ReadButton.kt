package io.github.pmderek.cardcomp

import android.animation.TimeAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.graphics.Typeface
import android.os.SystemClock
import android.view.View
import android.view.animation.OvershootInterpolator
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * The floating read button (Derek, 2026-10-29: "make the read button look cool and thoughtfully designed"), drawn by hand:
 * a dark glass disc with a gold ring, a card-shaped viewfinder (corner brackets, 5:7) and a small label.
 *  - IDLE     gold viewfinder with a resting scan line, "READ"
 *  - READING  a scan line sweeps the viewfinder, a gold comet circles the ring, "READING" (a ping on start)
 *  - OFF      the screen capture is gone: red, a play mark, the ring breathes, "START"
 *  - flash    the copied bid, large, "COPIED", for a moment
 * Pressing squishes it to 90%. Animates only while something moves.
 */
class ReadButton(ctx: Context) : View(ctx) {
    enum class Mode { IDLE, READING, OFF }

    var mode = Mode.IDLE
        private set
    private var flashTxt: String? = null
    private var flashLabel = ""
    private var flashAt = 0L
    private var flashUntil = 0L
    private var pingAt = 0L
    private var modeAt = SystemClock.uptimeMillis()

    private val d = resources.displayMetrics.density
    private fun dp(v: Float) = v * d

    private val gold = Color.parseColor("#f5b301")
    private val goldHi = Color.parseColor("#ffd65c")
    private val red = Color.parseColor("#ff6b6b")

    private val halo = Paint(Paint.ANTI_ALIAS_FLAG)
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val gloss = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.WHITE }
    private val comet = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bracket = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val scan = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
    private val trail = Paint(Paint.ANTI_ALIAS_FLAG)
    private val fillP = Paint(Paint.ANTI_ALIAS_FLAG)
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.create("sans-serif-condensed", Typeface.NORMAL), 700, false)
    }
    private val big = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.create("sans-serif", Typeface.NORMAL), 800, false)
    }
    private val pingP = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    private var cx = 0f; private var cy = 0f; private var r = 0f
    private val oval = RectF()
    private val glossOval = RectF()
    private val path = Path()
    private val play = Path()

    private val ticker = TimeAnimator().apply { setTimeListener { _, _, _ -> if (busy()) invalidate() else { invalidate(); end() } } }

    init {
        contentDescription = "read the card on screen"
        isHapticFeedbackEnabled = true
    }

    fun setMode(m: Mode) {
        if (m == mode) return
        mode = m
        modeAt = SystemClock.uptimeMillis()
        if (m == Mode.READING) { pingAt = modeAt; flashTxt = null }
        contentDescription = when (m) { Mode.IDLE -> "read the card on screen"; Mode.READING -> "reading"; Mode.OFF -> "start screen capture" }
        kick()
    }

    /** a short message in place of the icon, e.g. the bid that was just copied */
    fun flash(txt: String, sub: String, ms: Long) {
        flashTxt = txt; flashLabel = sub
        flashAt = SystemClock.uptimeMillis(); flashUntil = flashAt + ms
        kick()
    }

    override fun setPressed(pressed: Boolean) {
        if (pressed == isPressed) return
        super.setPressed(pressed)
        animate().cancel()
        if (pressed) animate().scaleX(0.9f).scaleY(0.9f).setDuration(90).setInterpolator(null).start()
        else animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(3f)).start()
    }

    private fun now() = SystemClock.uptimeMillis()
    private fun busy(): Boolean {
        val t = now()
        return mode != Mode.IDLE || t - pingAt < 500 || t < flashUntil || t - modeAt < 300
    }
    private fun kick() { invalidate(); if (busy() && !ticker.isStarted && isAttachedToWindow) ticker.start() }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); kick() }
    override fun onDetachedFromWindow() { ticker.cancel(); super.onDetachedFromWindow() }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        cx = w / 2f; cy = h / 2f
        r = min(w, h) / 2f - dp(3f)
        halo.shader = RadialGradient(cx, cy + dp(1.2f), r + dp(3f), intArrayOf(0x73000000, 0x73000000, 0x00000000),
            floatArrayOf(0f, r / (r + dp(3f)), 1f), Shader.TileMode.CLAMP)
        disc.shader = RadialGradient(cx - r * 0.35f, cy - r * 0.5f, r * 1.7f, intArrayOf(Color.parseColor("#F22C333C"), Color.parseColor("#F20C0F13")),
            null, Shader.TileMode.CLAMP)
        val rr = r - dp(1f)
        oval.set(cx - rr, cy - rr, cx + rr, cy + rr)
        val g = r - dp(3f)
        glossOval.set(cx - g, cy - g, cx + g, cy + g)
        gloss.strokeWidth = dp(1f)
    }

    override fun onDraw(c: Canvas) {
        val t = now()
        val sec = (t - modeAt) / 1000f
        val accent = if (mode == Mode.OFF) red else gold

        c.drawCircle(cx, cy + dp(1.2f), r + dp(3f), halo)
        c.drawCircle(cx, cy, r, disc)
        if (mode == Mode.READING) { tint.color = Color.argb(46, 245, 179, 1); c.drawCircle(cx, cy, r, tint) }
        if (mode == Mode.OFF) { tint.color = Color.argb(30, 255, 107, 107); c.drawCircle(cx, cy, r, tint) }

        // top gloss
        gloss.alpha = 26
        c.drawArc(glossOval, 205f, 130f, false, gloss)

        // ring
        ring.strokeWidth = dp(1.6f)
        ring.color = accent
        ring.alpha = when (mode) {
            Mode.IDLE -> 255
            Mode.READING -> 70
            Mode.OFF -> (120 + 135 * (0.5f + 0.5f * sin(sec * 2f * PI.toFloat() / 1.6f))).toInt()
        }
        c.drawCircle(cx, cy, r - dp(1f), ring)

        // reading: a comet circling the ring
        if (mode == Mode.READING) {
            val ang = (sec * 330f) % 360f
            c.save(); c.rotate(ang, cx, cy)
            comet.strokeWidth = dp(2.6f)
            comet.shader = SweepGradient(cx, cy, intArrayOf(0x00f5b301, 0x00f5b301, gold, goldHi), floatArrayOf(0f, 0.45f, 0.97f, 1f))
            c.drawArc(oval, 0f, 359f, false, comet)
            dot.color = goldHi
            c.drawCircle(cx + (r - dp(1f)), cy, dp(1.9f), dot)
            c.restore()
        }

        val ft = flashTxt
        if (ft != null && t < flashUntil) {
            drawFlash(c, ft, t)
        } else {
            flashTxt = null
            drawViewfinder(c, accent, sec)
            drawLabel(c, when (mode) { Mode.IDLE -> "READ"; Mode.READING -> "READING"; Mode.OFF -> "START" }, accent)
        }

        // ping when a read starts
        val pp = (t - pingAt) / 500f
        if (pingAt > 0 && pp in 0f..1f) {
            val e = 1f - (1f - pp) * (1f - pp)
            pingP.color = goldHi
            pingP.alpha = (220 * (1f - pp)).toInt()
            pingP.strokeWidth = dp(2.2f) * (1f - pp) + dp(0.4f)
            c.drawCircle(cx, cy, r * (0.35f + 0.6f * e), pingP)
        }
    }

    private fun drawViewfinder(c: Canvas, accent: Int, sec: Float) {
        val h = dp(19f); val w = h * 5f / 7f
        val vx = cx; val vy = cy - dp(4f)
        val l = vx - w / 2; val rt = vx + w / 2; val tp = vy - h / 2; val bt = vy + h / 2
        val k = dp(4.6f)
        path.reset()
        path.moveTo(l, tp + k); path.lineTo(l, tp); path.lineTo(l + k, tp)
        path.moveTo(rt - k, tp); path.lineTo(rt, tp); path.lineTo(rt, tp + k)
        path.moveTo(rt, bt - k); path.lineTo(rt, bt); path.lineTo(rt - k, bt)
        path.moveTo(l + k, bt); path.lineTo(l, bt); path.lineTo(l, bt - k)
        bracket.strokeWidth = dp(2f)
        bracket.color = accent
        bracket.alpha = if (mode == Mode.READING) (200 + 55 * (0.5f + 0.5f * sin(sec * 9f))).toInt() else 255
        c.drawPath(path, bracket)

        val inset = dp(2.6f)
        when (mode) {
            Mode.IDLE -> {
                scan.color = accent; scan.alpha = 120; scan.strokeWidth = dp(1.3f)
                c.drawLine(l + inset, vy, rt - inset, vy, scan)
            }
            Mode.READING -> {
                // ping-pong sweep, with a fading trail behind the line
                val period = 1.05f
                val ph = (sec % period) / period
                val down = ph < 0.5f
                val q = if (down) ph * 2f else (1f - ph) * 2f
                val e = 0.5f - 0.5f * cos(q * PI.toFloat())
                val y = tp + inset + (h - 2 * inset) * e
                val tl = dp(6f)
                val y0 = if (down) y - tl else y + tl
                trail.shader = LinearGradient(0f, y0, 0f, y, 0x00f5b301, Color.argb(110, 245, 179, 1), Shader.TileMode.CLAMP)
                c.save(); c.clipRect(l + dp(1f), tp + dp(1f), rt - dp(1f), bt - dp(1f))
                c.drawRect(l + inset, min(y0, y), rt - inset, maxOf(y0, y), trail)
                c.restore()
                scan.color = goldHi; scan.alpha = 70; scan.strokeWidth = dp(3.4f)
                c.drawLine(l + inset, y, rt - inset, y, scan)
                scan.alpha = 255; scan.strokeWidth = dp(1.4f)
                c.drawLine(l + inset, y, rt - inset, y, scan)
            }
            Mode.OFF -> {
                val s = dp(4.2f)
                play.reset()
                play.moveTo(vx - s * 0.7f, vy - s); play.lineTo(vx + s, vy); play.lineTo(vx - s * 0.7f, vy + s); play.close()
                fillP.color = accent
                c.drawPath(play, fillP)
            }
        }
    }

    private fun drawLabel(c: Canvas, txt: String, accent: Int) {
        label.color = accent
        label.textSize = dp(if (txt.length > 5) 6.5f else 7.8f)
        label.letterSpacing = if (txt.length > 5) 0.05f else 0.2f
        c.drawText(txt, cx + if (txt.length > 5) 0f else dp(0.6f), cy + dp(15.2f), label)
    }

    private fun drawFlash(c: Canvas, txt: String, t: Long) {
        val p = ((t - flashAt) / 260f).coerceIn(0f, 1f)
        val pop = 1f + 0.14f * sin(p * PI.toFloat())
        c.save(); c.scale(pop, pop, cx, cy)
        big.color = goldHi
        var sz = dp(17f)
        big.textSize = sz
        val maxW = r * 1.55f
        while (big.measureText(txt) > maxW && sz > dp(9f)) { sz -= dp(0.5f); big.textSize = sz }
        c.drawText(txt, cx, cy + sz * 0.28f, big)
        label.color = gold; label.textSize = dp(6.6f); label.letterSpacing = 0.18f
        c.drawText(flashLabel.uppercase(), cx + dp(0.5f), cy + dp(15.2f), label)
        c.restore()
    }
}
