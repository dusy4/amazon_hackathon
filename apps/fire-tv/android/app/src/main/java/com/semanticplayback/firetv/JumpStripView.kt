package com.semanticplayback.firetv

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import android.view.animation.DecelerateInterpolator
import kotlin.math.abs
import kotlin.math.max

/**
 * The semantic seek made visible: a local timeline around the jump, the position the viewer was at,
 * the grounded moment the agent jumped to, and an animated arc between them.
 * A local window (not the whole title) keeps a 9-second rewind legible in a 13-minute video.
 */
class JumpStripView @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    private val dp = resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x40FFFFFF; strokeWidth = 3 * dp; strokeCap = Paint.Cap.ROUND }
    private val moment = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66FF9900 }
    private val from = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFAAB4C3.toInt(); style = Paint.Style.STROKE; strokeWidth = 2.5f * dp }
    private val to = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFF9900.toInt() }
    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFF9900.toInt(); style = Paint.Style.STROKE; strokeWidth = 2 * dp; strokeCap = Paint.Cap.ROUND }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFAAB4C3.toInt(); textSize = 12 * resources.displayMetrics.scaledDensity }
    private val labelStrong = Paint(label).apply { color = 0xFFEBEBEB.toInt(); typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }

    private var fromMs = 0L
    private var toMs = 0L
    private var momentEndMs = 0L
    private var progress = 1f

    fun show(fromMs: Long, toMs: Long, momentEndMs: Long) {
        this.fromMs = fromMs
        this.toMs = toMs
        this.momentEndMs = momentEndMs
        visibility = VISIBLE
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 650; interpolator = DecelerateInterpolator(1.6f)
            addUpdateListener { progress = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), (58 * dp).toInt())
    }

    private fun fmt(ms: Long): String {
        val s = ms / 1000
        return "%d:%02d".format(s / 60, s % 60)
    }

    override fun onDraw(c: Canvas) {
        val pad = 8 * dp
        val y = 30 * dp
        val w = width - 2 * pad
        // Window: centred on the jump, at least ±30 s, so short rewinds are still visible.
        val lo = minOf(fromMs, toMs)
        val hi = maxOf(fromMs, max(toMs, momentEndMs))
        val span = max(60_000L, ((hi - lo) * 1.6).toLong())
        val start = ((lo + hi) / 2 - span / 2).coerceAtLeast(0)
        fun x(ms: Long) = pad + w * ((ms - start).toFloat() / span)

        c.drawLine(pad, y, pad + w, y, track)
        // The grounded moment as a highlighted range
        if (momentEndMs > toMs) c.drawRoundRect(RectF(x(toMs), y - 5 * dp, x(momentEndMs), y + 5 * dp), 4 * dp, 4 * dp, moment)
        // Arc from where you were to where you meant
        val xf = x(fromMs)
        val xt = x(toMs)
        val xc = xf + (xt - xf) * progress
        val lift = 18 * dp * (1 - abs(0.5f - progress) * 2).coerceAtLeast(0.35f)
        val p = Path().apply { moveTo(xf, y); quadTo((xf + xc) / 2, y - lift, xc, y) }
        c.drawPath(p, arc)
        c.drawCircle(xf, y, 5 * dp, from)
        c.drawCircle(xc, y, 7 * dp, to)
        // Labels: times under the dots
        val fl = fmt(fromMs)
        val tl = fmt(toMs)
        c.drawText(fl, (xf - label.measureText(fl) / 2).coerceIn(0f, width - label.measureText(fl)), y + 22 * dp, label)
        c.drawText(tl, (xt - labelStrong.measureText(tl) / 2).coerceIn(0f, width - labelStrong.measureText(tl)), y + 22 * dp, labelStrong)
    }
}
