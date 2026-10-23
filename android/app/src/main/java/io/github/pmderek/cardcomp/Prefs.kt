package io.github.pmderek.cardcomp

import android.content.Context
import android.content.SharedPreferences

/** App settings. App-private storage (the Android sandbox); keys never leave the phone except to the API they are for. */
class Prefs(ctx: Context) {
    private val p: SharedPreferences = ctx.getSharedPreferences("cardcomp", Context.MODE_PRIVATE)

    var anthropicKey: String
        get() = p.getString("anthropicKey", "") ?: ""
        set(v) = p.edit().putString("anthropicKey", v).apply()

    var ghToken: String
        get() = p.getString("ghToken", "") ?: ""
        set(v) = p.edit().putString("ghToken", v).apply()

    /** haiku / sonnet / opus, set from CardComp's auto line */
    var model: String
        get() = p.getString("model", "sonnet") ?: "sonnet"
        set(v) = p.edit().putString("model", v).apply()

    /** off / manual / auto (phase 0 reads only on a tap, so auto behaves like manual) */
    var mode: String
        get() = p.getString("mode", "manual") ?: "manual"
        set(v) = p.edit().putString("mode", v).apply()

    /** the floating panel's place and width (px); -1 = default (top, full width) */
    var panelX: Int
        get() = p.getInt("panelX", -1)
        set(v) = p.edit().putInt("panelX", v).apply()

    var panelY: Int
        get() = p.getInt("panelY", -1)
        set(v) = p.edit().putInt("panelY", v).apply()

    var panelW: Int
        get() = p.getInt("panelW", -1)
        set(v) = p.edit().putInt("panelW", v).apply()

    var bubbleX: Int
        get() = p.getInt("bubbleX", -1)
        set(v) = p.edit().putInt("bubbleX", v).apply()

    var bubbleY: Int
        get() = p.getInt("bubbleY", -1)
        set(v) = p.edit().putInt("bubbleY", v).apply()
}
