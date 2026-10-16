"""
Launch-style demo film for Semantic Playback (target <= 2:58), rendered from recorded device footage + real traces.

Presentation (AWS/Amazon launch-video conventions):
  - one short caption per beat ("You can now…"-style), product UI carries the story;
  - Fire TV footage large on a Squid Ink canvas; the camera pushes in on the assistant panel when an
    answer arrives and holds until the answer has been spoken in full;
  - audio = the viewer's request (Polly Matthew) then the TV's spoken answer (Polly Ruth), one at a time,
    over a self-synthesised music bed; no narrator;
  - long model waits are cut and labelled with their real duration; everything else is real time;
  - 25 fps end to end (the source footage is 25 fps).

Usage: python scripts/demo-video/launch.py artifacts/launch1 [out.mp4]
"""
import json
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

W, H, FPS, SR = 1920, 1080, 25, 44100
SRC = sys.argv[1] if len(sys.argv) > 1 else "artifacts/launch1"
OUT = sys.argv[2] if len(sys.argv) > 2 else "artifacts/semantic-playback-launch.mp4"
BASE = os.environ.get("SP_BASE", "http://127.0.0.1:8787")
SOCCER = "data/content/yt-soccer-aid-2023/video.mp4"
# One or more recording dirs (comma-separated); a later dir's scene replaces an earlier one with the same id.
MANIFEST = {}
for _d in SRC.split(","):
    for _s in json.load(open(os.path.join(_d, "manifest.json"), encoding="utf-8")):
        _s["dir"] = _d
        MANIFEST[_s["id"]] = _s
SRC = SRC.split(",")[0]

INK, INK_DEEP = (35, 47, 62), (17, 23, 31)
WHITE, BODY, MUTED = (242, 244, 247), (185, 195, 208), (128, 141, 158)
ORANGE = (255, 153, 0)
FONT = {"light": "C:/Windows/Fonts/segoeuil.ttf", "semilight": "C:/Windows/Fonts/segoeuisl.ttf", "regular": "C:/Windows/Fonts/segoeui.ttf",
        "semibold": "C:/Windows/Fonts/seguisb.ttf", "mono": "C:/Windows/Fonts/consola.ttf"}
_f = {}


def font(kind, size):
    if (kind, size) not in _f:
        _f[(kind, size)] = ImageFont.truetype(FONT[kind], size)
    return _f[(kind, size)]


def ease(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def ease_io(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def make_bg():
    y = np.linspace(0, 1, H)[:, None]
    x = np.linspace(0, 1, W)[None, :]
    base = np.array(INK_DEEP)[None, None, :] + (np.array(INK) - np.array(INK_DEEP))[None, None, :] * (1 - y[..., None]) * 0.9
    amber = np.exp(-(((x - 0.1) ** 2) / 0.05 + ((y - 0.0) ** 2) / 0.08))[..., None] * np.array([90, 55, 10]) * 0.32
    blue = np.exp(-(((x - 0.95) ** 2) / 0.06 + ((y - 1.0) ** 2) / 0.10))[..., None] * np.array([0, 70, 95]) * 0.36
    return Image.fromarray(np.clip(base + amber + blue, 0, 255).astype(np.uint8), "RGB")


BG = make_bg()
TV_W, TV_H = 1600, 900
TV_X, TV_Y = (W - TV_W) // 2, 158
TV_MASK = Image.new("L", (TV_W, TV_H), 0)
ImageDraw.Draw(TV_MASK).rounded_rectangle([0, 0, TV_W - 1, TV_H - 1], radius=20, fill=255)


def make_stage():
    img = BG.copy()
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle([TV_X + 12, TV_Y + 24, TV_X + TV_W - 12, TV_Y + TV_H + 18], radius=26, fill=160)
    img.paste(Image.new("RGB", (W, H), (4, 6, 10)), (0, 0), sh.filter(ImageFilter.GaussianBlur(24)))
    ImageDraw.Draw(img).rounded_rectangle([TV_X - 2, TV_Y - 2, TV_X + TV_W + 1, TV_Y + TV_H + 1], radius=22, outline=(70, 82, 98), width=2)
    return img


STAGE = make_stage()


def text_img(lines, width, align="left"):
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    rows, h = [], 0
    for txt, f, col, gap in lines:
        bb = d0.textbbox((0, 0), txt, font=f)
        rows.append((txt, f, col, bb, h))
        h += (bb[3] - bb[1]) + gap + int(f.size * 0.2)
    img = Image.new("RGBA", (width, h + 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for txt, f, col, bb, y in rows:
        x = 0 if align == "left" else (width - (bb[2] - bb[0])) // 2
        d.text((x - bb[0], y - bb[1]), txt, font=f, fill=col + (255,))
    return img


def alpha(img, a):
    if a >= 0.999:
        return img
    r, g, b, al = img.split()
    return Image.merge("RGBA", (r, g, b, al.point(lambda v: int(v * a))))


def put(canvas, layer, xy, a, dy=0.0):
    if a > 0.001:
        canvas.alpha_composite(alpha(layer, a), (int(xy[0]), int(xy[1] + dy)))


def bubble(text):
    f, lab = font("semilight", 30), font("semibold", 17)
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bb = d0.textbbox((0, 0), f"“{text}”", font=f)
    w, h = bb[2] - bb[0] + 56, 84
    img = Image.new("RGBA", (w + 4, h + 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, w, h], radius=24, fill=(255, 255, 255, 255), outline=INK + (128,), width=3)
    d.text((28, 10), "You said", font=lab, fill=(200, 110, 0, 255))
    d.text((28 - bb[0], 34 - bb[1]), f"“{text}”", font=f, fill=INK + (255,))
    return img


def pill(text):
    f = font("semibold", 20)
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bb = d0.textbbox((0, 0), text, font=f)
    w, h = bb[2] - bb[0] + 36, 44
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=22, fill=(17, 23, 31, 225), outline=(255, 153, 0, 160), width=2)
    d.text((18 - bb[0], (h - (bb[3] - bb[1])) // 2 - bb[1]), text, font=f, fill=ORANGE + (255,))
    return img


# ------------------------------------------------------------------ audio
_tts = {}


def tts(text, voice, tmp):
    if (text, voice) in _tts:
        return _tts[(text, voice)]
    mp3 = os.path.join(tmp, f"t{len(_tts)}.mp3")
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
    wav_path = mp3[:-4] + ".wav"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3, "-ac", "1", "-ar", str(SR), wav_path], check=True)
    with wave.open(wav_path) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    _tts[(text, voice)] = a
    return a


def music_bed(seconds):
    """Warm, light-pulse bed: Am-F-C-G pads + soft eighth-note pluck at 100 bpm (synthesised, no rights)."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float32)
    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    chords = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
    bar = 60 / 100 * 4
    for k in range(int(seconds / bar) + 1):
        c = chords[k % 4]
        s0, s1 = int(k * bar * SR), min(n, int((k + 1) * bar * SR + 1.2 * SR))
        if s0 >= n:
            break
        tt = t[s0:s1] - k * bar
        env = np.minimum(1, tt / 0.8) * np.clip((bar + 1.2 - tt) / 1.2, 0, 1)
        sig = sum(np.sin(2 * np.pi * hz(m) * tt) + 0.2 * np.sin(4 * np.pi * hz(m) * tt) for m in c)
        sig += 0.5 * np.sin(2 * np.pi * hz(c[0] - 12) * tt)
        out[s0:s1] += (sig * env * 0.028).astype(np.float32)
        for e in range(8):  # eighth-note pluck on chord tones, an octave up
            p0 = s0 + int(e * bar / 8 * SR)
            p1 = min(n, p0 + int(0.35 * SR))
            if p0 >= n:
                break
            tp = t[p0:p1] - t[p0]
            note = c[(e * 2) % 3] + 12
            out[p0:p1] += (np.sin(2 * np.pi * hz(note) * tp) * np.exp(-tp * 9) * 0.05).astype(np.float32)
    return out


# ------------------------------------------------------------------ segments
class Card:
    def __init__(self, headline, kicker=None, sub=None, dur=3.0, center=False, extra=None, top=False):
        self.headline, self.kicker, self.sub, self.dur, self.center, self.extra, self.top = headline, kicker, sub, dur, center, extra, top

    def prepare(self, tmp):
        lines = []
        if self.kicker:
            lines.append((self.kicker, font("semibold", 28), ORANGE, 16))
        if self.headline:
            lines.append((self.headline, font("light", 88 if len(self.headline) < 34 else 72), WHITE, 20))
        if self.sub:
            lines.append((self.sub, font("semilight", 34), BODY, 0))
        self.layer = text_img(lines, 1600, "center" if self.center else "left")

    def audio(self):
        return []

    def frames(self):
        n = int(round(self.dur * FPS))
        x = (W - 1600) // 2 if self.center else 160
        y = 140 if self.top else (H - self.layer.height) // 2 - 10
        for i in range(n):
            t = i / FPS
            a = ease(t / 0.4) * (1 - ease((t - (self.dur - 0.3)) / 0.3))
            img = BG.copy().convert("RGBA")
            put(img, self.layer, (x, y), a, (1 - ease(t / 0.5)) * 22)
            if self.extra:
                self.extra(img, t, a)
            yield img.convert("RGB")


class ColdOpen:
    def __init__(self, start, dur, lines):
        self.start, self.dur, self.lines = start, dur, lines

    def prepare(self, tmp):
        self.layers = [text_img([(l, font("light", 84), WHITE, 0)], 1700) for l in self.lines]
        g = (np.linspace(0, 1, H)[:, None] ** 1.5 * 210).astype(np.uint8)
        self.shade = Image.fromarray(np.repeat(g, W, 1), "L")

    def audio(self):
        return []

    def frames(self):
        dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{self.start:.3f}", "-i", SOCCER, "-t", f"{self.dur:.3f}",
                                "-vf", f"fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        last = None
        for i in range(int(round(self.dur * FPS))):
            buf = dec.stdout.read(W * H * 3)
            fr = Image.frombytes("RGB", (W, H), buf) if len(buf) == W * H * 3 else last
            last = fr
            t = i / FPS
            img = fr.copy()
            img.paste(Image.new("RGB", (W, H), INK_DEEP), (0, 0), self.shade)
            img = img.convert("RGBA")
            for k, l in enumerate(self.layers):
                t0 = 0.4 + k * 1.6
                put(img, l, (160, 770 + k * 102), ease((t - t0) / 0.5), (1 - ease((t - t0) / 0.6)) * 18)
            fade = min(1, t / 0.5, (self.dur - t) / 0.35)
            yield Image.blend(BG, img.convert("RGB"), max(0, fade))
        dec.stdout.close()
        dec.wait()


def window(scene_id, k, pre=0.8, post=3.0, until_turn=None):
    sc = MANIFEST[scene_id]
    off = sc.get("recordingStartOffsetMs", 1200) / 1000
    at, done = sc["turns"][k]["atMs"] / 1000 + off, sc["turns"][k]["doneMs"] / 1000 + off
    end = (sc["turns"][until_turn]["doneMs"] / 1000 + off + post) if until_turn is not None else done + post
    if done - at > 6:
        return [[max(0.0, at - pre), at + 3.0], [done - 0.8, end]]
    return [[max(0.0, at - pre), end]]


PANEL_C = (0.27, 0.72)  # assistant panel centre in the TV frame (bottom-left, inside the safe zone)


class Beat:
    """A footage beat: caption on top, device in the middle, camera pushes in on each answer."""

    def __init__(self, scene_id, pieces, kicker, headline, zoom=True):
        self.sc = MANIFEST[scene_id]
        self.pieces = pieces
        self.kicker, self.headline, self.zoom = kicker, headline, zoom
        self.off = self.sc.get("recordingStartOffsetMs", 1200) / 1000
        self.video = os.path.join(self.sc["dir"], self.sc["video"])
        self.video_len = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", self.video]).decode())

    def seg_t(self, r):
        acc = 0.0
        for a, b in self.pieces:
            if a <= r <= b:
                return acc + r - a
            acc += b - a
        return None

    def prepare(self, tmp):
        self.caption = text_img([(self.kicker, font("semibold", 24), ORANGE, 8), (self.headline, font("light", 54), WHITE, 0)], 1100)
        self.events, self.voice = [], []
        cursor = 0.0
        for tr in self.sc["turns"]:
            at, done = tr["atMs"] / 1000 + self.off, tr["doneMs"] / 1000 + self.off
            s_at, s_done = self.seg_t(at), self.seg_t(done)
            if s_at is None and s_done is None:
                continue
            if s_at is not None:
                said = tts(tr["utterance"], "Matthew", tmp)
                start = max(cursor + 0.1, s_at - len(said) / SR - 0.1, 0.0)
                self.voice.append((start, said))
                cursor = start + len(said) / SR
                self.events.append((s_at, "ask", bubble(tr["utterance"])))
            if s_done is not None:
                reply = tr["turn"]["speech"]
                sentences = reply.replace("! ", ". ").split(". ")
                spoken = ". ".join(sentences[:3]) if len(reply) > 220 else reply  # whole sentences only
                clip = tts(spoken, "Ruth", tmp)
                start = max(cursor + 0.15, s_done + 0.15)
                self.voice.append((start, clip))
                cursor = start + len(clip) / SR
                self.events.append((s_done, "answer", (start, cursor)))
            for (a1, b1), (a2, _b2) in zip(self.pieces, self.pieces[1:]):
                if at <= b1 <= done:
                    who = "LLM agent" if "openrouter" in tr["turn"]["interpreter"] or "bedrock" in tr["turn"]["interpreter"] else "fallback"
                    self.events.append((self.seg_t(b1) - 0.01, "cut", pill(f"⏩  {done - at:.0f} s {who} turn shortened")))
        # Never cut an answer: extend the last piece (or hold the last frame) until speech has finished.
        need = cursor + 0.9
        have = sum(b - a for a, b in self.pieces)
        self.hold = 0.0
        if need > have:
            last = self.pieces[-1]
            grow = min(need - have, max(0.0, self.video_len - 0.1 - last[1]))
            last[1] += grow
            self.hold = max(0.0, need - have - grow)
        self.dur = sum(b - a for a, b in self.pieces) + self.hold
        self.events.sort(key=lambda e: e[0])
        self.note = text_img([("Fire OS app · Android TV emulator · real time except where marked", font("regular", 18), MUTED, 0)], 900)

    def audio(self):
        return self.voice

    def zoom_at(self, t):
        if not self.zoom:
            return 1.0
        z = 1.0
        for ts, kind, payload in self.events:
            if kind != "answer":
                continue
            _s, e = payload
            k_in = ease_io((t - ts) / 0.7)
            k_out = ease_io((t - (e + 0.6)) / 0.7)
            z = max(z, 1.0 + 0.24 * k_in * (1 - k_out))
        return z

    def frames(self):
        sw, sh = None, None
        last = None
        for a, b in self.pieces:
            dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{a:.3f}", "-i", self.video, "-t", f"{b - a:.3f}", "-vf", f"fps={FPS}",
                                    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
            if sw is None:
                info = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", self.video]).decode().strip().split(",")
                sw, sh = int(info[0]), int(info[1])
            base = self.seg_t(a)
            n = int(round((b - a) * FPS))
            for i in range(n):
                buf = dec.stdout.read(sw * sh * 3)
                src = Image.frombytes("RGB", (sw, sh), buf) if len(buf) == sw * sh * 3 else last
                last = src
                yield self.compose(src, base + i / FPS, i, n, sw, sh)
            dec.stdout.close()
            dec.wait()
        t_end = sum(b - a for a, b in self.pieces)
        for j in range(int(round(self.hold * FPS))):
            yield self.compose(last, t_end + j / FPS, 99, 99, sw, sh)

    def compose(self, src, t, i, n, sw, sh):
        z = self.zoom_at(t)
        cw, ch = sw / z, sh / z
        cx = min(max(sw / 2 + (PANEL_C[0] * sw - sw / 2) * (z - 1) / 0.24, cw / 2), sw - cw / 2)
        cy = min(max(sh / 2 + (PANEL_C[1] * sh - sh / 2) * (z - 1) / 0.24, ch / 2), sh - ch / 2)
        tv = src.crop((int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2))).resize((TV_W, TV_H), Image.BILINEAR)
        img = STAGE.copy()
        img.paste(tv, (TV_X, TV_Y), TV_MASK)
        img = img.convert("RGBA")
        put(img, self.caption, (TV_X, 30), ease(t / 0.45), (1 - ease(t / 0.5)) * 14)
        ask = next((e for e in reversed(self.events) if e[1] == "ask" and e[0] <= t), None)
        if ask and t - ask[0] < 8:
            a_ = ease((t - ask[0]) / 0.35) * (1 - ease((t - ask[0] - 7.4) / 0.5))
            put(img, ask[2], (TV_X + TV_W - ask[2].width, 44), a_, (1 - ease((t - ask[0]) / 0.4)) * 12)
        cut = next((e for e in reversed(self.events) if e[1] == "cut" and e[0] <= t < e[0] + 2.4), None)
        if cut:
            put(img, cut[2], (TV_X + TV_W - cut[2].width - 22, TV_Y + 22), ease((t - cut[0]) / 0.3))
        put(img, self.note, (TV_X + TV_W - 760, H - 24), 0.85)
        frame = img.convert("RGB")
        edge = min(i / FPS, (n - i) / FPS)
        return Image.blend(BG, frame, max(0.0, edge / 0.2)) if edge < 0.2 else frame


def steps_extra(items):
    def draw(img, t, a):
        cw, ch, gap = 380, 320, 36
        x0, y0 = (W - (4 * cw + 3 * gap)) // 2, 470
        for k, (title, body, data) in enumerate(items):
            t0 = 0.9 + k * 0.9
            al = ease((t - t0) / 0.4) * a
            if al <= 0:
                continue
            card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
            d = ImageDraw.Draw(card)
            d.rounded_rectangle([0, 0, cw - 1, ch - 1], radius=22, fill=(255, 255, 255, 14), outline=(255, 255, 255, 40), width=2)
            d.ellipse([26, 26, 72, 72], fill=ORANGE + (255,))
            nb = d.textbbox((0, 0), str(k + 1), font=font("semibold", 26))
            d.text((49 - (nb[2] - nb[0]) / 2 - nb[0], 49 - (nb[3] - nb[1]) / 2 - nb[1]), str(k + 1), font=font("semibold", 26), fill=INK + (255,))
            d.text((26, 96), title, font=font("semibold", 36), fill=WHITE + (255,))
            yy = 152
            for ln in body:
                d.text((26, yy), ln, font=font("semilight", 24), fill=BODY + (255,))
                yy += 32
            yy += 10
            for ln in data:
                d.text((26, yy), ln, font=font("mono", 19), fill=ORANGE + (255,))
                yy += 26
            put(img, card, (x0 + k * (cw + gap), y0), al, (1 - ease((t - t0) / 0.45)) * 22)
    return draw


def arch_extra(img, t, a):
    d = ImageDraw.Draw(img)

    def box(x, y, w, h, title, sub, t0, accent=False):
        al = ease((t - t0) / 0.4) * a
        if al <= 0:
            return
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        dd = ImageDraw.Draw(layer)
        dd.rounded_rectangle([0, 0, w - 1, h - 1], radius=18, fill=(255, 153, 0, 30) if accent else (255, 255, 255, 14),
                             outline=(255, 153, 0, 150) if accent else (255, 255, 255, 46), width=2)
        dd.text((22, 16), title, font=font("semibold", 28), fill=WHITE + (255,))
        if sub:
            dd.text((22, 56), sub, font=font("semilight", 21), fill=BODY + (255,))
        put(img, layer, (x, y), al, (1 - ease((t - t0) / 0.45)) * 14)

    def line(x1, y1, x2, y2, t0):
        al = ease((t - t0) / 0.45) * a
        if al > 0:
            d.line([(x1, y1), (x1 + (x2 - x1) * al, y1 + (y2 - y1) * al)], fill=(255, 153, 0, int(200 * al)), width=3)

    box(140, 430, 400, 100, "Fire TV", "Fire OS app · Media3 ExoPlayer", 0.8)
    box(140, 560, 400, 100, "Phone", "companion · clips & links", 1.0)
    box(650, 360, 620, 100, "Context Envelope", "playhead · active reference · spoiler boundary", 1.5, True)
    box(650, 480, 620, 100, "Router", "deterministic rules · bounded LLM agent", 1.8, True)
    box(650, 600, 620, 100, "Self-hosted MCP server", "Streamable HTTP · spec 2025-11-25 · 20 tools", 2.1, True)
    for k, (n, s) in enumerate([("Amazon Rekognition", "shots · faces · labels · text"), ("Amazon Polly", "every spoken answer"),
                                ("Amazon DynamoDB", "Viewing Memory"), ("Amazon S3", "media for analysis")]):
        box(1380, 330 + k * 110, 400, 94, n, s, 2.6 + k * 0.25)
    line(540, 480, 650, 650, 1.3)
    line(540, 610, 650, 650, 1.4)
    line(1270, 650, 1380, 380, 2.8)
    line(1270, 650, 1380, 600, 3.0)


def main():
    f1, f2, s4 = "f1-football", "f2-spoilers-memory", "s4-real-footage"
    his = MANIFEST[f1]["turns"][2]["turn"]
    top = next((s["data"].get("top") or [{}] for s in his["trace"] if s["kind"] == "tool_result" and s["label"] == "moments.search"), [{}])[0]
    fmt = lambda ms: f"{int(ms // 60000)}:{int(ms // 1000 % 60):02d}"
    explainer = [
        ("Understand", ["“his goal” in context:", "who you just asked about"], ["his → Usain Bolt"]),
        ("Ground", ["Hybrid search over an index", "built with Amazon Rekognition"], ["moments.search", f"→ {top.get('label', '')[:24]}", f"@ {fmt(top.get('startMs', 0))}"]),
        ("Act", ["Deterministic command", "to the Fire TV player"], ["player.seek → player.play"]),
        ("Remember", ["A Viewing Memory event", "for follow-ups and recall"], ["Amazon DynamoDB", "semantic_seek"]),
    ]

    phone = Image.open(os.path.join(SRC, "phone.png")).convert("RGB")
    ph_h = 820
    phone = phone.resize((int(phone.width * ph_h / phone.height), ph_h), Image.LANCZOS)
    pm = Image.new("L", phone.size, 0)
    ImageDraw.Draw(pm).rounded_rectangle([0, 0, phone.width - 1, phone.height - 1], radius=44, fill=255)
    phone_rgba = phone.convert("RGBA")
    phone_rgba.putalpha(pm)

    def phone_extra(img, t, a):
        put(img, phone_rgba, (W - phone.width - 220, 130), a, (1 - ease(t / 0.6)) * 50)

    credits = text_img([("Semantic Playback · Fire TV track · github.com/dusy4/amazon_hackathon", font("regular", 24), BODY, 10),
                        ("Footage: Soccer Aid for UNICEF 2023 highlights (CC BY) · Tears of Steel © Blender Foundation, CC BY 3.0 · Voices: Amazon Polly",
                         font("regular", 20), MUTED, 0)], 1700, "center")

    segs = [
        ColdOpen(141.4, 5.6, ["You remember the moment.", "Your TV only knows the timestamp."]),
        Card("Semantic Playback", kicker="For Fire TV", sub="Talk about what you saw. The TV finds it — and acts.", dur=3.6, center=True),
        Beat(f1, window(f1, 0, pre=5.5, post=2.0), "Viewing Lens", "Ask who's on screen."),
        Beat(f1, window(f1, 1, pre=0.5, post=2.0), "Viewing Lens", "Read anything on screen."),
        Beat(f1, window(f1, 2, pre=0.6, post=8.0), "Conversational references", "Then just say “his goal”."),
        Card("Every request becomes a grounded moment.", kicker="How it works", dur=6.0, top=True, extra=steps_extra(explainer)),
        Beat(f1, window(f1, 3, pre=0.5, post=2.5), "Deterministic follow-ups", "Nudge it: three seconds earlier."),
        Beat(f1, window(f1, 4, pre=0.5, post=9.0, until_turn=5), "Deterministic follow-ups", "Slow it down. Play it twice."),
        Beat(f1, window(f1, 7, pre=0.8, post=2.0), "Clip and share", "Send the moment to your phone."),
        Card("On your phone, instantly.", sub="The real companion page, with the clip from the TV.", dur=3.6, extra=phone_extra),
        Beat(f2, window(f2, 0, pre=0.5, post=1.5), "Spoiler-safe by design", "It never spoils what's ahead."),
        Beat(f2, window(f2, 1, pre=0.5, post=5.0, until_turn=2), "Your call", "Spoilers off — and it plays."),
        Beat(f2, window(f2, 4, pre=0.5, post=1.5), "Catch me up", "Away for a bit? Catch up in seconds."),
        Beat(f2, window(f2, 5, pre=0.5, post=1.5), "Viewing Memory", "It remembers what you asked."),
        Beat(s4, window(s4, 1, pre=0.6, post=2.0), "Beyond sports", "Works on films, too."),
        Beat(s4, window(s4, 2, pre=0.5, post=1.5), "Viewing Lens", "Ask what's happening."),
        Card("Under the hood.", kicker="Architecture", dur=6.5, top=True, extra=arch_extra),
        Card("Video players understand timestamps.", sub="Humans remember moments.", dur=4.6, center=True,
             extra=lambda img, t, a: put(img, credits, ((W - credits.width) // 2, 900), a)),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        for s in segs:
            s.prepare(tmp)
        total = sum(s.dur for s in segs)
        print(f"timeline {total:.1f}s across {len(segs)} segments")
        if total > 179:
            print("WARNING: over 3:00 — shorten beats")

        n = int(total * SR) + SR
        speech = np.zeros(n, dtype=np.float32)
        t0 = 0.0
        for s in segs:
            for at, clip in s.audio():
                i0 = int((t0 + at) * SR)
                c = clip[: max(0, n - i0)]
                speech[i0:i0 + len(c)] += c * 0.95
            t0 += s.dur
        env = np.convolve(np.abs(speech) > 0.02, np.ones(int(0.25 * SR)) / (0.25 * SR), mode="same")
        bed = music_bed(total + 1)[:n] * (1 - 0.6 * np.clip(env * 3, 0, 1))
        fade = np.minimum(1, np.minimum(np.arange(n) / (1.2 * SR), (n - np.arange(n)) / (2.0 * SR)))
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
        for s in segs:
            for fr in s.frames():
                enc.stdin.write(fr.tobytes())
        enc.stdin.close()
        enc.wait()
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
