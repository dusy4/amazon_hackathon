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

        player = ExoPlayer.Builder(this).build()
        findViewById<PlayerView>(R.id.player_view).player = player
        session = MediaSession.Builder(this, player).build()
        controller = PlayerController(player, deviceId, server)
        controller.onChange = { sendState() }
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onEvents(p: androidx.media3.common.Player, events: androidx.media3.common.Player.Events) = sendState()
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
                setStatus("● player bridge connected · $deviceId")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = JSONObject(text)
                when (msg.optString("type")) {
                    "command" -> main.post { handleCommand(msg.getString("id"), msg.getJSONObject("command")) }
                    "turn" -> main.post { showStatusLine(msg.getJSONObject("turn").optString("interpreter")) }
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

    private fun showStatusLine(interpreter: String) {
        status.text = "● connected · interpreter: $interpreter"
    }

    private fun handleCommand(id: String, cmd: JSONObject) {
        if (cmd.optString("cmd") == "overlay") showOverlay(cmd.getJSONObject("overlay"))
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
            setOnErrorListener { _, _, _ -> true }
            prepareAsync()
        }
    }

    private fun showOverlay(o: JSONObject) {
        speak(o.optString("speech"))
        findViewById<TextView>(R.id.speech).text = o.optString("speech")
        val cards = o.optJSONArray("cards")
        val lines = mutableListOf<String>()
        for (i in 0 until (cards?.length() ?: 0)) {
            val c = cards!!.getJSONObject(i)
            lines += c.optString("title")
            c.optJSONArray("facts")?.let { f -> for (j in 0 until f.length()) lines += "  • ${f.getString(j)}" }
            c.optJSONArray("items")?.let { f -> for (j in 0 until minOf(5, f.length())) lines += "  • " + (f.getJSONObject(j).optString("label").ifEmpty { f.getJSONObject(j).optString("summary") }) }
            c.optJSONObject("share")?.let { lines += "  → ${it.optString("deepLink")}" }
        }
        findViewById<TextView>(R.id.card).text = lines.joinToString("\n")
        val steps = o.optJSONArray("steps")
        findViewById<TextView>(R.id.steps).text = (0 until (steps?.length() ?: 0)).joinToString("  →  ") { steps!!.getString(it) }
        overlay.visibility = View.VISIBLE
        main.removeCallbacksAndMessages(HIDE)
        main.postAtTime({ overlay.visibility = View.GONE }, HIDE, android.os.SystemClock.uptimeMillis() + 12000)
    }

    private fun askDialog() {
        val input = EditText(this).apply { hint = getString(R.string.ask_hint); setSingleLine() }
        AlertDialog.Builder(this)
            .setTitle("Semantic Playback")
            .setView(input)
            .setPositiveButton("Ask") { _, _ ->
                val text = input.text.toString().trim()
                if (text.isNotEmpty()) ws?.send(JSONObject().put("type", "utterance").put("text", text).put("source", "fire-tv-keyboard").toString())
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
