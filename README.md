# Amazon Hackathon — Semantic Playback

Semantic Playback is an agentic context layer for video.

> **Video players understand timestamps. Humans remember moments.**

Notion is the project source of truth (see [AGENTS.md](./AGENTS.md)). This README covers only how to run the code.

## Quick start

```bash
npm install
npm run media:generate   # renders the owned demo match (needs Python + Pillow + numpy + ffmpeg; Windows SAPI TTS)
npm run ingest           # builds data/index/harbor-v-northgate.json
npm start                # http://localhost:8787/tv/  ·  /phone/  ·  /mcp
npm test                 # parser + retrieval + end-to-end (real MCP + headless player)
npm run smoke:mcp        # what any MCP client sees
```

Try: “Rewind to the replay of the last goal, start three seconds before it, play it slower, repeat it twice, clip it, and send it to my phone.”

## What runs today

| Layer | Implementation | AWS path (env-switched) |
|---|---|---|
| Demo media | `scripts/demo-media/generate_match.py`: synthetic, owned match + provider feed + TTS commentary | — |
| Transcript | commentary script with measured timings | `npm run ingest -- --transcribe <Amazon Transcribe JSON>` |
| Embeddings | `local-hash-v1` (dev fallback, not a learned model) | `SP_EMBEDDINGS=nova` → Nova Multimodal Embeddings |
| Retrieval | hybrid BM25 + vector + entity + event, deterministic temporal constraints, spoiler boundary | OpenSearch (planned) |
| Agent | deterministic rules parser + orchestrator, an MCP client of its own server | `SP_AGENT=bedrock` → Bedrock Converse tool-use fallback |
| Tools | self-hosted MCP server, Streamable HTTP, 17 tools (`player.*`, `moments.*`, `lens.*`, `clip.create`, `share.send`, `memory.search`…) | — |
| Players | web TV player (`apps/fire-tv/web`) + Fire OS app (`apps/fire-tv/android`, Media3 ExoPlayer + MediaSession) | — |
| Clips | ffmpeg clip + watermark + attribution (MediaConvert-equivalent job shape) | MediaConvert |
| Viewing Memory | JSONL event log | `SP_MEMORY=dynamodb` — **live-verified 2026-10-06** |
| Send to phone | companion web app push + QR/deep link | Alexa Send to Phone (future) |

## Real footage

```bash
bash scripts/fetch-videos.sh            # Creative-Commons test videos (see data/content/ATTRIBUTION.md)
npm run ingest:video -- yt-roti-recipe  # S3 → Rekognition Video shots → Rekognition per keyframe → captions → LLM descriptions → embeddings
```
Intermediate results are cached in `data/content/<id>/analysis/` (re-running is free).

## Evals

```bash
npm run eval            # golden set (evals/golden.json) through the full stack with the configured interpreter
SP_LLM= npm run eval    # rules-only baseline
npm run eval -- s-      # only cases whose id contains "s-"
```
Seek cases pass when the player lands inside the target segment (synthetic titles) or the caption-derived
time window (real footage); results land in `evals/results/`.

## AWS setup

```bash
aws login --region us-east-1      # browser sign-in, no long-lived keys
aws dynamodb create-table --table-name semantic-playback-viewing-memory   --attribute-definitions AttributeName=userId,AttributeType=S AttributeName=sk,AttributeType=S   --key-schema AttributeName=userId,KeyType=HASH AttributeName=sk,KeyType=RANGE --billing-mode PAY_PER_REQUEST
```
Then copy `.env.example` to `.env` and enable `SP_MEMORY=dynamodb`, `SP_AGENT=bedrock`, `SP_EMBEDDINGS=nova`.
A brand-new account cannot invoke Bedrock or Transcribe until AWS finishes account verification
(errors: `AccessDeniedException … being verified`, `ThrottlingException: Too many tokens per day`,
`SubscriptionRequiredException`); the app keeps running on its local fallbacks meanwhile.
`npm test` always uses the local backends (see `vitest.config.ts`); `SP_TEST_AWS=1 npm test` uses `.env`.

## Fire OS app

```bash
cd apps/fire-tv/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.semanticplayback.firetv/.MainActivity --es server http://<lan-ip>:8787
```
MENU on the remote opens a text prompt. The app joins the player bridge as `deviceKind: fireos`.
