"""
Keynote-style demo film for Semantic Playback, rendered from recorded device footage + real traces.

Design system (Amazon brand + Fire TV 10-foot guidelines):
  - Squid Ink canvas (#232F3E family) with soft amber/blue glows; Amazon Orange (#FF9900) accents only.
  - Light display headlines in sentence case, semibold kickers, one idea per frame, generous white space.
  - The device is the hero: Fire TV footage framed like a product shot.
  - Viewer requests as white speech bubbles with Squid Ink text (Alexa speech-bubble spec).
  - "How it works" lines come only from the recorded trace of that turn (Demo Video truth rule).
  - Restrained motion: 300-500 ms ease-out fades/slides.
Audio: Amazon Polly generative voices (narrator Danielle, viewer Matthew, TV reply Ruth) through the app's
/api/tts, over a soft music bed synthesised here (no third-party music).

Usage: python scripts/demo-video/keynote.py artifacts/keynote2 [out.mp4]
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS, SR = 1920, 1080, 30, 44100
SRC = sys.argv[1] if len(sys.argv) > 1 else "artifacts/keynote2"
OUT = sys.argv[2] if len(sys.argv) > 2 else "artifacts/semantic-playback-keynote.mp4"
BASE = os.environ.get("SP_BASE", "http://127.0.0.1:8787")
SOCCER_MEDIA = "data/content/yt-soccer-aid-2023/video.mp4"
MANIFEST = {s["id"]: s for s in json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))}

# ------------------------------------------------------------------ design tokens
INK, INK_DEEP = (35, 47, 62), (19, 25, 33)
WHITE, BODY, MUTED = (242, 244, 247), (185, 195, 208), (128, 141, 158)
ORANGE, BLUE = (255, 153, 0), (0, 167, 206)
FONT = {
    "light": "C:/Windows/Fonts/segoeuil.ttf",
    "semilight": "C:/Windows/Fonts/segoeuisl.ttf",
    "regular": "C:/Windows/Fonts/segoeui.ttf",
    "semibold": "C:/Windows/Fonts/seguisb.ttf",
    "mono": "C:/Windows/Fonts/consola.ttf",
}
_fonts = {}


def font(kind, size):
    k = (kind, size)
    if k not in _fonts:
        _fonts[k] = ImageFont.truetype(FONT[kind], size)
    return _fonts[k]


def ease(x):  # ease-out cubic
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def background():
    y = np.linspace(0, 1, H)[:, None]
    x = np.linspace(0, 1, W)[None, :]
    base = np.array(INK_DEEP)[None, None, :] * (1 - y[..., None] * 0.0) + (np.array(INK) - np.array(INK_DEEP))[None, None, :] * (1 - y[..., None]) * 0.9
    amber = np.exp(-(((x - 0.12) ** 2) / 0.05 + ((y - 0.05) ** 2) / 0.09))[..., None] * np.array([90, 55, 10]) * 0.30
    blue = np.exp(-(((x - 0.92) ** 2) / 0.06 + ((y - 0.95) ** 2) / 0.10))[..., None] * np.array([0, 70, 95]) * 0.35
    img = np.clip(base + amber + blue, 0, 255).astype(np.uint8)
    return Image.fromarray(img, "RGB")


BG = background()

# Device "product shot" geometry
TV_W, TV_H = 1536, 864
TV_X, TV_Y = (W - TV_W) // 2, 56
TV_MASK = Image.new("L", (TV_W, TV_H), 0)
ImageDraw.Draw(TV_MASK).rounded_rectangle([0, 0, TV_W - 1, TV_H - 1], radius=22, fill=255)


def tv_stage():
    img = BG.copy()
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle([TV_X + 10, TV_Y + 26, TV_X + TV_W - 10, TV_Y + TV_H + 22], radius=28, fill=170)
    sh = sh.filter(ImageFilter.GaussianBlur(26))
    img.paste(Image.new("RGB", (W, H), (5, 8, 12)), (0, 0), sh)
    ImageDraw.Draw(img).rounded_rectangle([TV_X - 2, TV_Y - 2, TV_X + TV_W + 1, TV_Y + TV_H + 1], radius=24, outline=(70, 82, 98), width=2)
    return img


STAGE = tv_stage()


def text_layer(lines, width=W, align="left"):
    """lines: [(text, font, color, gap_after)] -> RGBA image sized to content."""
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    h, rows = 0, []
    for txt, f, col, gap in lines:
        bb = d0.textbbox((0, 0), txt, font=f)
        rows.append((txt, f, col, bb, h))
        h += (bb[3] - bb[1]) + gap + int(f.size * 0.18)
    img = Image.new("RGBA", (width, h + 10), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for txt, f, col, bb, y in rows:
        tw = bb[2] - bb[0]
        x = 0 if align == "left" else (width - tw) // 2
        d.text((x - bb[0], y - bb[1]), txt, font=f, fill=col + (255,))
    return img


def with_alpha(img, a):
    if a >= 0.999:
        return img
    r, g, b, al = img.split()
    al = al.point(lambda v: int(v * a))
    return Image.merge("RGBA", (r, g, b, al))


def paste_fade(canvas, layer, xy, a, dy=0):
    if a <= 0.001:
        return
    canvas.alpha_composite(with_alpha(layer, a), (int(xy[0]), int(xy[1] + dy)))


def bubble(text):
    """Alexa-style speech bubble: white, 50% squid-ink stroke, squid-ink text; small 'You said' label."""
    f = font("semilight", 34)
    lab = font("semibold", 18)
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bb = d0.textbbox((0, 0), f"“{text}”", font=f)
    w, h = bb[2] - bb[0] + 64, 92
    img = Image.new("RGBA", (w + 6, h + 6), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, w, h], radius=26, fill=(255, 255, 255, 255), outline=INK + (128,), width=3)
    d.text((32, 12), "You said", font=lab, fill=(ORANGE[0], 120, 0, 255))
    d.text((32 - bb[0], 38 - bb[1]), f"“{text}”", font=f, fill=INK + (255,))
    return img


def chip(text):
    f = font("mono", 23)
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bb = d0.textbbox((0, 0), text, font=f)
    w, h = bb[2] - bb[0] + 44, 54
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=27, fill=(255, 153, 0, 34), outline=(255, 153, 0, 110), width=2)
    d.text((22 - bb[0], (h - (bb[3] - bb[1])) // 2 - bb[1]), text, font=f, fill=ORANGE + (255,))
    return img


SERVICE = {
    "lens.identify": "Amazon Rekognition", "lens.describe": "Amazon Rekognition", "lens.read_text": "Amazon Rekognition",
    "memory.search": "Amazon DynamoDB", "clip.create": "server-side clip", "share.send": "phone",
}


def how_line(turn):
    tools = [s["label"] for s in turn["trace"] if s["kind"] == "tool_call"]
    svc = next((SERVICE[t] for t in tools if t in SERVICE), None)
    who = "LLM agent" if "openrouter" in turn["interpreter"] or "bedrock" in turn["interpreter"] else "deterministic"
    secs = turn["durationMs"] / 1000
    parts = [" → ".join(tools) or "—", f"{secs:.1f} s" if secs >= 1 else f"{turn['durationMs']} ms", who]
    if svc:
        parts.append(svc)
    return "  ·  ".join(parts)


# ------------------------------------------------------------------ audio
def tts(text, voice, tmp, cache={}):
    key = (text, voice)
    if key in cache:
        return cache[key]
    mp3 = os.path.join(tmp, f"v{len(cache)}.mp3")
    wav_path = mp3[:-4] + ".wav"
    url = f"{BASE}/api/tts?voice={voice}&text={urllib.parse.quote(text[:2900])}"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(mp3, "wb") as f:
                f.write(r.read())
            break
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 * (attempt + 1))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3, "-ac", "1", "-ar", str(SR), wav_path], check=True)
    with wave.open(wav_path) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    cache[key] = a
    return a


def music_bed(seconds):
    """Soft pad: Am-F-C-G, 4 s per chord, additive tones with slow attack/release + sub root."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    chords = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    step = 4.0
    for k in range(int(seconds / step) + 1):
        c = chords[k % 4]
        s0, s1 = int(k * step * SR), min(n, int((k + 1) * step * SR + 1.5 * SR))
        if s0 >= n:
            break
        tt = t[s0:s1] - k * step
        env = np.minimum(1, tt / 1.2) * np.minimum(1, np.maximum(0, (step + 1.5 - tt) / 1.5))
        sig = np.zeros_like(tt)
        for m in c:
            f0 = hz(m)
            for h_, amp in ((1, 1.0), (2, 0.25), (3, 0.08)):
                sig += amp * np.sin(2 * np.pi * f0 * h_ * tt + 0.3 * np.sin(2 * np.pi * 0.2 * tt))
        sig += 0.6 * np.sin(2 * np.pi * hz(c[0] - 12) * tt)
        out[s0:s1] += (sig * env * 0.035).astype(np.float32)
    return out


# ------------------------------------------------------------------ segments
class Card:
    """Full-frame statement: kicker / headline / sub, narrator line."""

    def __init__(self, headline, kicker=None, sub=None, vo=None, min_dur=2.6, center=False, extra=None, top=False):
        self.headline, self.kicker, self.sub, self.vo, self.min_dur, self.center, self.extra = headline, kicker, sub, vo, min_dur, center, extra
        self.top = top  # headline at the top when the frame also carries a diagram

    def prepare(self, tmp):
        self.audio = tts(self.vo, "Danielle", tmp) if self.vo else None
        self.dur = max(self.min_dur, (len(self.audio) / SR + 0.9) if self.audio is not None else 0)
        lines = []
        if self.kicker:
            lines.append((self.kicker, font("semibold", 28), ORANGE, 18))
        lines.append((self.headline, font("light", 92 if len(self.headline) < 34 else 76), WHITE, 22))
        if self.sub:
            lines.append((self.sub, font("semilight", 36), BODY, 0))
        self.layer = text_layer(lines, width=1600, align="center" if self.center else "left")

    def audio_events(self):
        return [(0.35, self.audio)] if self.audio is not None else []

    def frames(self):
        n = int(round(self.dur * FPS))
        x = (W - 1600) // 2 if self.center else 160
        y = 150 if self.top else (H - self.layer.height) // 2 - 10
        for i in range(n):
            t = i / FPS
            a = ease(t / 0.45) * (1 - ease((t - (self.dur - 0.35)) / 0.35))
            img = BG.copy().convert("RGBA")
            paste_fade(img, self.layer, (x, y), a, dy=(1 - ease(t / 0.5)) * 26)
            if self.extra:
                self.extra(img, t, a)
            yield img.convert("RGB")


class Footage:
    """Device footage on the stage, with viewer bubble + how-chip driven by recorded turns."""

    def __init__(self, scene_id, pieces, vo_after=None):
        self.scene = MANIFEST[scene_id]
        self.pieces = pieces  # [(rec_a, rec_b)], recording seconds
        self.off = self.scene.get("recordingStartOffsetMs", 1200) / 1000

    def rec_to_seg(self, r):
        acc = 0.0
        for a, b in self.pieces:
            if a <= r <= b:
                return acc + r - a
            acc += b - a
        return None

    def prepare(self, tmp):
        self.dur = sum(b - a for a, b in self.pieces)
        self.events = []  # (seg_t, kind, payload)
        self.audio = []
        for tr in self.scene["turns"]:
            at, done = tr["atMs"] / 1000 + self.off, tr["doneMs"] / 1000 + self.off
            s_at, s_done = self.rec_to_seg(at), self.rec_to_seg(done)
            if s_at is None and s_done is None:
                continue
            if s_at is not None:
                self.events.append((s_at, "ask", bubble(tr["utterance"])))
                self.audio.append((max(0, s_at - 1.3), tts(tr["utterance"], "Matthew", tmp)))
            if s_done is not None:
                self.events.append((s_done, "how", chip(how_line(tr["turn"]))))
                reply = tr["turn"]["speech"]
                first = reply.split(". ")
                short = ". ".join(first[:2]) if len(reply) > 150 else reply
                self.audio.append((s_done + 0.15, tts(short, "Ruth", tmp)))
            # a cut inside this turn's wait: say so on screen
            for (a1, b1), (a2, b2) in zip(self.pieces, self.pieces[1:]):
                if at <= b1 <= done and a2 <= done + 1:
                    self.events.append((self.rec_to_seg(b1) - 0.01, "cut", chip(f"⏩  {done - at:.0f} s model turn shortened")))
        self.events.sort(key=lambda e: e[0])
        self.note = text_layer([("Fire OS app · Android TV emulator · real-time except where marked", font("regular", 20), MUTED, 0)], width=900)

    def audio_events(self):
        return self.audio

    def frames(self):
        for a, b in self.pieces:
            dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", os.path.join(SRC, self.scene["video"]), "-t", f"{b - a:.3f}",
                                    "-vf", f"fps={FPS},scale={TV_W}:{TV_H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
            n = int(round((b - a) * FPS))
            base_t = self.rec_to_seg(a)
            last = None
            for i in range(n):
                buf = dec.stdout.read(TV_W * TV_H * 3)
                tv = Image.frombytes("RGB", (TV_W, TV_H), buf) if len(buf) == TV_W * TV_H * 3 else (last or Image.new("RGB", (TV_W, TV_H)))
                last = tv
                t = base_t + i / FPS
                img = STAGE.copy()
                img.paste(tv, (TV_X, TV_Y), TV_MASK)
                img = img.convert("RGBA")
                # active bubble / chip: latest of each kind, visible ~6 s
                ask = next((e for e in reversed(self.events) if e[1] == "ask" and e[0] <= t), None)
                how = next((e for e in reversed(self.events) if e[1] in ("how",) and e[0] <= t), None)
                cut = next((e for e in reversed(self.events) if e[1] == "cut" and e[0] <= t < e[0] + 2.4), None)
                y0 = TV_Y + TV_H + 34
                if ask and t - ask[0] < 7.0 and (not how or how[0] < ask[0] or t - ask[0] < 7.0):
                    a_ = ease((t - ask[0]) / 0.4) * (1 - ease((t - ask[0] - 6.4) / 0.6))
                    paste_fade(img, ask[2], (TV_X, y0 - 8), a_, dy=(1 - ease((t - ask[0]) / 0.45)) * 18)
                if how and how[0] >= (ask[0] if ask else -1) and t - how[0] < 6.5:
                    a_ = ease((t - how[0]) / 0.4) * (1 - ease((t - how[0] - 5.9) / 0.6))
                    paste_fade(img, how[2], (TV_X + TV_W - how[2].width, y0 + 12), a_)
                if cut:
                    paste_fade(img, cut[2], (TV_X + TV_W - cut[2].width - 24, TV_Y + 24), ease((t - cut[0]) / 0.3))
                paste_fade(img, self.note, (TV_X, H - 30), 0.9)
                # gentle fade in/out at piece boundaries
                edge = min(i / FPS, (n - i) / FPS)
                frame = img.convert("RGB")
                if edge < 0.2:
                    frame = Image.blend(BG, frame, max(0.0, edge / 0.2))
                yield frame
            dec.stdout.close()
            dec.wait()


class ColdOpen:
    """Full-bleed match footage (the content itself), two lines of copy."""

    def __init__(self, media, start, dur, lines, vo):
        self.media, self.start, self.dur0, self.lines, self.vo = media, start, dur, lines, vo

    def prepare(self, tmp):
        self.audio = tts(self.vo, "Danielle", tmp)
        self.dur = max(self.dur0, len(self.audio) / SR + 1.2)
        self.layers = [text_layer([(l, font("light", 84), WHITE, 0)], width=1700) for l in self.lines]
        grad = np.linspace(0, 1, H)[:, None] ** 1.6 * 200
        self.shade = Image.fromarray(np.repeat(grad, W, 1).astype(np.uint8), "L")

    def audio_events(self):
        return [(0.6, self.audio)]

    def frames(self):
        dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{self.start:.3f}", "-i", self.media, "-t", f"{self.dur:.3f}",
                                "-vf", f"fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        n = int(round(self.dur * FPS))
        last = None
        for i in range(n):
            buf = dec.stdout.read(W * H * 3)
            fr = Image.frombytes("RGB", (W, H), buf) if len(buf) == W * H * 3 else last
            last = fr
            t = i / FPS
            img = fr.copy()
            img.paste(Image.new("RGB", (W, H), INK_DEEP), (0, 0), self.shade)
            img = img.convert("RGBA")
            for k, l in enumerate(self.layers):
                t0 = 0.5 + k * 1.9
                paste_fade(img, l, (160, 760 + k * 104), ease((t - t0) / 0.5), dy=(1 - ease((t - t0) / 0.6)) * 20)
            frame = img.convert("RGB")
            fade = min(1, t / 0.6, (self.dur - t) / 0.4)
            yield Image.blend(BG, frame, max(0, fade))
        dec.stdout.close()
        dec.wait()


def step_cards(img, t, a, items):
    """4-up explainer: numbered cards revealed in sequence, with arrows between."""
    cw, ch, gap = 380, 330, 36
    x0 = (W - (4 * cw + 3 * gap)) // 2
    y0 = 520
    for k, (title, body, data) in enumerate(items):
        t0 = 1.6 + k * 1.15
        al = ease((t - t0) / 0.45) * a
        if al <= 0:
            continue
        card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        d = ImageDraw.Draw(card)
        d.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=22, fill=(255, 255, 255, 14), outline=(255, 255, 255, 40), width=2)
        d.ellipse([28, 28, 76, 76], fill=ORANGE + (255,))
        num = str(k + 1)
        nb = d.textbbox((0, 0), num, font=font("semibold", 28))
        d.text((52 - (nb[2] - nb[0]) / 2 - nb[0], 52 - (nb[3] - nb[1]) / 2 - nb[1]), num, font=font("semibold", 28), fill=INK + (255,))
        d.text((28, 100), title, font=font("semibold", 38), fill=WHITE + (255,))
        yy = 160
        for ln in body:
            d.text((28, yy), ln, font=font("semilight", 25), fill=BODY + (255,))
            yy += 34
        yy += 12
        for ln in data:
            d.text((28, yy), ln, font=font("mono", 20), fill=ORANGE + (255,))
            yy += 28
        paste_fade(img, card, (x0 + k * (cw + gap), y0), al, dy=(1 - ease((t - t0) / 0.5)) * 24)
        if k < 3:
            ImageDraw.Draw(img).text((x0 + k * (cw + gap) + cw + 6, y0 + ch // 2 - 22), "›", font=font("light", 44), fill=MUTED + (int(255 * al),))


def arch_diagram(img, t, a):
    """Architecture build: device + phone → server (envelope, router, MCP) → AWS services."""
    d = ImageDraw.Draw(img)

    def box(x, y, w, h, title, sub, t0, accent=False):
        al = ease((t - t0) / 0.45) * a
        if al <= 0:
            return
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        dd = ImageDraw.Draw(layer)
        dd.rounded_rectangle([0, 0, w - 1, h - 1], radius=18, fill=(255, 153, 0, 30) if accent else (255, 255, 255, 14),
                             outline=(255, 153, 0, 150) if accent else (255, 255, 255, 46), width=2)
        dd.text((22, 16), title, font=font("semibold", 28), fill=WHITE + (255,))
        if sub:
            dd.text((22, 56), sub, font=font("semilight", 21), fill=BODY + (255,))
        paste_fade(img, layer, (x, y), al, dy=(1 - ease((t - t0) / 0.5)) * 16)

    def line(x1, y1, x2, y2, t0):
        al = ease((t - t0) / 0.5) * a
        if al > 0:
            d.line([(x1, y1), (x1 + (x2 - x1) * al, y1 + (y2 - y1) * al)], fill=(255, 153, 0, int(200 * al)), width=3)

    box(140, 430, 400, 100, "Fire TV", "Fire OS app · Media3 ExoPlayer", 1.4)
    box(140, 560, 400, 100, "Phone", "companion · clips & links", 1.6)
    box(650, 360, 620, 100, "Context Envelope", "playhead · active reference · spoiler boundary", 2.3, accent=True)
    box(650, 480, 620, 100, "Router", "deterministic rules · bounded LLM agent", 2.7, accent=True)
    box(650, 600, 620, 100, "Self-hosted MCP server", "Streamable HTTP · spec 2025-11-25 · 17 tools", 3.1, accent=True)
    for k, (n, s) in enumerate([("Amazon Rekognition", "shots · faces · labels · text"), ("Amazon Polly", "every spoken reply"),
                                ("Amazon DynamoDB", "Viewing Memory"), ("Amazon S3", "media for analysis")]):
        box(1380, 330 + k * 110, 400, 94, n, s, 3.8 + k * 0.3)
    line(540, 480, 650, 650, 2.0)
    line(540, 610, 650, 650, 2.1)
    line(1270, 650, 1380, 380, 4.0)
    line(1270, 650, 1380, 600, 4.2)


def win(scene_id, k, pre=0.8, post=4.5, until_turn=None):
    """Recording-time pieces around turn k (or from turn k to turn `until_turn`), long waits cut."""
    sc = MANIFEST[scene_id]
    off = sc.get("recordingStartOffsetMs", 1200) / 1000
    at, done = sc["turns"][k]["atMs"] / 1000 + off, sc["turns"][k]["doneMs"] / 1000 + off
    end = (sc["turns"][until_turn]["doneMs"] / 1000 + off + post) if until_turn is not None else done + post
    if done - at > 6:
        return [(max(0.0, at - pre), at + 3.0), (done - 0.8, end)]
    return [(max(0.0, at - pre), end)]


def main():
    f1 = MANIFEST["f1-football"]
    f2 = MANIFEST["f2-spoilers-memory"]
    turn = lambda sc, k: sc["turns"][k]["turn"]
    his = turn(f1, 1)
    search = next((s["data"] for s in his["trace"] if s["kind"] == "tool_result" and s["label"] == "moments.search"), {})
    top = (search.get("top") or [{}])[0]
    seek = next((s["data"] for s in his["trace"] if s["kind"] == "tool_result" and s["label"] == "player.seek"), {})
    fmt = lambda ms: f"{int(ms // 60000)}:{int(ms // 1000 % 60):02d}"
    explainer = [
        ("Understand", ["“his goal” in context:", "who you just asked about"], ["his → Usain Bolt"]),
        ("Ground", ["Hybrid search over an index", "built with Amazon Rekognition"], [f"moments.search", f"→ {top.get('label', 'Usain Bolt scores')[:22]}", f"@ {fmt(top.get('startMs', 0))}"]),
        ("Act", ["Deterministic command", "to the Fire TV player"], ["player.seek", f"→ {seek.get('deviceKind', 'fireos')} @ {fmt(seek.get('positionMs', 0))}"]),
        ("Remember", ["A Viewing Memory event", "for follow-ups and recall"], ["Amazon DynamoDB", "semantic_seek"]),
    ]

    segments = [
        ColdOpen(SOCCER_MEDIA, 141.4, 6.5, ["You remember the moment.", "Your TV only knows the timestamp."],
                 "You remember the moment. Your TV only knows the timestamp."),
        Card("Semantic Playback", kicker="For Fire TV", sub="Talk about what you saw. The TV finds it — and acts.", center=True,
             vo="Meet Semantic Playback. Talk about what you saw, and Fire TV finds it, and acts."),
        Card("Ask who's on screen.", kicker="Viewing Lens", sub="Live Amazon Rekognition on the exact frame you asked about.", vo="Ask who's on screen."),
        Footage("f1-football", win("f1-football", 0, pre=6.0, post=4.5)),
        Card("Then just refer to it.", kicker="Conversational references", sub="“His goal” resolves to Usain Bolt — then to the exact moment.", vo="Then just refer to it."),
        Footage("f1-football", win("f1-football", 1, post=4.2)),
        Card("Every request becomes a grounded moment.", kicker="How it works", min_dur=9.0, top=True,
             vo="Every request becomes a grounded moment: understood in context, found in an index built with Amazon Rekognition, played on Fire TV, and remembered.",
             extra=lambda img, t, a: step_cards(img, t, a, explainer)),
        Card("Replay it your way.", kicker="Deterministic follow-ups", sub="Half speed, repeat twice — arithmetic on the grounded moment, no model call.", vo="Replay it your way."),
        Footage("f1-football", win("f1-football", 2, pre=0.6, post=6.5, until_turn=3)),
        Card("Share the moment.", kicker="Clip and share", sub="A server-side clip, pushed to your phone with a link back to the match.", vo="Share the moment."),
        Footage("f1-football", win("f1-football", 5, pre=1.0, post=3.2)),
        Card("", min_dur=4.2, extra=None),  # phone beat (filled below)
        Card("Never ahead of you.", kicker="Spoiler-safe by design", sub="Search and recaps stop at the furthest point you've watched.", vo="And it never spoils what's ahead."),
        Footage("f2-spoilers-memory", win("f2-spoilers-memory", 0, pre=0.6, post=4.6)),
        Card("Catch up in seconds.", kicker="Catch me up", sub="The few moments that mattered, from the part you missed.", vo="Catch up in seconds."),
        Footage("f2-spoilers-memory", win("f2-spoilers-memory", 1, pre=0.6, post=6.4)),
        Card("It remembers what you asked.", kicker="Viewing Memory", sub="Every meaningful action is an event in Amazon DynamoDB.", vo="And it remembers what you asked."),
        Footage("f2-spoilers-memory", win("f2-spoilers-memory", 2, pre=0.6, post=4.6)),
        Card("It works on films, too.", kicker="Beyond sports", sub="Tears of Steel — dialogue, scenes and faces, indexed the same way.", vo="It works on films, too."),
        Footage("s4-real-footage", win("s4-real-footage", 1, post=4.4) + win("s4-real-footage", 3, pre=0.6, post=5.6)),
        Card("Under the hood.", kicker="Architecture", min_dur=8.5, top=True,
             vo="Under the hood, a self-hosted MCP server drives the Fire TV player, with Amazon Rekognition, Polly, DynamoDB and S3.",
             extra=arch_diagram),
        Card("Video players understand timestamps.", sub="Humans remember moments.", center=True, min_dur=5.5,
             vo="Video players understand timestamps. Humans remember moments.",
             extra=lambda img, t, a: paste_fade(img, CREDITS, ((W - CREDITS.width) // 2, 900), a)),
    ]

    # Phone beat: the real companion page receiving the clip, slid in beside a statement.
    phone = Image.open(os.path.join(SRC, "phone.png")).convert("RGB")
    ph_h = 820
    phone = phone.resize((int(phone.width * ph_h / phone.height), ph_h), Image.LANCZOS)
    pm = Image.new("L", phone.size, 0)
    ImageDraw.Draw(pm).rounded_rectangle([0, 0, phone.width - 1, phone.height - 1], radius=44, fill=255)
    phone_rgba = phone.convert("RGBA")
    phone_rgba.putalpha(pm)
    phone_copy = text_layer([("On your phone, instantly.", font("light", 72), WHITE, 18),
                             ("The real companion page, with the clip from the TV.", font("semilight", 32), BODY, 0)], width=900)

    def phone_extra(img, t, a):
        paste_fade(img, phone_copy, (160, 430), a, dy=(1 - ease(t / 0.5)) * 20)
        paste_fade(img, phone_rgba, (W - phone.width - 220, 130), a, dy=(1 - ease(t / 0.6)) * 60)

    idx_phone = next(i for i, s in enumerate(segments) if isinstance(s, Card) and s.headline == "" and s.extra is None)
    segments[idx_phone].extra = phone_extra
    segments[idx_phone].vo = "On your phone, instantly."

    with tempfile.TemporaryDirectory() as tmp:
        for s in segments:
            s.prepare(tmp)
        total = sum(s.dur for s in segments)
        print(f"timeline {total:.1f}s across {len(segments)} segments")

        # ---------- audio mix: music bed ducked under speech
        n = int(total * SR) + SR
        speech = np.zeros(n, dtype=np.float32)
        t0 = 0.0
        for s in segments:
            for at, clip in s.audio_events():
                i0 = int((t0 + at) * SR)
                seg = clip[: max(0, n - i0)]
                speech[i0:i0 + len(seg)] += seg * 0.95
            t0 += s.dur
        env = np.convolve(np.abs(speech) > 0.02, np.ones(int(0.25 * SR)) / (0.25 * SR), mode="same")
        duck = 1 - 0.55 * np.clip(env * 3, 0, 1)
        bed = music_bed(total + 1)[:n] * duck
        fade = np.minimum(1, np.minimum(np.arange(n) / (1.5 * SR), (n - np.arange(n)) / (2.5 * SR)))
        mix = np.clip(speech + bed * fade, -1, 1)
        apath = os.path.join(tmp, "mix.wav")
        with wave.open(apath, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((mix * 32767).astype(np.int16).tobytes())

        enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                                "-i", apath, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                                "-shortest", "-movflags", "+faststart", OUT], stdin=subprocess.PIPE)
        for s in segments:
            for fr in s.frames():
                enc.stdin.write(fr.tobytes())
        enc.stdin.close()
        enc.wait()
    print(f"wrote {OUT}")


CREDITS = text_layer([("Semantic Playback · Fire TV track · github.com/dusy4/amazon_hackathon", font("regular", 24), BODY, 10),
                      ("Footage: Soccer Aid for UNICEF 2023 highlights (CC BY) · Tears of Steel © Blender Foundation, CC BY 3.0 · Voices: Amazon Polly",
                       font("regular", 20), MUTED, 0)], width=1700, align="center")

if __name__ == "__main__":
    main()
