"""
Compose the demo draft from recorded scenes (scripts/demo-video/record.ts output).

Layout (1920x1080): TV recording (Fire OS app on the device/emulator) left, a pipeline panel on the right
rendered ONLY from each turn's recorded trace (interpreter, MCP tool calls, key result fields, latency),
and a caption strip with what the viewer said. Draft voice: Windows SAPI TTS reads the viewer's line and
the reply (final cut should use Amazon Polly for replies and a human voice for the viewer).

Usage: python scripts/demo-video/compose.py artifacts/demo3 [out.mp4]
"""
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 25
TV_W, TV_H = 1440, 810
PANEL_X = TV_W
SR = 22050
F = lambda size, bold=False: ImageFont.truetype("seguisb.ttf" if bold else "segoeui.ttf", size)
MONO = lambda size: ImageFont.truetype("consola.ttf", size)
BG = (11, 14, 20)
LINE = (36, 48, 73)
MUTED = (139, 151, 173)
TEXT = (230, 235, 245)
ACCENT = (255, 153, 0)
BLUE = (55, 182, 255)
GREEN = (46, 204, 113)
PINK = (244, 114, 182)

src = sys.argv[1] if len(sys.argv) > 1 else "artifacts/demo3"
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(src, "demo-draft.mp4")
manifest = json.load(open(os.path.join(src, "manifest.json"), encoding="utf-8"))

# Which part of each recording to use (seconds into the recording).
TRIM = {"s1-north-star": (13.0, None), "s2-entities": (0.0, None), "s3-spoilers-catchup": (0.0, None)}
SCENE_SUB = {
    "s1-north-star": "The viewer watches goal 1 happen, then talks to the TV.",
    "s2-entities": "Entity-aware playback: identify a player, then navigate by him.",
    "s3-spoilers-catchup": "Spoiler-safe by construction · Catch me up · Viewing Memory.",
}


def fmt(ms):
    s = round(ms / 1000)
    return f"{s // 60}:{s % 60:02d}"


def wrap(d, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def key_fields(step):
    d = step.get("data")
    if not isinstance(d, dict):
        return ""
    if step["kind"] == "tool_call":
        return "  ".join(f"{k}={json.dumps(v) if isinstance(v, (dict, list)) else v}" for k, v in d.items() if v is not None)[:90]
    if d.get("error"):
        return f"error: {d['error']}"[:90]
    if "top" in d:
        if not d["top"]:
            return f"→ 0 results · {d.get('hiddenBySpoilerBoundary', 0)} hidden by spoiler boundary"
        t = d["top"][0]
        return f"→ {t['label']} @ {fmt(t['startMs'])}"
    if d.get("deviceKind"):
        loop = f" · loop ×{d['loop']['remaining']}" if d.get("loop") else ""
        return f"→ {d['deviceKind']} player @ {fmt(d['positionMs'])} · {d['rate']}×{loop}"
    if d.get("entity"):
        return f"→ {d['entity']['name']} #{d['entity'].get('number', '')} · {d.get('provenance', {}).get('source', '')}"
    if d.get("clipId"):
        return f"→ {d['clipId']} · {d.get('renderMs')} ms · {d.get('renderer', '')}"[:90]
    if d.get("deliveredTo"):
        return f"→ {d['deliveredTo']}"[:90]
    if d.get("summary"):
        return f"→ {d['summary']}"[:90]
    if "text" in d:
        return f"→ “{d['text']}” · {d.get('source', '')}"
    if "results" in d:
        return f"→ {len(d['results'])} memories · {d.get('backend', '')}"[:90]
    return ""


def render_panel(turn, reveal):
    """Pipeline panel for one turn; `reveal` = number of steps visible (progressive build)."""
    img = Image.new("RGB", (W - PANEL_X, TV_H), BG)
    d = ImageDraw.Draw(img)
    d.line([(0, 0), (0, TV_H)], fill=LINE, width=2)
    d.text((24, 18), "PIPELINE · real trace", font=F(18, True), fill=MUTED)
    if not turn:
        d.text((24, 60), "Waiting for the viewer…", font=F(20), fill=MUTED)
        return img
    t = turn["turn"]
    y = 56
    d.text((24, y), f"interpreter: {t['interpreter']}", font=F(17), fill=BLUE)
    y += 26
    d.text((24, y), f"end-to-end: {t['durationMs']} ms", font=F(17), fill=BLUE)
    y += 36
    steps = [s for s in t["trace"] if s["kind"] in ("intent", "tool_call", "tool_result", "error", "answer")]
    # Collapse call/result pairs into one row each.
    rows = []
    for s in steps:
        if s["kind"] == "tool_result" and rows and rows[-1]["kind"] == "tool_call" and rows[-1]["label"] == s["label"]:
            rows[-1]["result"] = key_fields(s)
            continue
        if s["kind"] == "intent" and (s["label"].startswith("LLM turn") is False and s["component"] not in ("rules-parser", "router", "deterministic", "context-service")):
            continue
        rows.append(dict(s, result=None))
    colors = {"intent": PINK, "tool_call": ACCENT, "error": (255, 92, 92), "answer": (167, 139, 250)}
    for i, r in enumerate(rows[:reveal]):
        if y > TV_H - 40:
            break
        c = colors.get(r["kind"], MUTED)
        d.ellipse([24, y + 7, 34, y + 17], fill=c)
        if r["kind"] == "tool_call":
            d.text((46, y), f"MCP  {r['label']}", font=F(19, True), fill=TEXT)
            y += 26
            args = key_fields(r)
            if args:
                d.text((46, y), args, font=MONO(14), fill=MUTED)
                y += 20
            if r.get("result"):
                for ln in wrap(d, r["result"], MONO(14), 400)[:2]:
                    d.text((46, y), ln, font=MONO(14), fill=GREEN)
                    y += 20
        else:
            label = r["label"] if r["kind"] != "intent" else f"{r['component']}: {r['label']}"
            for ln in wrap(d, label, F(17, r["kind"] == "answer"), 410)[:3]:
                d.text((46, y), ln, font=F(17, r["kind"] == "answer"), fill=TEXT if r["kind"] == "answer" else MUTED)
                y += 23
        y += 10
    return img


def card(title, lines, sub=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    tw = d.textlength(title, font=F(64, True))
    d.text(((W - tw) / 2, 330 if lines else 470), title, font=F(64, True), fill=TEXT)
    if sub:
        sw = d.textlength(sub, font=F(28))
        d.text(((W - sw) / 2, 420 if lines else 560), sub, font=F(28), fill=ACCENT)
    y = 500
    for ln in lines:
        lw = d.textlength(ln, font=F(26))
        d.text(((W - lw) / 2, y), ln, font=F(26), fill=MUTED)
        y += 42
    return img


ARCH = [
    "Viewer (voice / text / D-pad)  →  Context Envelope (Relevant Core · Ambient · Deep refs)",
    "→  router: rules on structured requests · LLM agent for open-ended ones (bounded, never acts late)",
    "→  self-hosted MCP server (Streamable HTTP, 2025-11-25): player.* · moments.* · lens.* · clip · share · memory",
    "→  Fire OS app (Media3 ExoPlayer + MediaSession) executes and acknowledges every command",
    "Amazon DynamoDB Viewing Memory · Amazon Rekognition (Video shots, labels, text, celebrities) · Amazon Polly · Amazon S3",
    "Synthetic match, provider-style event feed and commentary generated by us — no third-party footage in this cut",
]


def synth(lines, tmp):
    """lines: [(text, voice)] -> list of float32 arrays (Windows SAPI; draft only)."""
    spec = [{"path": os.path.join(tmp, f"v{i}.wav"), "text": t, "voice": v} for i, (t, v) in enumerate(lines)]
    jp = os.path.join(tmp, "v.json")
    json.dump(spec, open(jp, "w", encoding="utf-8"))
    ps = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo({SR}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($l in (Get-Content -Raw -Path '{jp}' | ConvertFrom-Json)) {{ $s.SelectVoice($l.voice); $s.SetOutputToWaveFile($l.path, $fmt); $s.Speak($l.text) }}
$s.SetOutputToNull()
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    out = []
    for sp in spec:
        with wave.open(sp["path"]) as w:
            out.append(np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768)
    return out


def main():
    segments = []  # (kind, payload, duration_s)
    segments.append(("card", card("Video players understand timestamps.", [], "Humans remember moments."), 5.0))
    segments.append(("card", card("Semantic Playback", ["An agentic context layer for Fire TV: talk about what you saw — the TV finds it and acts.",
                                                         "Fire OS app · self-hosted MCP server · Amazon DynamoDB · Rekognition · Polly"], "Fire TV track · AWS Builder"), 5.0))
    for sc in manifest:
        a, b = TRIM.get(sc["id"], (0.0, None))
        segments.append(("card", card(sc["title"], [], SCENE_SUB.get(sc["id"])), 3.0))
        segments.append(("scene", dict(sc, trim=(a, b)), None))
    segments.append(("card", card("As built", ARCH, None), 12.0))
    segments.append(("card", card("Semantic Playback", ["github.com/dusy4/amazon_hackathon"], "Video players understand timestamps. Humans remember moments."), 4.0))

    # Durations for scenes from ffprobe
    for i, (kind, p, dur) in enumerate(segments):
        if kind == "scene":
            full = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", os.path.join(src, p["video"])]).decode().strip())
            a, b = p["trim"]
            segments[i] = (kind, p, (b or full) - a)
    total = sum(s[2] for s in segments)
    print(f"timeline {total:.1f}s")

    with tempfile.TemporaryDirectory() as tmp:
        # ---------------- audio: viewer line (Zira) + reply (David) at the real turn times
        voice_lines, placements = [], []
        t_cursor = 0.0
        for kind, p, dur in segments:
            if kind == "scene":
                a, _ = p["trim"]
                off = p.get("recordingStartOffsetMs", 1200) / 1000
                for tr in p["turns"]:
                    at = t_cursor + tr["atMs"] / 1000 + off - a
                    if at < t_cursor:
                        continue
                    reply = tr["turn"]["speech"]
                    if len(reply) > 140:
                        reply = reply[:reply.rfind(".", 0, 140) + 1] or reply[:140]
                    voice_lines += [(tr["utterance"], "Microsoft Zira Desktop"), (reply, "Microsoft David Desktop")]
                    placements += [at - 1.6, None]
            t_cursor += dur
        clips = synth(voice_lines, tmp)
        audio = np.zeros(int(total * SR) + SR, dtype=np.float32)
        busy_until = 0.0
        for i in range(0, len(clips), 2):
            start = max(placements[i], busy_until)
            for j in (i, i + 1):
                s0 = int(start * SR)
                seg = clips[j][: len(audio) - s0]
                audio[s0:s0 + len(seg)] += seg * 0.9
                start += len(clips[j]) / SR + 0.25
            busy_until = start
        apath = os.path.join(tmp, "a.wav")
        with wave.open(apath, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())

        # ---------------- video
        enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                                "-i", apath, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                                "-shortest", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
        panel_cache = {}
        for kind, p, dur in segments:
            n = int(round(dur * FPS))
            if kind == "card":
                raw = p.tobytes()
                for _ in range(n):
                    enc.stdin.write(raw)
                continue
            a, _ = p["trim"]
            off = p.get("recordingStartOffsetMs", 1200) / 1000
            dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", os.path.join(src, p["video"]), "-t", f"{dur:.3f}",
                                    "-vf", f"fps={FPS},scale={TV_W}:{TV_H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
            fsize = TV_W * TV_H * 3
            for f in range(n):
                buf = dec.stdout.read(fsize)
                if len(buf) < fsize:
                    tv = Image.new("RGB", (TV_W, TV_H), BG)
                else:
                    tv = Image.frombytes("RGB", (TV_W, TV_H), buf)
                rec_t = a + f / FPS - off  # seconds since scene start in recorder clock
                turn, ti = None, -1
                for k, tr in enumerate(p["turns"]):
                    if tr["atMs"] / 1000 <= rec_t:
                        turn, ti = tr, k
                reveal = 0
                if turn:
                    reveal = 1 + int((rec_t - turn["atMs"] / 1000) / 0.35)
                key = (p["id"], ti, min(reveal, 30))
                if key not in panel_cache:
                    panel_cache[key] = render_panel(turn, reveal)
                frame = Image.new("RGB", (W, H), BG)
                frame.paste(tv, (0, 0))
                frame.paste(panel_cache[key], (PANEL_X, 0))
                d = ImageDraw.Draw(frame)
                d.rectangle([0, TV_H, W, H], fill=BG)
                d.line([(0, TV_H), (W, TV_H)], fill=LINE, width=2)
                d.text((28, TV_H + 22), f"Fire OS app · Media3 ExoPlayer · {p['device']['deviceId']}", font=F(18), fill=MUTED)
                if turn and rec_t - turn["atMs"] / 1000 < 6:
                    d.text((28, TV_H + 70), f"Viewer:  “{turn['utterance']}”", font=F(38, True), fill=TEXT)
                    d.text((28, TV_H + 140), "input typed by the demo script in this draft · voices are draft TTS", font=F(16), fill=MUTED)
                enc.stdin.write(frame.tobytes())
            dec.stdout.close()
            dec.wait()
        enc.stdin.close()
        enc.wait()
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
