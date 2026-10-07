#!/usr/bin/env bash
# Re-download the Creative-Commons test footage (see data/content/ATTRIBUTION.md) and transcode to H.264
# (YouTube serves AV1, which Rekognition Video and many Fire TV devices cannot decode).
# Then index with: npm run ingest:video -- <folder>
set -euo pipefail
cd "$(dirname "$0")/.."
fetch() {
  local id=$1 dir=data/content/$2
  mkdir -p "$dir"
  python -m yt_dlp -q -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]" --merge-output-format mp4 \
    -o "$dir/video.av1.%(ext)s" --write-info-json --write-subs --write-auto-subs \
    --sub-langs "en,en-orig" --sub-format vtt "https://www.youtube.com/watch?v=$id"
  [ -f "$dir/video.av1.info.json" ] && mv "$dir/video.av1.info.json" "$dir/video.info.json"
  for f in "$dir"/video.av1.*.vtt; do [ -e "$f" ] && mv "$f" "${f/video.av1./video.}"; done
  ffmpeg -loglevel error -y -i "$dir/video.av1.mp4" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
    -g 30 -keyint_min 30 -sc_threshold 0 -c:a aac -b:a 128k -movflags +faststart "$dir/video.mp4"
}
fetch C_sb2KYbi-4 yt-soccer-aid-2023
fetch R6MlUcmOul8 yt-tears-of-steel
fetch Ag1AKIl_2GM yt-tedx-free-software
fetch FX3KAGdnKQk yt-roti-recipe
