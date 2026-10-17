package com.semanticplayback.firetv

import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackParameters
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONObject

/**
 * Fire OS implementation of the Semantic Playback player protocol on Media3 ExoPlayer.
 * Mirrors apps/fire-tv/web/player.js: load, seek, play, pause, set_rate, play_segment, loop, clear_loop.
 * All methods run on the main thread (ExoPlayer's application looper).
 */
class PlayerController(private val player: ExoPlayer, private val deviceId: String, private val serverBase: String, private val variant: String? = null) {
    var contentId: String? = null
        private set
    private var loopStart = 0L
    private var loopEnd = 0L
    private var loopRemaining = 0
    private var segmentEnd = -1L
    private val handler = Handler(Looper.getMainLooper())
    var onChange: () -> Unit = {}
    /** Fire TV accessibility settings (Audio Description, Closed Captions), read by MainActivity. */
    var accessibility: () -> JSONObject = { JSONObject() }

    /** Closed Captions follow the system setting: the title's caption track is shown only when CC is on. */
    fun applyCaptions(enabled: Boolean) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !enabled)
            .setPreferredTextLanguage("en")
            .build()
    }

    private val enforcer = object : Runnable {
        override fun run() {
            val pos = player.currentPosition
            if (loopRemaining > 0 && pos >= loopEnd) {
                loopRemaining -= 1
                if (loopRemaining > 0) player.seekTo(loopStart) else clearRanges()
                onChange()
            } else if (segmentEnd >= 0 && pos >= segmentEnd) {
                segmentEnd = -1
                player.pause()
                onChange()
            }
            handler.postDelayed(this, 40)
        }
    }

    init {
        handler.post(enforcer)
    }

    private fun clearRanges() {
        loopRemaining = 0
        segmentEnd = -1
    }

    fun state(): JSONObject = JSONObject().apply {
        put("deviceId", deviceId)
        put("deviceKind", "fireos")
        put("contentId", contentId ?: JSONObject.NULL)
        put("positionMs", player.currentPosition)
        put("durationMs", if (player.duration > 0) player.duration else 0)
        put("paused", !player.playWhenReady)
        put("rate", player.playbackParameters.speed.toDouble())
        put("loop", if (loopRemaining > 0) JSONObject().put("startMs", loopStart).put("endMs", loopEnd).put("remaining", loopRemaining) else JSONObject.NULL)
        put("segment", if (segmentEnd >= 0) JSONObject().put("startMs", loopStart).put("endMs", segmentEnd) else JSONObject.NULL)
        put("accessibility", accessibility())
        put("updatedAt", System.currentTimeMillis())
    }

    /** Executes a command; returns null on success or an error message. */
    fun exec(cmd: JSONObject): String? {
        when (cmd.getString("cmd")) {
            "load" -> {
                val id = cmd.getString("contentId")
                if (id != contentId) {
                    contentId = id
                    // Optional lighter rendition (ABR-style) for low-power devices: --es variant 480
                    val url = cmd.getString("url").let { if (it.startsWith("http")) it else serverBase + it }.let { u -> if (variant != null) u + (if ("?" in u) "&" else "?") + "v=" + variant else u }
                    // The title's captions ride along as a side-loaded WebVTT track (shown when CC is on).
                    val captions = MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse("$serverBase/media/$id/captions.vtt"))
                        .setMimeType(MimeTypes.TEXT_VTT).setLanguage("en").setSelectionFlags(C.SELECTION_FLAG_DEFAULT).build()
                    player.setMediaItem(MediaItem.Builder().setUri(url).setSubtitleConfigurations(listOf(captions)).build())
                    player.prepare()
                }
                if (cmd.has("positionMs")) player.seekTo(cmd.getLong("positionMs"))
            }
            "seek" -> { clearRanges(); player.seekTo(cmd.getLong("positionMs")) }
            "play" -> player.play()
            "pause" -> player.pause()
            "set_rate" -> player.playbackParameters = PlaybackParameters(cmd.getDouble("rate").toFloat())
            "play_segment" -> {
                loopRemaining = 0
                loopStart = cmd.getLong("startMs"); segmentEnd = cmd.getLong("endMs")
                player.seekTo(loopStart); player.play()
            }
            "loop" -> {
                segmentEnd = -1
                loopStart = cmd.getLong("startMs"); loopEnd = cmd.getLong("endMs"); loopRemaining = cmd.getInt("count")
                player.seekTo(loopStart); player.play()
            }
            "clear_loop" -> clearRanges()
            "overlay" -> Unit // rendered by MainActivity
            else -> return "unknown command ${cmd.optString("cmd")}"
        }
        return null
    }

    fun release() = handler.removeCallbacks(enforcer)
}
