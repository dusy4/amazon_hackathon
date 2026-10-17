"""Transcribe a title's audio to WebVTT with faster-whisper running locally.

Amazon Transcribe is blocked until the AWS account is verified, so titles without captions get their
transcript from a local Whisper model instead. The ingest reads video.en.vtt either way and records
where the transcript came from (video.transcript-source.txt).

Usage: python scripts/whisper-vtt.py data/content/<id> [model]
"""
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def ts(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def main() -> None:
    folder = Path(sys.argv[1])
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small.en"
    try:
        model = WhisperModel(model_name, device="cuda", compute_type="int8_float16")
    except Exception:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(folder / "video.mp4"), language="en", vad_filter=True, word_timestamps=False)
    lines = ["WEBVTT", ""]
    for seg in segments:
        text = seg.text.strip()
        if text:
            lines += [f"{ts(seg.start)} --> {ts(seg.end)}", text, ""]
    (folder / "video.en.vtt").write_text("\n".join(lines), encoding="utf-8")
    (folder / "video.transcript-source.txt").write_text(f"faster-whisper {model_name} (local)", encoding="utf-8")
    print(f"{(len(lines) - 2) // 3} cues → {folder / 'video.en.vtt'}")


if __name__ == "__main__":
    main()
