"""
Generate the Semantic Playback narrative demo: "The Keeper's Key", a synthetic, fully owned short film.

v2 "Dataset B — narrative": recurring people, dialogue, signs/on-screen text, repeated objects,
scene transitions, enough structure for entity-aware seek ("the previous scene with Theo").

Outputs (under data/content/<contentId>/):
  story.mp4      - 1280x720 H.264/AAC, keyframe every second
  provider.json  - provider-style metadata: characters, objects, scenes, story beats, on-screen
                   signs and per-scene presence (our renderer is the provider, so it is ground truth)
  dialogue.json  - dialogue lines with speaker + measured start/end times (the TTS source script)

Rights: everything is generated here (drawn shapes, original script, Windows SAPI voices).

Usage: python scripts/demo-media/generate_story.py [--out data/content/keepers-key]
"""
import argparse
import json
import math
import os
import subprocess
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 720
FPS = 25
SR = 22050
CONTENT_ID = "keepers-key"
TITLE = "The Keeper's Key"
TITLE_SECONDS = 5.0
END_SECONDS = 4.0

CHARACTERS = {
    "mara": {"name": "Mara Quinn", "voice": "Microsoft Zira Desktop", "rate": 0, "role": "lighthouse keeper", "appearance": "long brown hair, red scarf, blue coat",
             "aliases": ["Mara", "Quinn", "the keeper", "the lighthouse keeper", "the sister"],
             "description": "Keeper of the Gullrock lighthouse; Theo's older sister.",
             "coat": (46, 94, 140), "hair": (92, 54, 30), "skin": (233, 196, 160), "hat": None},
    "theo": {"name": "Theo Quinn", "voice": "Microsoft David Desktop", "rate": 1, "role": "fisherman", "appearance": "green beanie, orange coat",
             "aliases": ["Theo", "the brother", "the fisherman"],
             "description": "Mara's younger brother, a fisherman at Pier 4.",
             "coat": (196, 120, 40), "hair": (40, 32, 26), "skin": (205, 160, 120), "hat": "beanie"},
    "hale": {"name": "Inspector Ada Hale", "voice": "Microsoft Hazel Desktop", "rate": 0, "role": "harbour inspector", "appearance": "navy inspector's cap with a gold badge, grey hair, dark grey coat",
             "aliases": ["Hale", "Ada Hale", "the inspector", "inspector"],
             "description": "Harbour inspector responsible for the storm warning.",
             "coat": (60, 60, 66), "hair": (150, 150, 150), "skin": (240, 210, 185), "hat": "cap"},
}
OBJECTS = {
    "key": {"name": "brass key", "aliases": ["key", "the key", "keeper's key", "brass key"]},
    "letter": {"name": "letter", "aliases": ["letter", "the note", "note"]},
    "map": {"name": "old map", "aliases": ["map", "the map", "old map"]},
    "lantern": {"name": "lantern", "aliases": ["lantern", "lamp", "the light"]},
}

# Each scene: background, cast (left→right), lines (speaker, text, optional beat), signs, props.
# A beat is (type, description, characterIds, objectIds, overlay) and is anchored to its line.
SCENES = [
    {"title": "Storm warning", "location": "Harbour office", "bg": "office", "cast": ["hale", "mara"],
     "signs": [("HARBOUR MASTER", (90, 70)), ("STORM WARNING - GALE FORCE 9 TONIGHT", (90, 150))],
     "description": "Inspector Hale warns Mara that a gale is coming and the lighthouse must be lit, but the keeper's key is missing.",
     "lines": [
         ("hale", "Mara, the gale arrives tonight. Every ship in the bay will be looking for your light."),
         ("mara", "Then I'll light it. I always do."),
         ("hale", "Not without the keeper's key. The harbour log says it was signed out last week, and never returned.",
          ("revelation", "Hale tells Mara the keeper's key is missing", ["hale", "mara"], ["key"], None)),
         ("mara", "Signed out? Nobody touches that key but me."),
         ("hale", "Find it before dark, or I close the harbour."),
     ]},
    {"title": "The empty drawer", "location": "Lighthouse lamp room", "bg": "interior", "cast": ["mara"],
     "signs": [],
     "description": "Mara searches the lamp room; the key drawer is empty except for an unsigned-looking letter.",
     "lines": [
         ("mara", "Top drawer. It has been in the top drawer for eleven years."),
         ("mara", "Empty. Just a letter.",
          ("discovery", "Mara finds a letter in the empty key drawer", ["mara"], ["letter"], None)),
         ("mara", "Meet me at the north cliff at midnight. Signed, T.",
          ("reading", "Mara reads the letter: meet me at the north cliff at midnight, signed T", ["mara"], ["letter"],
           "letter")),
         ("mara", "T. Of course it's T."),
     ]},
    {"title": "Argument at Pier 4", "location": "The docks", "bg": "docks", "cast": ["theo", "mara"],
     "signs": [("PIER 4", (1040, 120))],
     "description": "Mara confronts Theo at the docks about the missing key; they argue and Theo storms off.",
     "lines": [
         ("mara", "Theo. Where is the keeper's key?"),
         ("theo", "Good evening to you too, sister."),
         ("mara", "Your letter was in the drawer. Signed T. Don't play games with me tonight.",
          ("argument", "Mara accuses Theo of taking the key and they argue", ["mara", "theo"], ["key", "letter"], None)),
         ("theo", "You never listen. Not to me, not to Dad, not to anyone."),
         ("theo", "Midnight. North cliff. Come or don't."),
     ]},
    {"title": "The map", "location": "Lighthouse lamp room", "bg": "interior", "cast": ["mara", "theo"],
     "signs": [],
     "description": "Theo comes to the lighthouse and shows Mara their father's old map with an X on the north cliff.",
     "lines": [
         ("theo", "I didn't steal it. I moved it, the way Dad told me to, before he died."),
         ("mara", "Dad told you? He never told me anything."),
         ("theo", "He drew this. Look. An X on the north cliff.",
          ("discovery", "Theo shows Mara their father's old map with an X on the north cliff", ["theo", "mara"], ["map"],
           "map")),
         ("mara", "Under the old signal post. He always said the light belongs to the cliff."),
         ("theo", "Bring the lantern."),
     ]},
    {"title": "North cliff at midnight", "location": "North cliff", "bg": "cliff", "cast": ["mara", "theo"],
     "signs": [("NORTH CLIFF - DANGER", (840, 300))], "night": True,
     "description": "At midnight Mara and Theo dig under the signal post by lantern light and find the brass key in a tin box.",
     "lines": [
         ("theo", "Hold the lantern lower. There, by the post."),
         ("mara", "Something metal. A tin box."),
         ("mara", "It's the key. The brass key. It was here all along.",
          ("discovery", "Mara finds the brass key in a tin box under the signal post", ["mara", "theo"], ["key", "lantern"],
           None)),
         ("theo", "Dad wanted us to find it together. That's why I wrote the letter.",
          ("revelation", "Theo admits he wrote the letter so they would find the key together", ["theo", "mara"],
           ["letter", "key"], None)),
     ]},
    {"title": "Hale returns", "location": "Below the lighthouse", "bg": "exterior", "cast": ["hale", "mara", "theo"],
     "signs": [], "night": True,
     "description": "Inspector Hale arrives as the storm builds; Mara shows her the key.",
     "lines": [
         ("hale", "It's almost one. I was about to close the harbour."),
         ("mara", "No need. We have the key."),
         ("hale", "We? Theo Quinn, I thought you'd left for good."),
         ("theo", "Not tonight, Inspector."),
     ]},
    {"title": "The light", "location": "Lighthouse lamp room", "bg": "interior", "cast": ["mara", "theo", "hale"],
     "signs": [], "night": True, "lamp_lit_from_line": 1,
     "description": "Mara turns the key and the lighthouse lamp comes on; the ships in the bay can see the light.",
     "lines": [
         ("mara", "Eleven years. Same key, same lock."),
         ("theo", "Turn it.",
          ("climax", "Mara turns the brass key and the lighthouse lamp is lit", ["mara", "theo"], ["key"], None)),
         ("hale", "There. Every ship in the bay can see it now."),
         ("mara", "Thank you, Theo."),
     ]},
]

F_TITLE = ImageFont.truetype("georgiab.ttf", 72) if os.path.exists("C:/Windows/Fonts/georgiab.ttf") else ImageFont.truetype("arialbd.ttf", 72)
F_SUB = ImageFont.truetype("arial.ttf", 24)
F_SIGN = ImageFont.truetype("arialbd.ttf", 30)
F_NOTE = ImageFont.truetype("segoepr.ttf", 34) if os.path.exists("C:/Windows/Fonts/segoepr.ttf") else ImageFont.truetype("ariali.ttf", 34)
F_SMALL = ImageFont.truetype("arialbd.ttf", 22)


# ------------------------------------------------------------------------------------- audio
def synth_lines(tmp):
    jobs = []
    for si, sc in enumerate(SCENES):
        for li, line in enumerate(sc["lines"]):
            ch = CHARACTERS[line[0]]
            jobs.append({"path": os.path.join(tmp, f"s{si}_{li}.wav"), "text": line[1], "voice": ch["voice"], "rate": ch["rate"]})
    jpath = os.path.join(tmp, "lines.json")
    with open(jpath, "w", encoding="utf-8") as f:
        json.dump(jobs, f)
    ps = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo({SR}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$lines = Get-Content -Raw -Path '{jpath}' | ConvertFrom-Json
foreach ($l in $lines) {{ try {{ $s.SelectVoice($l.voice) }} catch {{}}; $s.Rate = $l.rate; $s.SetOutputToWaveFile($l.path, $fmt); $s.Speak($l.text) }}
$s.SetOutputToNull()
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    out = {}
    for j in jobs:
        with wave.open(j["path"]) as w:
            out[j["path"]] = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return [[out[os.path.join(tmp, f"s{si}_{li}.wav")] for li in range(len(sc["lines"]))] for si, sc in enumerate(SCENES)]


def ambience(n, timeline):
    r = np.random.default_rng(11)
    noise = r.standard_normal(n).astype(np.float32)
    sea = np.convolve(noise, np.ones(40, dtype=np.float32) / 40, mode="same")
    sea /= np.max(np.abs(sea)) + 1e-9
    t = np.arange(n) / SR
    swell = 0.5 + 0.5 * np.sin(2 * math.pi * t / 7.0)
    env = np.full(n, 0.035, dtype=np.float32)
    for sc in timeline["scenes"]:
        a, b = int(sc["start"] * SR), int(sc["end"] * SR)
        level = {"docks": 0.09, "cliff": 0.12, "exterior": 0.1}.get(sc["bg"], 0.03)
        env[a:b] = level
    return sea * env * (0.6 + 0.4 * swell)


# ------------------------------------------------------------------------------------- timeline
def build_timeline(voices):
    t = TITLE_SECONDS
    scenes, lines, beats = [], [], []
    for si, (sc, vs) in enumerate(zip(SCENES, voices)):
        start = t
        t += 1.6  # establishing beat before the first line
        for li, (line, v) in enumerate(zip(sc["lines"], vs)):
            dur = len(v) / SR
            ln = {"scene": si, "idx": li, "speaker": line[0], "text": line[1], "start": t, "end": t + dur, "audio": v}
            lines.append(ln)
            if len(line) > 2:
                btype, desc, chars, objs, overlay = line[2]
                beats.append({"scene": si, "type": btype, "description": desc, "characters": chars, "objects": objs,
                              "start": max(start, t - 1.5), "end": t + dur + 1.0, "overlay": overlay, "line": ln})
            t += dur + 0.55
        t += 1.4
        scenes.append({**sc, "idx": si, "start": start, "end": t})
    return {"scenes": scenes, "lines": lines, "beats": beats, "duration": t + END_SECONDS}


# ------------------------------------------------------------------------------------- drawing
def sky(d, top, bottom, h=H):
    for y in range(h):
        u = y / h
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] * (1 - u) + bottom[i] * u) for i in range(3)))


def draw_sign(d, text, xy, board=(240, 232, 210), ink=(30, 30, 30)):
    x, y = xy
    tw = d.textlength(text, font=F_SIGN)
    d.rectangle([x - 14, y - 10, x + tw + 14, y + 44], fill=board, outline=(60, 50, 40), width=3)
    d.text((x, y), text, font=F_SIGN, fill=ink)


def background(bg, night, lamp_on):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    if bg == "office":
        d.rectangle([0, 0, W, H], fill=(196, 182, 156))
        d.rectangle([0, 520, W, H], fill=(120, 92, 64))
        d.rectangle([820, 90, 1180, 330], fill=(150, 190, 215), outline=(90, 70, 50), width=10)  # window
        d.rectangle([380, 420, 900, 540], fill=(110, 76, 48))  # desk
    elif bg == "interior":
        d.rectangle([0, 0, W, H], fill=(70, 70, 82) if night else (128, 124, 120))
        for y in range(0, 520, 46):  # stone courses
            off = 40 if (y // 46) % 2 else 0
            for x in range(-off, W, 120):
                d.rectangle([x, y, x + 116, y + 42], outline=(90, 88, 96) if night else (150, 146, 140), width=2)
        d.rectangle([0, 520, W, H], fill=(60, 50, 44))
        d.ellipse([500, 40, 780, 300], fill=(255, 236, 150) if lamp_on else (90, 96, 110), outline=(40, 40, 40), width=8)  # lamp lens
        d.rectangle([1040, 300, 1220, 520], fill=(100, 70, 44), outline=(50, 34, 20), width=4)  # drawer cabinet
        for k in range(3):
            d.rectangle([1056, 316 + k * 66, 1204, 370 + k * 66], outline=(50, 34, 20), width=3)
    elif bg == "docks":
        sky(d, (140, 170, 200), (220, 200, 170), 330)
        d.rectangle([0, 330, W, 470], fill=(46, 92, 120))
        d.rectangle([0, 470, W, H], fill=(116, 84, 56))
        for x in range(0, W, 64):
            d.line([(x, 470), (x, H)], fill=(90, 64, 42), width=3)
        d.polygon([(860, 380), (1120, 380), (1080, 430), (900, 430)], fill=(170, 40, 40))  # boat
        d.line([(990, 380), (990, 250)], fill=(60, 50, 40), width=6)
    elif bg in ("cliff", "exterior"):
        sky(d, (12, 16, 40), (36, 40, 80)) if night else sky(d, (120, 150, 200), (240, 190, 140))
        rr = np.random.default_rng(5)
        for _ in range(90):
            x, y = int(rr.integers(0, W)), int(rr.integers(0, 380))
            d.point((x, y), fill=(230, 230, 255))
        d.rectangle([0, 470, W, H], fill=(30, 60, 90))  # sea
        if bg == "cliff":
            d.polygon([(0, 420), (900, 440), (1000, H), (0, H)], fill=(40, 70, 40))
            d.rectangle([700, 330, 720, 480], fill=(110, 90, 70))  # old signal post
        else:
            d.polygon([(0, 520), (W, 540), (W, H), (0, H)], fill=(60, 64, 60))
            d.polygon([(940, 520), (1060, 520), (1035, 120), (965, 120)], fill=(236, 236, 230))
            for k in range(4):
                d.rectangle([958 + k * 2, 180 + k * 90, 1042 - k * 2, 210 + k * 90], fill=(200, 50, 50))
            d.rectangle([955, 80, 1045, 125], fill=(255, 236, 150) if lamp_on else (70, 76, 90))
    return img


def draw_person(d, cid, x, base_y, t, speaking):
    c = CHARACTERS[cid]
    bob = math.sin(t * 2.2 + x) * 3 + (math.sin(t * 9) * 2 if speaking else 0)
    y = base_y + bob
    d.rounded_rectangle([x - 52, y - 170, x + 52, y + 40], radius=28, fill=c["coat"], outline=(20, 20, 20), width=3)
    d.ellipse([x - 40, y - 262, x + 40, y - 178], fill=c["skin"], outline=(20, 20, 20), width=3)
    if cid == "mara":
        d.chord([x - 46, y - 270, x + 46, y - 190], 180, 360, fill=c["hair"])
        d.rectangle([x - 46, y - 232, x - 34, y - 150], fill=c["hair"])
        d.rectangle([x + 34, y - 232, x + 46, y - 150], fill=c["hair"])
        d.rectangle([x - 50, y - 176, x + 50, y - 158], fill=(170, 40, 60))  # red scarf
    elif c["hat"] == "beanie":
        d.chord([x - 44, y - 276, x + 44, y - 200], 180, 360, fill=(40, 110, 70))
        d.rectangle([x - 44, y - 240, x + 44, y - 226], fill=(30, 90, 56))
    elif c["hat"] == "cap":
        d.rectangle([x - 42, y - 280, x + 42, y - 246], fill=(24, 30, 54))
        d.rectangle([x - 54, y - 250, x + 30, y - 240], fill=(16, 20, 36))
        d.ellipse([x - 8, y - 274, x + 8, y - 258], fill=(220, 190, 60))
    d.ellipse([x - 20, y - 236, x - 8, y - 224], fill=(25, 25, 25))
    d.ellipse([x + 8, y - 236, x + 20, y - 224], fill=(25, 25, 25))
    mouth_open = speaking and (int(t * 8) % 2 == 0)
    if mouth_open:
        d.ellipse([x - 10, y - 208, x + 10, y - 192], fill=(90, 30, 30))
    else:
        d.line([(x - 12, y - 200), (x + 12, y - 200)], fill=(90, 30, 30), width=3)


def overlay_letter(img):
    d = ImageDraw.Draw(img)
    d.rectangle([300, 150, 980, 520], fill=(244, 236, 214), outline=(120, 100, 70), width=4)
    d.text((340, 210), "Meet me at the north cliff", font=F_NOTE, fill=(40, 30, 80))
    d.text((340, 270), "at midnight.", font=F_NOTE, fill=(40, 30, 80))
    d.text((700, 410), "- T.", font=F_NOTE, fill=(40, 30, 80))


def overlay_map(img):
    d = ImageDraw.Draw(img)
    d.rectangle([260, 110, 1020, 560], fill=(226, 204, 150), outline=(120, 90, 50), width=6)
    d.polygon([(300, 520), (420, 300), (560, 260), (700, 330), (980, 250), (980, 520)], fill=(196, 176, 120), outline=(110, 84, 50))
    d.text((300, 140), "GULLROCK BAY", font=F_SIGN, fill=(80, 50, 30))
    d.text((760, 200), "NORTH CLIFF", font=F_SMALL, fill=(80, 50, 30))
    d.line([(820, 270), (860, 310)], fill=(170, 20, 20), width=8)
    d.line([(860, 270), (820, 310)], fill=(170, 20, 20), width=8)
    d.text((330, 470), "the light belongs to the cliff", font=F_SMALL, fill=(80, 50, 30))


def render_frame(t, tl, cache):
    dur = tl["duration"]
    if t < TITLE_SECONDS or t >= dur - END_SECONDS:
        img = Image.new("RGB", (W, H), (8, 10, 20))
        d = ImageDraw.Draw(img)
        if t < TITLE_SECONDS:
            a = min(1, t / 1.2, (TITLE_SECONDS - t) / 0.8)
            col = tuple(int(c * a) for c in (240, 220, 160))
            d.text((W / 2, 300), TITLE.upper(), font=F_TITLE, fill=col, anchor="mm")
            d.text((W / 2, 390), "A Semantic Playback demo short - synthetic, owned footage", font=F_SUB, fill=tuple(int(c * a) for c in (180, 180, 190)), anchor="mm")
        else:
            d.text((W / 2, H / 2), "THE END", font=F_TITLE, fill=(240, 220, 160), anchor="mm")
        return img
    sc = next(s for s in tl["scenes"] if s["start"] <= t < s["end"])
    lit_line = sc.get("lamp_lit_from_line")
    lamp_on = lit_line is not None and any(l["scene"] == sc["idx"] and l["idx"] == lit_line and t >= l["end"] for l in tl["lines"])
    key = (sc["idx"], lamp_on)
    if key not in cache:
        bg = background(sc["bg"], sc.get("night", False), lamp_on)
        dd = ImageDraw.Draw(bg)
        for text, xy in sc["signs"]:
            draw_sign(dd, text, xy)
        cache[key] = bg
    img = cache[key].copy()
    d = ImageDraw.Draw(img)
    speaking = next((l["speaker"] for l in tl["lines"] if l["scene"] == sc["idx"] and l["start"] <= t < l["end"]), None)
    n = len(sc["cast"])
    for i, cid in enumerate(sc["cast"]):
        x = int(W * (i + 1) / (n + 1)) - (60 if sc["bg"] == "exterior" else 0)
        draw_person(d, cid, x, 600, t, cid == speaking)
    if sc["bg"] == "cliff":  # lantern glow
        glow = Image.new("RGB", (W, H), (0, 0, 0))
        ImageDraw.Draw(glow).ellipse([380, 300, 680, 600], fill=(120, 90, 20))
        img = Image.blend(img, Image.composite(glow, img, glow.convert("L").filter(ImageFilter.GaussianBlur(40))), 0.35)
        d = ImageDraw.Draw(img)
        d.rectangle([505, 470, 535, 510], fill=(250, 210, 90), outline=(60, 50, 30), width=3)
    for b in tl["beats"]:
        if b["overlay"] and b["scene"] == sc["idx"] and b["line"]["start"] - 0.2 <= t < b["line"]["end"] + 1.2:
            (overlay_letter if b["overlay"] == "letter" else overlay_map)(img)
    # scene fade in/out
    edge = min(t - sc["start"], sc["end"] - t)
    if edge < 0.5:
        img = Image.blend(Image.new("RGB", (W, H)), img, max(0.0, edge / 0.5))
    return img


# ------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join("data", "content", CONTENT_ID))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        print("synthesising dialogue...", flush=True)
        tl = build_timeline(synth_lines(tmp))
        dur = tl["duration"]
        n_audio = int(dur * SR)
        voice = np.zeros(n_audio, dtype=np.float32)
        for l in tl["lines"]:
            a = int(l["start"] * SR)
            voice[a:a + len(l["audio"])] += l["audio"][: n_audio - a]
        mix = np.clip(voice * 0.95 + ambience(n_audio, tl), -1, 1)
        apath = os.path.join(tmp, "audio.wav")
        with wave.open(apath, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((mix * 32767).astype(np.int16).tobytes())

        vpath = os.path.join(args.out, "story.mp4")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
               "-i", "-", "-i", apath, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
               "-g", str(FPS), "-keyint_min", str(FPS), "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
               "-shortest", vpath]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        cache = {}
        nframes = int(dur * FPS)
        for f in range(nframes):
            proc.stdin.write(render_frame(f / FPS, tl, cache).tobytes())
            if f % (FPS * 30) == 0:
                print(f"  frame {f}/{nframes}", flush=True)
        proc.stdin.close()
        if proc.wait() != 0:
            raise SystemExit("ffmpeg failed")

    ms = lambda s: int(round(s * 1000))
    scenes = [{"id": f"sc-{s['idx'] + 1}", "number": s["idx"] + 1, "title": s["title"], "location": s["location"],
               "startMs": ms(s["start"]), "endMs": ms(s["end"]), "characters": s["cast"],
               "objects": sorted({o for b in tl["beats"] if b["scene"] == s["idx"] for o in b["objects"]}),
               "description": s["description"]} for s in tl["scenes"]]
    beats = [{"id": f"bt-{i + 1}", "type": b["type"], "sceneId": f"sc-{b['scene'] + 1}", "startMs": ms(b["start"]),
              "endMs": ms(b["end"]), "description": b["description"], "characters": b["characters"], "objects": b["objects"]}
             for i, b in enumerate(tl["beats"])]
    signs = [{"startMs": ms(s["start"]), "endMs": ms(s["end"]), "text": text, "kind": "sign"} for s in tl["scenes"] for text, _ in s["signs"]]
    signs += [{"startMs": ms(b["line"]["start"] - 0.2), "endMs": ms(b["line"]["end"] + 1.2), "kind": b["overlay"],
               "text": "Meet me at the north cliff at midnight. - T." if b["overlay"] == "letter" else "GULLROCK BAY - NORTH CLIFF (X) - the light belongs to the cliff"}
              for b in tl["beats"] if b["overlay"]]
    presence = [{"startMs": ms(s["start"]), "endMs": ms(s["end"]), "characterId": c, "name": CHARACTERS[c]["name"]}
                for s in tl["scenes"] for c in s["cast"]]
    provider = {
        "contentId": CONTENT_ID, "title": TITLE, "kind": "narrative", "durationMs": ms(dur), "media": "story.mp4",
        "source": "synthetic short film rendered by scripts/demo-media/generate_story.py (owned, no third-party rights)",
        "characters": [{"id": k, "name": v["name"], "role": v["role"], "aliases": v["aliases"], "description": v["description"], "appearance": v["appearance"]} for k, v in CHARACTERS.items()],
        "objects": [{"id": k, **v} for k, v in OBJECTS.items()],
        "scenes": scenes, "beats": beats, "signs": sorted(signs, key=lambda s: s["startMs"]), "presence": presence,
    }
    with open(os.path.join(args.out, "provider.json"), "w", encoding="utf-8") as f:
        json.dump(provider, f, indent=1)
    dialogue = [{"id": f"tx-{i + 1:03d}", "startMs": ms(l["start"]), "endMs": ms(l["end"]), "speaker": l["speaker"], "text": l["text"]}
                for i, l in enumerate(tl["lines"])]
    with open(os.path.join(args.out, "dialogue.json"), "w", encoding="utf-8") as f:
        json.dump({"contentId": CONTENT_ID, "source": "dialogue script synthesised with Windows SAPI TTS (measured line timings)", "lines": dialogue}, f, indent=1)
    print(f"done: {vpath} {dur:.1f}s, {len(scenes)} scenes, {len(beats)} beats, {len(dialogue)} lines")


if __name__ == "__main__":
    main()
