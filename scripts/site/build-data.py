"""Export the recorded demo turns (the same takes as the film) as JSON for the website's interactive demo.

Each demo item carries the request, the TV's answer, the interpreter, the real total latency and the
"under the hood" rows built by the film's own rail builder, so the site shows exactly what the film shows.

    python scripts/site/build-data.py   # → apps/site/public/data/demo.json
"""
import json
import os
import sys

RECORDINGS = "artifacts/launch7,artifacts/launch10f2,artifacts/launch9s6,artifacts/launch8s7,artifacts/launch8s8,artifacts/launch12f0"
sys.argv = ["launch.py", RECORDINGS, os.devnull]
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "demo-video"))
import launch  # noqa: E402

KIND = {launch.AWS_C: "aws", launch.TV_C: "tv", launch.SRV_C: "server", launch.LLM_C: "llm", launch.YOU_C: "you"}

# clip id → (scene id, turn indexes shown in that clip)
DEMOS = {
    "lens": ("f0-whos-this", [0]),
    "goal": ("f1-football", [2]),
    "slowmo": ("f1-football", [3]),
    "share": ("f1-football", [5]),
    "spoilers": ("f2-spoilers-memory", [0, 1, 2]),
    "refine": ("f2-spoilers-memory", [3]),
    "catchup": ("f2-spoilers-memory", [6]),
    "live": ("s8-live", [0]),
    "films": ("s6-films", [0]),
    "ask": ("s6-films", [1]),
    "translate": ("s6-films", [2]),
    "access": ("s7-accessibility", [0]),
}


def turn_json(tr):
    t = tr["turn"]
    return {
        "said": tr["utterance"],
        "answer": t["speech"],
        "interpreter": "llm" if any(k in t["interpreter"] for k in ("openrouter", "bedrock")) else "rules",
        "totalMs": tr["doneMs"] - tr["atMs"],
        "rows": [{"ms": ms, "kind": KIND.get(col, "server"), "title": title, "detail": detail, "took": took}
                 for ms, col, title, detail, took in launch.rail_rows(tr)],
    }


out = {}
for clip, (scene, idxs) in DEMOS.items():
    turns = launch.MANIFEST[scene]["turns"]
    out[clip] = [turn_json(turns[i]) for i in idxs]

# The match's moment index (built with Amazon Rekognition at ingest): the timeline on the site.
idx = json.load(open("data/index/yt-soccer-aid-2023.json", encoding="utf-8"))
moments = [{"atMs": e["startMs"], "endMs": e["endMs"], "type": e["type"], "label": e.get("title") or e["description"][:80], "description": e["description"]}
           for e in idx["events"]]
os.makedirs("apps/site/public/data", exist_ok=True)
json.dump({"demos": out, "match": {"title": idx.get("title"), "durationMs": idx["durationMs"], "moments": moments}},
          open("apps/site/public/data/demo.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print({k: [t["said"] for t in v] for k, v in out.items()}, len(moments), "moments")
