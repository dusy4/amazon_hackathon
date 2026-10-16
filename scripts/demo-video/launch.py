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
# The phone screenshot comes from the last recording dir that has one (it must match that take's clip).
PHONE_DIR = next((d for d in reversed(SRC.split(",")) if os.path.exists(os.path.join(d, "phone.png"))), SRC.split(",")[0])
SRC = SRC.split(",")[0]

INK, INK_DEEP = (35, 47, 62), (17, 23, 31)
WHITE, BODY, MUTED = (242, 244, 247), (185, 195, 208), (128, 141, 158)
ORANGE = (255, 153, 0)
CYAN = (0, 167, 206)
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
TV_W, TV_H = 1456, 819
TV_X, TV_Y = (W - TV_W) // 2, 132
SUB_Y = TV_Y + TV_H + 12  # burned-in subtitles live under the TV, never over the picture
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
    f = font("semibold", 24)
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bb = d0.textbbox((0, 0), text, font=f)
    w, h = bb[2] - bb[0] + 40, 52
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=22, fill=(17, 23, 31, 225), outline=(255, 153, 0, 160), width=2)
    d.text((18 - bb[0], (h - (bb[3] - bb[1])) // 2 - bb[1]), text, font=f, fill=ORANGE + (255,))
    return img


def wrap(text, f, width):
    d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d0.textlength(t, font=f) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def subtitle_cards(speaker, text, dur):
    """Split one spoken line into <= 2-line subtitle cards, timed by length across the clip duration."""
    f, tag_f = font("semilight", 37), font("semibold", 22)
    tag, col = ("YOU", ORANGE) if speaker == "you" else ("FIRE TV", CYAN)
    lines = wrap(text, f, 1500)
    chunks = [lines[i:i + 2] for i in range(0, len(lines), 2)]
    total = sum(len(" ".join(c)) for c in chunks) or 1
    out, t = [], 0.0
    for c in chunks:
        d0 = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        tw = int(d0.textlength(tag, font=tag_f)) + 26
        lw = max(int(d0.textlength(l, font=f)) for l in c)
        w, h = tw + lw + 24, 47 * len(c) + 12
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([0, 0, w - 1, h - 1], radius=12, fill=(8, 11, 16, 215))
        d.rounded_rectangle([12, 13, tw - 6, 41], radius=6, fill=col + (255,))
        d.text((12 + (tw - 18 - d0.textlength(tag, font=tag_f)) / 2, 14), tag, font=tag_f, fill=INK_DEEP + (255,))
        for k, l in enumerate(c):
            d.text((tw + 6, 1 + 47 * k), l, font=f, fill=WHITE + (255,))
        span = dur * len(" ".join(c)) / total
        out.append((t, t + span, img))
        t += span
    return out


# ------------------------------------------------------------------ audio
_tts = {}


TTS_CACHE = os.path.join("artifacts", "tts-cache")


def tts(text, voice, tmp):
    """Amazon Polly via the app's /api/tts, cached on disk so re-renders don't need AWS credentials."""
    if (text, voice) in _tts:
        return _tts[(text, voice)]
    import hashlib
    os.makedirs(TTS_CACHE, exist_ok=True)
    mp3 = os.path.join(TTS_CACHE, hashlib.sha1(f"{voice}|{text}".encode()).hexdigest()[:16] + ".mp3")
    if os.path.exists(mp3) and os.path.getsize(mp3) > 0:
        return _decode(mp3, text, voice)
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
    return _decode(mp3, text, voice)


def _decode(mp3, text, voice):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", mp3, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"], check=True, capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
    _tts[(text, voice)] = a
    return a


MUSIC = os.path.join("artifacts", "music", "newer-wave.mp3")  # Kevin MacLeod, "Newer Wave", incompetech.com, CC BY 4.0


def music_track(seconds):
    """Licensed track (stereo) if present, else the synthesised bed duplicated to stereo."""
    n = int(seconds * SR)
    if os.path.exists(MUSIC):
        raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", MUSIC, "-f", "s16le", "-ac", "2", "-ar", str(SR), "-"])
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32).reshape(-1, 2) / 32768
        if len(a) < n:
            a = np.concatenate([a, np.zeros((n - len(a), 2), np.float32)])
        return a[:n] * 0.30
    m = music_bed(seconds)[:n]
    return np.stack([m, m], 1)


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
    def __init__(self, headline, kicker=None, sub=None, dur=3.0, center=False, extra=None, top=False, sub_size=34):
        self.headline, self.kicker, self.sub, self.dur, self.center, self.extra, self.top = headline, kicker, sub, dur, center, extra, top
        self.sub_size = sub_size

    def prepare(self, tmp):
        lines = []
        if self.kicker:
            lines.append((self.kicker, font("semibold", 28), ORANGE, 16))
        if self.headline:
            lines.append((self.headline, font("light", 88 if len(self.headline) < 34 else 72), WHITE, 20))
        if self.sub:
            lines.append((self.sub, font("semilight", self.sub_size), ORANGE if self.sub_size > 40 else BODY, 0))
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


def window(scene_id, k, pre=0.8, post=3.0, until_turn=None, gap_cut=()):
    """gap_cut: turn indices after which idle footage up to the next request is cut (never the footage a request plays)."""
    """Recording-time pieces from turn k (to turn `until_turn`), with every long model wait inside cut out."""
    sc = MANIFEST[scene_id]
    off = sc.get("recordingStartOffsetMs", 1200) / 1000
    last = until_turn if until_turn is not None else k
    turns = sc["turns"][k:last + 1]
    start = max(0.0, turns[0]["atMs"] / 1000 + off - pre)
    if k > 0:  # the previous answer stays on the TV panel ~5 s after it is spoken: don't open a beat on it
        prev_done = sc["turns"][k - 1]["doneMs"] / 1000 + off
        if start < prev_done + 6.0:
            start = max(start, turns[0]["atMs"] / 1000 + off + 0.6)  # the panel has switched to the new request
    end = turns[-1]["doneMs"] / 1000 + off + post
    if last + 1 < len(sc["turns"]):  # stop before the next request appears on the TV (no leaking answers)
        end = min(end, sc["turns"][last + 1]["atMs"] / 1000 + off - 0.3)
    pieces, cur = [], start
    prev_done, prev_i = None, None
    for i, tr in enumerate(turns, start=k):
        at, done = tr["atMs"] / 1000 + off, tr["doneMs"] / 1000 + off
        if prev_i in gap_cut and prev_done is not None and at - prev_done > 1.6:  # idle footage between two requests
            pieces.append([cur, prev_done + 1.0])
            cur = at - 0.05
        if done - at > 5:
            pieces.append([cur, at + 2.5])
            cur = done - 0.8
        prev_done, prev_i = done, i
    pieces.append([cur, end])
    return pieces


PANEL_C = (0.27, 0.72)  # assistant panel centre in the TV frame (bottom-left, inside the safe zone)


class Beat:
    """A footage beat: caption on top, device in the middle, camera pushes in on each answer."""

    def __init__(self, scene_id, pieces, kicker, headline, zoom=False):
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
        self.events, self.voice, self.subs = [], [], []
        cursor = 0.0
        sc_turns = self.sc["turns"]
        nxt = next((t for t in sc_turns if t["atMs"] / 1000 + self.off > self.pieces[-1][1]), None)
        self.limit = (nxt["atMs"] / 1000 + self.off - 0.3) if nxt else self.video_len - 0.1
        for tr in self.sc["turns"]:
            at, done = tr["atMs"] / 1000 + self.off, tr["doneMs"] / 1000 + self.off
            s_at, s_done = self.seg_t(at), self.seg_t(done)
            if s_at is None and 0 <= self.pieces[0][0] - at <= 0.8:  # the beat opens just after the request: still voice it
                s_at = 0.0
            if s_at is None and s_done is None:
                continue
            if s_at is not None:
                said = tts(tr["utterance"], "Matthew", tmp)
                start = max(cursor + 0.1, s_at - len(said) / SR - 0.1, 0.0)
                self.voice.append((start, said))
                cursor = start + len(said) / SR
                self.subs += [(start + a, start + b, img) for a, b, img in subtitle_cards("you", tr["utterance"], len(said) / SR + 0.6)]
            if s_done is not None:
                reply = tr["turn"]["speech"]
                sentences = reply.replace("! ", ". ").split(". ")
                # Long answers: the opening sentence and the latest point, whole sentences only (full text is on the TV panel).
                spoken = (sentences[0].rstrip(".") + ". " + sentences[-1].rstrip(".") + ".") if len(reply) > 160 and len(sentences) > 2 else                     (". ".join(sentences[:2]).rstrip(".") + ".") if len(reply) > 160 else reply
                clip = tts(spoken, "Ruth", tmp)
                start = max(cursor + 0.15, s_done + 0.15)
                self.voice.append((start, clip))
                cursor = start + len(clip) / SR
                self.subs += [(start + a, start + b, img) for a, b, img in subtitle_cards("tv", spoken, len(clip) / SR + 0.4)]
                self.events.append((s_done, "answer", (start, cursor)))
            for (a1, b1), (a2, _b2) in zip(self.pieces, self.pieces[1:]):
                if at <= b1 <= done:
                    tools = {st.get("label") for st in tr["turn"]["trace"] if st.get("kind") == "tool_call"}
                    why = ("AI model thinking" if "openrouter" in tr["turn"]["interpreter"] or "bedrock" in tr["turn"]["interpreter"]
                           else "encoding the clip" if "clip.create" in tools else "Amazon Rekognition" if tools & {"lens.identify", "lens.read_text"} else "waiting")
                    self.events.append((self.seg_t(b1) - 0.01, "cut", pill(f"{done - at:.0f} s wait cut · {why}")))
        # Never cut an answer: extend the last piece (or hold the last frame) until speech has finished.
        need = cursor + 0.9
        have = sum(b - a for a, b in self.pieces)
        self.hold = 0.0
        if need > have:
            last = self.pieces[-1]
            grow = min(need - have, max(0.0, self.limit - last[1]))
            last[1] += grow
            self.hold = max(0.0, need - have - grow)
        self.dur = sum(b - a for a, b in self.pieces) + self.hold
        self.events.sort(key=lambda e: e[0])
        note = "Fire OS app · Android TV emulator · real time except where marked"
        self.note = text_img([(note, font("regular", 22), BODY, 0)], 900)
        self.note_w = int(ImageDraw.Draw(Image.new("RGBA", (1, 1))).textlength(note, font=font("regular", 22)))

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
                yield self.compose(src, base + i / FPS, sw, sh)
            dec.stdout.close()
            dec.wait()
        t_end = sum(b - a for a, b in self.pieces)
        for j in range(int(round(self.hold * FPS))):
            yield self.compose(last, t_end + j / FPS, sw, sh)

    def compose(self, src, t, sw, sh):
        z = self.zoom_at(t)
        cw, ch = sw / z, sh / z
        cx = min(max(sw / 2 + (PANEL_C[0] * sw - sw / 2) * (z - 1) / 0.24, cw / 2), sw - cw / 2)
        cy = min(max(sh / 2 + (PANEL_C[1] * sh - sh / 2) * (z - 1) / 0.24, ch / 2), sh - ch / 2)
        tv = src.crop((int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2))).resize((TV_W, TV_H), Image.BILINEAR)
        img = STAGE.copy()
        img.paste(tv, (TV_X, TV_Y), TV_MASK)
        img = img.convert("RGBA")
        put(img, self.caption, (TV_X, 14), ease(t / 0.45), (1 - ease(t / 0.5)) * 14)
        sub = next((x for x in reversed(self.subs) if x[0] <= t < x[1]), None)
        if sub:
            put(img, sub[2], ((W - sub[2].width) // 2, SUB_Y), min(1.0, (t - sub[0]) / 0.12, (sub[1] - t) / 0.12))
        cut = next((e for e in reversed(self.events) if e[1] == "cut" and e[0] <= t < e[0] + 3.2), None)
        if cut:
            put(img, cut[2], (TV_X + TV_W - cut[2].width - 22, TV_Y + 22), ease((t - cut[0]) / 0.3))
        put(img, self.note, (TV_X + TV_W - self.note_w, 20), 0.85)
        frame = img.convert("RGB")
        edge = min(t, self.dur - t)  # fade only into and out of the beat; cuts inside it are hard cuts
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
        dd.text((22, 14), title, font=font("semibold", 30), fill=WHITE + (255,))
        if sub:
            dd.text((22, 58), sub, font=font("regular", 24), fill=(214, 221, 230, 255))
        put(img, layer, (x, y), al, (1 - ease((t - t0) / 0.45)) * 14)

    def line(x1, y1, x2, y2, t0):
        al = ease((t - t0) / 0.45) * a
        if al > 0:
            d.line([(x1, y1), (x1 + (x2 - x1) * al, y1 + (y2 - y1) * al)], fill=(255, 153, 0, int(200 * al)), width=3)

    box(120, 420, 420, 104, "You ask the TV", "Fire OS app · or the phone", 0.6)
    box(120, 560, 420, 104, "It acts on the TV", "seek · play · slow · clip · share", 0.9)
    box(640, 330, 640, 104, "Context", "what's playing · who you mean · what you've seen", 1.3, True)
    box(640, 450, 640, 104, "Router", "simple asks: instant, no AI model call", 1.6, True)
    box(640, 570, 640, 104, "LLM agent (open-ended asks)", "OpenRouter Nemotron 120B today · Bedrock-ready", 1.9, True)
    box(640, 690, 640, 104, "MCP tool server", "20 tools: search · lens · player · clip · memory", 2.2, True)
    for k, (n, s_) in enumerate([("Amazon Rekognition", "who and what is on screen"), ("Amazon Polly", "every spoken answer"),
                                 ("Amazon DynamoDB", "Viewing Memory"), ("Amazon S3", "media for analysis")]):
        box(1380, 330 + k * 120, 420, 104, n, s_, 2.6 + k * 0.25)
    line(540, 472, 640, 382, 1.1)
    for k in range(3):  # Context → Router → (LLM agent) → MCP tools
        line(960, 434 + k * 120, 960, 450 + k * 120, 1.5 + k * 0.3)
    line(1280, 742, 1380, 382, 2.8)
    line(1280, 742, 1380, 502, 2.9)
    line(1280, 742, 1380, 622, 3.0)
    line(1280, 742, 1380, 742, 3.1)
    line(640, 742, 540, 612, 3.4)
    line(1300, 502, 1330, 502, 2.4)  # simple asks: Router straight to the tools, outside the LLM box
    line(1330, 502, 1330, 742, 2.5)
    line(1330, 742, 1282, 742, 2.6)
    d.text((1338, 600), "no model", font=font("semibold", 20), fill=ORANGE + (int(255 * ease((t - 2.6) / 0.4) * a),))


def main():
    f1, f2, s4, s5 = "f1-football", "f2-spoilers-memory", "s4-real-footage", "s5-any-video"
    his = MANIFEST[f1]["turns"][2]["turn"]
    top = next((s["data"].get("top") or [{}] for s in his["trace"] if s["kind"] == "tool_result" and s["label"] == "moments.search"), [{}])[0]
    # The moment actually grounded (after collapsing repeated descriptions of the same goal), not the raw top hit.
    seek_to = next((st for st in his["trace"] if st["kind"] == "action" and st["label"].startswith("seek")), None)
    grounded = next((st["label"].split("→ ", 1)[1] for st in his["trace"] if st["label"].startswith("same goal, described earlier")), None)
    if grounded and " @ " in grounded:
        lab, at_ = grounded.rsplit(" @ ", 1)
        top = {"label": lab, "startMs": sum(int(x) * m for x, m in zip(at_.split(":"), (60000, 1000)))}
    fmt = lambda ms: f"{int(ms // 60000)}:{int(ms // 1000 % 60):02d}"
    explainer = [
        ("Understand", ["“his goal” in context:", "who you just asked about"], ["his → Usain Bolt"]),
        ("Ground", ["Search an index of the match", "built with Amazon Rekognition"], ["moments.search", f"→ {top.get('label', '')[:30]}", f"@ {fmt(top.get('startMs', 0))}"]),
        ("Act", ["A precise command", "to the Fire TV player"], ["player.seek → player.play"]),
        ("Remember", ["A Viewing Memory event", "for follow-ups and recall"], ["Amazon DynamoDB", "semantic_seek"]),
    ]

    phone = Image.open(os.path.join(PHONE_DIR, "phone.png")).convert("RGB")
    vid_box = (38, 245, 962, 765)  # the clip's <video> element in the 1000x1800 companion screenshot
    ph_h = 820
    phone = phone.resize((int(phone.width * ph_h / phone.height), ph_h), Image.LANCZOS)
    pm = Image.new("L", phone.size, 0)
    ImageDraw.Draw(pm).rounded_rectangle([0, 0, phone.width - 1, phone.height - 1], radius=44, fill=255)
    phone_rgba = phone.convert("RGBA")
    phone_rgba.putalpha(pm)

    # The clip that was actually sent, playing inside the companion page (from its own file, real time).
    clip_rec = next((s_["data"] for tr in MANIFEST[f1]["turns"] for s_ in tr["turn"]["trace"]
                     if s_["kind"] == "tool_result" and s_["label"] == "clip.create"), None)
    clip_path = os.path.join("data", "clips", f"{clip_rec['clipId']}.mp4") if clip_rec else None
    k_ = ph_h / 1800
    vx0, vy0, vx1, vy1 = [int(v * k_) for v in vid_box]
    clip_state = {"proc": None, "last": None}

    def clip_frame(t):
        if not clip_path or not os.path.exists(clip_path) or t < 0.5:
            return None
        if clip_state["proc"] is None:
            clip_state["proc"] = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", "1.5", "-i", clip_path, "-vf", f"fps={FPS},scale={vx1 - vx0}:{vy1 - vy0}",
                                                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        sz = (vx1 - vx0) * (vy1 - vy0) * 3
        buf = clip_state["proc"].stdout.read(sz)
        if len(buf) == sz:
            clip_state["last"] = Image.frombytes("RGB", (vx1 - vx0, vy1 - vy0), buf)
        return clip_state["last"]

    def phone_extra(img, t, a):
        ph = phone_rgba
        fr = clip_frame(t)
        if fr is not None:
            ph = phone_rgba.copy()
            ph.paste(fr, (vx0, vy0))
        put(img, ph, (W - phone.width - 220, 130), a, (1 - ease(t / 0.6)) * 50)

    credits = text_img([("Semantic Playback · Fire TV track · github.com/dusy4/amazon_hackathon", font("regular", 26), WHITE, 12),
                        ("Footage (CC BY): Soccer Aid for UNICEF 2023 · Tears of Steel © Blender Foundation · Maple Kitchen roti recipe · TEDxGeneva", font("regular", 22), BODY, 8),
                        ("Voices: Amazon Polly · Music: “Newer Wave” by Kevin MacLeod (incompetech.com), CC BY 4.0", font("regular", 22), BODY, 0)], 1760, "center")

    segs = [
        ColdOpen(483.0, 7.0, ["You remember the moment.", "Your TV only knows the timestamp."]),
        Card("Semantic Playback", kicker="For Fire TV", sub="Say what you remember. The TV finds the moment — and plays it.", dur=3.4, center=True),
        Beat(f1, window(f1, 0, pre=2.5, post=1.4), "Viewing Lens", "Ask who's on screen."),
        Beat(f1, window(f1, 1, pre=0.3, post=1.4), "Viewing Lens", "Read the scoreboard."),
        Beat(f1, window(f1, 2, pre=0.4, post=30.0), "Conversational references", "Say “his goal”. It plays from the build-up."),
        Card("Every request becomes a grounded moment.", kicker="How it works", dur=6.5, top=True, extra=steps_extra(explainer)),
        Beat(f1, window(f1, 3, pre=0.4, post=1.2, until_turn=4), "Precise follow-ups", "Rewind it in slow motion."),
        Beat(f1, window(f1, 5, pre=0.6, post=2.0), "Clip and share", "Clip it and send it to your phone."),
        Card("On your phone, instantly.", sub="The real companion page, playing the clip the TV just made.", dur=8.0, extra=phone_extra),
        Beat(f2, window(f2, 0, pre=0.5, post=0.6), "Spoiler-safe by design", "Ask for a goal you haven't seen yet…"),
        Beat(f2, window(f2, 1, pre=0.4, post=30.0, until_turn=4, gap_cut=(1,)), "Your call", "…turn spoilers off, and it plays."),
        Beat(f2, window(f2, 6, pre=0.5, post=30.0), "Catch me up", "Away for a bit? Catch up in seconds."),
        Beat(f2, window(f2, 7, pre=0.5, post=1.6), "Viewing Memory", "It remembers what you asked."),
        Beat(s5, window(s5, 0, pre=3.0, post=3.0), "Any video", "A recipe: jump to the step you need."),
        Beat(s5, window(s5, 1, pre=2.5, post=2.0), "Any video", "A talk: jump to the topic."),
        Beat(s4, window(s4, 1, pre=0.6, post=2.5), "Tears of Steel · Blender Foundation", "A film: rewind to a line of dialogue."),
        Card("Under the hood.", kicker="Architecture", dur=8.0, top=True, extra=arch_extra),
        Card("Video players understand timestamps.", sub="Humans remember moments.", dur=5.0, center=True, sub_size=60,
             extra=lambda img, t, a: put(img, credits, ((W - credits.width) // 2, 900), a)),
    ]

    os.makedirs(".tmp", exist_ok=True)
    with tempfile.TemporaryDirectory(dir=".tmp") as tmp:  # C: is nearly full; keep render scratch on the project drive
        for s in segs:
            s.prepare(tmp)
        total = sum(s.dur for s in segs)
        print(f"timeline {total:.1f}s across {len(segs)} segments")
        if total > 178:
            print("WARNING: over 3:00 — shorten beats")
        if os.environ.get("SP_PLAN"):  # dry run: timeline only
            for s in segs:
                print(f"  {s.dur:6.1f}s  {type(s).__name__:8} {getattr(s, 'headline', '')}")
            return

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
        duck = 1 - 0.72 * np.clip(env * 3, 0, 1)  # music sits well under every spoken line
        fade = np.minimum(1, np.minimum(np.arange(n) / (0.6 * SR), (n - np.arange(n)) / (2.5 * SR)))
        bed = music_track(n / SR) * (duck * fade)[:, None]
        mix = np.clip(speech[:, None] + bed, -1, 1)
        apath = os.path.join(tmp, "mix.wav")
        with wave.open(apath, "wb") as w:
            w.setnchannels(2)
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
