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
| Demo media | `scripts/demo-media/generate_match.py`: synthetic, owned match + provider feed + TTS commentary; 4 CC BY real titles via `scripts/fetch-videos.sh` | — |
| Transcript | commentary script (synthetic) / YouTube captions (real footage) | `npm run ingest -- --transcribe <Amazon Transcribe JSON>` |
| Vision ingest | — | **Rekognition Video** shot detection + **Rekognition** labels / text / celebrities per keyframe (`npm run ingest:video`) |
| Embeddings | `local-hash-v1` (synthetic) / OpenRouter embeddings (real footage) | `SP_EMBEDDINGS=nova` → Nova Multimodal Embeddings |
| Retrieval | dense + BM25 + entity channels fused with RRF, deterministic temporal constraints, spoiler boundary | OpenSearch (planned) |
| Interpreter | router: structured requests on provider-feed titles → rules (~30 ms); open-ended → LLM agent calling the MCP tools, bounded by `SP_LLM_DEADLINE_MS` (default 25 s) with rules fallback | `SP_LLM=bedrock` → Bedrock Converse (`SP_LLM=openrouter` while Bedrock is blocked) |
| Tools | self-hosted MCP server, Streamable HTTP (2025-11-25), 17 tools (`player.*`, `moments.*`, `lens.*`, `clip.create`, `share.send`, `memory.search`…) | — |
| Players | web TV player (`apps/fire-tv/web`) + Fire OS app (`apps/fire-tv/android`, Media3 ExoPlayer + MediaSession, D-pad suggestion menu) | — |
| Voice | browser speech recognition in; spoken replies | **Polly** (generative) via `/api/tts` |
| Clips | ffmpeg clip + watermark + attribution (MediaConvert-equivalent job shape) | MediaConvert |
| Viewing Memory | JSONL event log | `SP_MEMORY=dynamodb` (falls back to the local log if DynamoDB is unreachable) |
| Send to phone | companion web app push + QR/deep link | Alexa Send to Phone (future) |

## Demo video pipeline

```bash
npm start                                         # with the Fire OS app (or /tv) connected as the active player
npx tsx scripts/demo-video/record.ts artifacts/demo   # scripted scenes via /api/utterance + adb screenrecord + real traces
python scripts/demo-video/compose.py artifacts/demo   # → artifacts/demo/demo-draft.mp4 (pipeline panel drawn from the traces)
```

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
