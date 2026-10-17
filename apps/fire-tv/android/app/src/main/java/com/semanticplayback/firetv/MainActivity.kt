package com.semanticplayback.firetv

import android.app.AlertDialog
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.ui.PlayerView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Semantic Playback for Fire TV (Fire OS).
 *
 * - Media3 ExoPlayer renders the content; a Media3 MediaSession exposes standard transport
 *   controls to the system (Fire TV MediaSession integration path).
 * - A WebSocket to the Semantic Playback server makes this device a player on the bridge: the agent's
 *   MCP player.* tool calls arrive here as commands and are acknowledged with the resulting state.
 * - MENU on the remote opens a text prompt that sends an utterance (the Fire TV mic button is reserved
 *   for Alexa; the phone/web client is the voice surface in this build).
 */
class MainActivity : AppCompatActivity() {
    private lateinit var player: ExoPlayer
    private var recoveries = 0
    private lateinit var session: MediaSession
    private lateinit var controller: PlayerController
    private lateinit var status: TextView
    private lateinit var overlay: LinearLayout
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private var ws: WebSocket? = null
    private lateinit var server: String
    private val deviceId = "fire-tv-${Build.MODEL.replace(" ", "-").lowercase()}"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        server = intent.getStringExtra("server") ?: BuildConfig.DEFAULT_SERVER
        status = findViewById(R.id.status)
        overlay = findViewById(R.id.overlay)

        // Prefer hardware-accelerated decoders: some images list the software decoder first, which drops
        // 720p playback to a few fps. Fire TV hardware decoders are normally first anyway; this makes it explicit.
        val hwFirst = androidx.media3.exoplayer.mediacodec.MediaCodecSelector { mimeType, secure, tunneling ->
            androidx.media3.exoplayer.mediacodec.MediaCodecUtil.getDecoderInfos(mimeType, secure, tunneling)
                .sortedByDescending { it.hardwareAccelerated }
        }
        val renderers = androidx.media3.exoplayer.DefaultRenderersFactory(this)
            .setMediaCodecSelector(hwFirst)
            .setEnableDecoderFallback(true)
        player = ExoPlayer.Builder(this, renderers).build()
        findViewById<PlayerView>(R.id.player_view).let { pv ->
            pv.player = player
            // Captions centred at the bottom in the TV's own style, not the source's positioned cues.
            pv.subtitleView?.setApplyEmbeddedStyles(false)
            pv.subtitleView?.setBottomPaddingFraction(0.06f)
        }
        session = MediaSession.Builder(this, player).build()
        controller = PlayerController(player, deviceId, server, intent.getStringExtra("variant"))
        // Fire TV accessibility state (developer.amazon.com/docs/fire-tv/implement-reading-and-subscribing-to-adcc.html)
        val captioning = getSystemService(android.content.Context.CAPTIONING_SERVICE) as android.view.accessibility.CaptioningManager
        val adEnabled = { android.provider.Settings.Secure.getInt(contentResolver, "accessibility_audio_descriptions_enabled", 0) == 1 }
        controller.accessibility = { JSONObject().put("audioDescription", adEnabled()).put("captions", captioning.isEnabled) }
        controller.applyCaptions(captioning.isEnabled)
        captioning.addCaptioningChangeListener(object : android.view.accessibility.CaptioningManager.CaptioningChangeListener() {
            override fun onEnabledChanged(enabled: Boolean) { controller.applyCaptions(enabled); sendState() }
        })
        contentResolver.registerContentObserver(
            android.provider.Settings.Secure.getUriFor("accessibility_audio_descriptions_enabled"), false,
            object : android.database.ContentObserver(android.os.Handler(mainLooper)) { override fun onChange(selfChange: Boolean) { sendState() } },
        )
        controller.onChange = { sendState() }
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onEvents(p: androidx.media3.common.Player, events: androidx.media3.common.Player.Events) = sendState()

            // Amazon IVS timed metadata: PutMetadata payloads arrive as ID3 frames inside the HLS segments,
            // exactly at the frame they were inserted. Show it, and tell the agent (it can offer a replay).
            override fun onMetadata(metadata: androidx.media3.common.Metadata) {
                for (i in 0 until metadata.length()) {
                    // ID3 frames (TS segments) or emsg boxes carrying an ID3 tag (fMP4 / low-latency HLS).
                    val text = when (val e = metadata.get(i)) {
                        is androidx.media3.extractor.metadata.id3.TextInformationFrame -> e.values.joinToString("")
                        is androidx.media3.extractor.metadata.id3.PrivFrame -> String(e.privateData)
                        is androidx.media3.extractor.metadata.id3.BinaryFrame -> String(e.data)
                        is androidx.media3.extractor.metadata.emsg.EventMessage -> String(e.messageData)
                        else -> null
                    } ?: continue
                    val start = text.indexOf('{')
                    val end = text.lastIndexOf('}')
                    if (start < 0 || end <= start) continue
                    val cue = runCatching { JSONObject(text.substring(start, end + 1)) }.getOrNull() ?: continue
                    if (!cue.has("title") || !cue.has("src")) continue // IVS's own latency telemetry (ld_lat_data)
                    showLiveBanner(cue)
                    ws?.send(JSONObject().put("type", "live_cue").put("cue", cue).put("positionMs", player.currentPosition).toString())
                }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // Self-heal instead of freezing: an audio-output failure (no audio sink, HDMI/CEC hiccup,
                // emulator without audio) must not stop video playback. Retry once with audio disabled.
                val audioFailure = error.stackTraceToString().contains("AudioRenderer") || error.stackTraceToString().contains("AudioSink")
                setStatus("player error: ${error.errorCodeName}${if (audioFailure) " — retrying without audio" else " — retrying"}")
                val resumeAt = player.currentPosition
                val wasPlaying = player.playWhenReady
                if (audioFailure) {
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                        .setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_AUDIO, true).build()
                }
                if (recoveries++ < 3) {
                    player.prepare()
                    player.seekTo(resumeAt)
                    player.playWhenReady = wasPlaying
                }
                sendState()
            }
        })
        main.post(object : Runnable {
            override fun run() {
                if (player.isPlaying) sendState()
                main.postDelayed(this, 500)
            }
        })
        connect()
    }

    private fun setStatus(text: String) = main.post { status.text = text }

    private fun connect() {
        setStatus("connecting to $server …")
        val wsUrl = server.replaceFirst("http", "ws") + "/ws"
        ws = http.newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "hello").put("role", "player").put("deviceId", deviceId).put("deviceKind", "fireos").toString())
                setStatus("Connected · press ☰ to ask")
                // Quiet UI: the status pill only stays up while something needs attention.
                main.postDelayed({ status.animate().alpha(0f).setDuration(600).start() }, 5000)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = JSONObject(text)
                when (msg.optString("type")) {
                    "command" -> main.post { handleCommand(msg.getString("id"), msg.getJSONObject("command")) }
                    "trace" -> main.post { onTrace(msg.getJSONObject("trace")) }
                    "turn" -> main.post { lastTurn = msg.getJSONObject("turn") }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                setStatus("offline (${t.message}) — retrying")
                main.postDelayed({ connect() }, 2000)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.postDelayed({ connect() }, 2000)
            }
        })
    }

    private var lastTurn: JSONObject? = null
    private val liveSteps = mutableListOf<String>()
    private var pulse: android.animation.ObjectAnimator? = null

    /** Listening → thinking: show what was asked and the tool calls as they happen. */
    private fun onTrace(t: JSONObject) {
        when (t.optString("kind")) {
            "input" -> {
                liveSteps.clear()
                showPanel()
                findViewById<TextView>(R.id.heard).text = t.optString("label")
                findViewById<TextView>(R.id.speech).text = "Thinking…"
                findViewById<TextView>(R.id.card).visibility = View.GONE
                findViewById<View>(R.id.jump).visibility = View.GONE
                findViewById<TextView>(R.id.turn_meta).text = "listening"
                findViewById<TextView>(R.id.steps).text = ""
                setThinking(true)
            }
            "tool_call" -> {
                liveSteps += t.optString("label")
                findViewById<TextView>(R.id.steps).text = liveSteps.joinToString("  →  ")
            }
        }
    }

    private fun setThinking(on: Boolean) {
        val bar = findViewById<View>(R.id.thinking)
        pulse?.cancel()
        if (on) {
            bar.visibility = View.VISIBLE
            pulse = android.animation.ObjectAnimator.ofFloat(bar, "alpha", 0.25f, 1f).apply {
                duration = 700; repeatMode = android.animation.ValueAnimator.REVERSE; repeatCount = android.animation.ValueAnimator.INFINITE; start()
            }
        } else bar.visibility = View.INVISIBLE
    }

    private fun showPanel() {
        overlay.visibility = View.VISIBLE
        overlay.alpha = 1f
        main.removeCallbacksAndMessages(HIDE)
    }

    private fun scheduleHide(ms: Long) {
        main.removeCallbacksAndMessages(HIDE)
        main.postAtTime({ overlay.animate().alpha(0f).setDuration(400).withEndAction { overlay.visibility = View.GONE }.start() }, HIDE, android.os.SystemClock.uptimeMillis() + ms)
    }

    private fun handleCommand(id: String, cmd: JSONObject) {
        if (cmd.optString("cmd") == "overlay") showOverlay(cmd.getJSONObject("overlay"))
        // A new title starts with no active reference: clear the moment pill and any answer on screen.
        if (cmd.optString("cmd") == "load" && cmd.optString("contentId") != controller.contentId) {
            findViewById<View>(R.id.moment_pill).visibility = View.GONE
            overlay.visibility = View.GONE
        }
        val error = try { controller.exec(cmd) } catch (e: Exception) { e.message ?: "error" }
        // Seeks complete asynchronously in ExoPlayer; ack after the position has been applied.
        main.postDelayed({
            val ack = JSONObject().put("type", "ack").put("id", id).put("ok", error == null).put("state", controller.state())
            if (error != null) ack.put("error", error)
            ws?.send(ack.toString())
        }, if (cmd.optString("cmd") in setOf("seek", "loop", "play_segment", "load")) 120L else 0L)
    }

    private fun sendState() {
        ws?.send(JSONObject().put("type", "state").put("state", controller.state()).toString())
    }

    private var voice: MediaPlayer? = null

    /** Spoken reply via the server's Amazon Polly endpoint (same voice as the web TV). */
    private fun speak(text: String) {
        if (text.isBlank()) return
        voice?.release()
        voice = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource("$server/api/tts?text=" + java.net.URLEncoder.encode(text, "UTF-8"))
            setOnPreparedListener { it.start() }
            // Keep the answer on screen until it has been spoken, then a few seconds to read.
            setOnCompletionListener { main.post { scheduleHide(5000) } }
            setOnErrorListener { _, _, _ -> true }
            prepareAsync()
        }
    }

    private val hideLive = Runnable { findViewById<View>(R.id.live_banner).visibility = View.GONE }

    private fun showLiveBanner(cue: JSONObject) {
        val v = findViewById<TextView>(R.id.live_banner)
        val kind = cue.optString("t").replace('_', ' ').uppercase()
        v.text = "●  LIVE  ·  $kind  ·  ${cue.optString("title")}"
        v.visibility = View.VISIBLE
        v.removeCallbacks(hideLive)
        v.postDelayed(hideLive, 7000)
    }

    private fun showOverlay(o: JSONObject) {
        setThinking(false)
        showPanel()
        val speech = o.optString("speech")
        speak(speech)
        findViewById<TextView>(R.id.speech).text = speech
        lastTurn?.optString("utterance")?.takeIf { it.isNotBlank() }?.let { findViewById<TextView>(R.id.heard).text = "“$it”" }

        // Detail lines: only what adds to the spoken answer (10-foot UI: short, low density).
        val cards = o.optJSONArray("cards")
        val lines = mutableListOf<String>()
        var moment: String? = null
        for (i in 0 until (cards?.length() ?: 0)) {
            val c = cards!!.getJSONObject(i)
            when (c.optString("type")) {
                "moment" -> moment = c.optString("title")
                "entity" -> {
                    moment = c.optString("title")
                    c.optJSONArray("facts")?.let { f -> for (j in 0 until minOf(3, f.length())) if (!f.getString(j).startsWith("source")) lines += f.getString(j) }
                }
                "moments" -> {
                    val sel = c.optInt("selected", -1)
                    c.optJSONArray("items")?.let { f ->
                        for (j in 0 until minOf(4, f.length())) lines += (if (j == sel) "▸ " else "   ") + f.getJSONObject(j).optString("label")
                        if (sel >= 0) moment = f.getJSONObject(sel).optString("label")
                    }
                }
                "clip" -> {
                    moment = c.optString("title")
                    c.optJSONObject("share")?.let { lines += "Sent to your phone · ${it.optString("deepLink").substringAfter("://")}" }
                }
            }
        }
        // Never repeat what the answer already says; no raw URLs on a TV.
        lines.removeAll { l -> l.isBlank() || l.contains("://") || l.startsWith("profile") || speech.contains(l.trim().removePrefix("▸").trim(), ignoreCase = true) }
        val card = findViewById<TextView>(R.id.card)
        card.text = lines.joinToString("\n")
        card.visibility = if (lines.isEmpty()) View.GONE else View.VISIBLE

        // How it was done: the real MCP tool chain, interpreter and latency of this turn.
        val steps = o.optJSONArray("steps")
        val chain = (0 until (steps?.length() ?: 0)).joinToString(" → ") { steps!!.getString(it) }
        val meta = lastTurn?.let { t ->
            val ms = t.optLong("durationMs")
            val who = t.optString("interpreter").let { if (it.startsWith("rules")) "deterministic" else "LLM agent" }
            (if (ms >= 1000) "%.1f s".format(ms / 1000.0) else "$ms ms") + " · " + who
        }
        findViewById<TextView>(R.id.steps).text = chain
        findViewById<TextView>(R.id.turn_meta).text = meta ?: ""

        // The semantic seek, visualised: where you were → the moment you meant.
        val jumpView = findViewById<JumpStripView>(R.id.jump)
        val j = o.optJSONObject("jump")
        if (j != null) {
            var momentEnd = j.optLong("toMs")
            for (i in 0 until (cards?.length() ?: 0)) cards!!.getJSONObject(i).let { if (it.optString("type") == "moment") momentEnd = it.optLong("endMs", momentEnd) }
            jumpView.show(j.optLong("fromMs"), j.optLong("toMs"), momentEnd)
        } else jumpView.visibility = View.GONE

        moment?.let {
            findViewById<TextView>(R.id.moment_text).text = it
            findViewById<View>(R.id.moment_pill).visibility = View.VISIBLE
        }
        // Fallback if no audio plays: ~reading time for the full answer (the spoken reply re-schedules on completion).
        scheduleHide(maxOf(9000L, 4000L + speech.length * 70L))
    }

    /** Suggestions per title kind, so the whole experience is reachable with the remote's D-pad alone. */
    private fun suggestions(): List<String> = when {
        controller.contentId?.contains("soccer") == true -> listOf(
            "Who's this?",
            "Show me Usain Bolt's goal",
            "The replay",
            "Half speed",
            "Repeat it twice",
            "Normal speed",
            "Rewind to Robbie Keane's equaliser",
            "I was away for 5 minutes, catch me up",
            "Clip that and send it to my phone",
            "Who was the player I asked about?",
            "Back to live",
        )
        controller.contentId == "harbor-v-northgate" -> listOf(
            "Go back to the replay of the last goal",
            "Three seconds earlier",
            "Half speed",
            "Repeat it twice",
            "Normal speed",
            "Who is number 7?",
            "Show me his shots",
            "The second one",
            "Show every yellow card so far",
            "Read the score",
            "I was away for 2 minutes, catch me up",
            "Clip that and send it to my phone",
            "Who was the player I asked about?",
            "Back to live",
        )
        else -> listOf(
            "Who's this?",
            "What's happening?",
            "Read the text on screen",
            "Go back to the previous scene",
            "Catch me up",
            "Clip that and send it to my phone",
            "Back to live",
        )
    }

    private fun send(text: String, source: String) {
        ws?.send(JSONObject().put("type", "utterance").put("text", text).put("source", source).toString())
    }

    /** MENU: pick a suggested request with the D-pad, or type your own. */
    private fun askDialog() {
        val items = suggestions() + "Type your own…"
        val view = layoutInflater.inflate(R.layout.ask_dialog, null)
        view.findViewById<TextView>(R.id.ask_sub).text = "Choose with ◀ ▲ ▼ ▶ and press Select"
        val dialog = AlertDialog.Builder(this).setView(view).create()
        val list = view.findViewById<android.widget.ListView>(R.id.ask_list)
        list.adapter = android.widget.ArrayAdapter(this, R.layout.menu_item, items)
        list.itemsCanFocus = false
        list.setOnItemClickListener { _, _, which, _ ->
            dialog.dismiss()
            if (which == items.size - 1) typeDialog() else send(items[which], "fire-tv-dpad")
        }
        // Focus highlight follows the D-pad selection.
        list.setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                for (i in 0 until list.childCount) list.getChildAt(i).isActivated = false
                v?.isActivated = true
            }
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        })
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT))
        dialog.show()
        list.requestFocus()
        list.setSelection(0)
    }

    private fun typeDialog() {
        val input = EditText(this).apply { hint = getString(R.string.ask_hint); setSingleLine() }
        AlertDialog.Builder(this)
            .setTitle("Semantic Playback")
            .setView(input)
            .setPositiveButton("Ask") { _, _ ->
                val text = input.text.toString().trim()
                if (text.isNotEmpty()) send(text, "fire-tv-keyboard")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SEARCH) {
            askDialog(); return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        controller.release()
        ws?.close(1000, "bye")
        session.release()
        player.release()
        voice?.release()
        super.onDestroy()
    }

    private companion object {
        val HIDE = Any()
    }
}
