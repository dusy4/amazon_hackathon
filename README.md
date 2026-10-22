# Semantic Playback

**An agentic context layer for video on Fire TV.** Say what you remember ("who's this?", "show me his goal",
"go back five seconds in slow motion", "clip that and send it to my phone"). The TV understands the moment you
mean, grounds it to an exact position, and acts on the player.

> **Video players understand timestamps. Humans remember moments.**

Core loop: **Understand → Ground → Act → Remember → Continue.** The model interprets; deterministic tools do
the precise work (seek, speed, loop, clip, share, memory).

Tracks: **Fire TV** (native Fire OS app, Media3) · **Alexa+** (self-hosted MCP server, spec 2025-11-25,
Streamable HTTP) · Mini challenge: **AWS Builder**. Project notes, research, friction log and feature requests
live in Notion (see [AGENTS.md](./AGENTS.md)).

## What it does

| You say | What happens | Built on |
|---|---|---|
| "Who's this?" / "Who is she?" | Pauses on the frame, recognises the person, resumes | Amazon Rekognition RecognizeCelebrities; per-film face collection (IndexFaces, SearchFacesByImage) with names from the film's own credits |
| "Read the score" | Reads the scoreboard like a person ("England 0, World XI 1, 23:57 on the clock") | Rekognition DetectText |
| "Show me his goal" | "his" = the person just identified; plays from the build-up (~1 s, no model call) | Hybrid index (BM25 + embeddings + entities, RRF) built with Rekognition Video shot detection |
| "Go back five seconds in slow motion" | Exact relative seek + 0.5× | Deterministic MCP tools |
| "Clip that and send it to my phone" | Clip of the grounded moment, pushed to the companion page | ffmpeg (MediaConvert-shaped job), WebSocket |
| "Show me Robbie Keane's goal" | "I won't spoil it…" until "spoilers off" | Spoiler boundary that advances only on real playback |
| "I was away for 2 minutes, catch me up" | The latest big moments, spoiler-bounded | `moments.summarize` |
| "Who was the player I asked about?" | "You asked who that was: Usain Bolt — 2 minutes ago." | Amazon DynamoDB Viewing Memory, mirrored to Amazon Bedrock AgentCore Memory |
| "Where have I seen her before?" | Free-form: the LLM agent combines tools and answers, spoiler-aware | LLM agent over 26 MCP tools (`entities.appearances`, `memory.search`, …) |
| "Translate that into Spanish" | On-screen text, translated | Rekognition DetectText → Amazon Translate (model fallback while the account is blocked) |
| "Say that again slowly" | Replays the real line at 0.75× | Captions timeline |
| (Fire TV setting) Captions / Audio Description | Real captions on screen; a spoken scene description after every jump | Fire TV AD/CC API (`Settings.Secure`, `CaptioningManager`) |
| (live match) | The stream itself announces the goal; "show me that goal" replays it; "back to live" | **Amazon IVS** low-latency channel + `PutMetadata` timed metadata, read by ExoPlayer from the HLS stream |

## AWS integrations (documented)

| Service | Used for | Code |
|---|---|---|
| Amazon Rekognition Video | Shot detection (StartSegmentDetection) over S3 media at ingest | `services/media/src/rekognition.ts`, `ingest-video.ts` |
| Amazon Rekognition Image | DetectLabels, DetectText, RecognizeCelebrities per keyframe and on the live paused frame | `services/media/src/rekognition.ts`, `services/agent/src/tools.ts` (`lens.*`) |
| Amazon Rekognition face collections | Characters in films: IndexFaces, SearchFaces clustering, SearchFacesByImage | `services/media/src/faces.ts` |
| Amazon S3 | Media staged for Rekognition Video | `services/media/src/rekognition.ts` |
| Amazon Polly (generative) | Every spoken answer | `services/agent/src/tts.ts` |
| Amazon DynamoDB | Viewing Memory (canonical activity log) with local failover | `services/context/src/memory.ts` |
| Amazon Bedrock AgentCore Memory | The agent's session memory: every action mirrored as a short-term event; read back by `memory.search` | `services/context/src/agentcore-memory.ts` |
| Amazon IVS | Live channel, RTMPS ingest, `PutMetadata` goal markers in the stream | `services/agent/src/live.ts`, Fire OS `MainActivity.kt` (`onMetadata`) |
| Amazon Translate | Translation of on-screen text and dialogue (falls back to the agent's model when unavailable) | `services/agent/src/translate.ts` |
| Amazon Bedrock | Target for the LLM agent (`SP_LLM=bedrock`, Converse). Blocked by account verification; OpenRouter runs the same code | `services/agent/src/llm.ts` |

## Quick start: no AWS account, no API keys

```bash
npm install
npm start          # server + MCP at http://localhost:8787/mcp
```

Then pick a player:
- **Fire OS app (the product):** see [Fire OS app](#fire-os-app) below.
- **Browser TV (no emulator):** http://localhost:8787/tv/ in Chrome, with the tab visible. It runs the same server and player commands.

The six titles ship as compact 480p copies, so there's nothing else to download. `ffmpeg` on PATH is only needed for "clip that". Without keys it works like this:

| Works without keys | Needs a key or AWS |
|---|---|
| Find moments ("show me Usain Bolt's goal"), follow-ups, slow motion, refinements, catch-up, spoiler guard, Viewing Memory (local file), clip and send to phone | **Open questions** ("where have I seen her before?") need an LLM: `SP_LLM=openrouter` + key, or Bedrock |
| "Who's this?", "who is she?" and "read the score" answer from the Amazon Rekognition analysis stored at indexing (the answer says so); live Rekognition is used when AWS credentials are present | **Translate** needs Amazon Translate or an LLM |
| Spoken replies: the browser TV uses the browser's voice; the Fire OS app shows the text | **Amazon Polly** voices, **DynamoDB / AgentCore Memory**, the **IVS live channel**: AWS (see [AWS setup](#aws-setup)) |

```bash
npm test           # 58 tests: parser, retrieval, canonicalisation, end-to-end over real MCP (no AWS needed)
npm run smoke:mcp  # what any MCP client (Alexa+, an AgentCore agent) sees
```

### Fire OS app

```bash
cd apps/fire-tv/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.semanticplayback.firetv/.MainActivity --es server http://<lan-ip>:8787
```
The app joins the server's player bridge (WebSocket). MENU opens suggested requests. On the Android TV
emulator, add `--es variant 480` for the lighter rendition and set `SP_IVS_RELAY=1` if the emulator has no
internet access.

### Content

```bash
bash scripts/fetch-videos.sh                         # full-quality originals of the bundled 480p titles (yt-dlp + ffmpeg)
npm run ingest:video -- yt-soccer-aid-2023           # S3 → Rekognition Video shots → keyframes → Rekognition → captions → descriptions → embeddings
npx tsx services/media/src/faces.ts yt-tears-of-steel   # per-film face collection (characters)
```
Intermediate results are cached in `data/content/<id>/analysis/`.

## AWS setup

```bash
aws login --region us-east-1                          # browser sign-in, no long-lived keys
aws dynamodb create-table --table-name semantic-playback-viewing-memory --attribute-definitions AttributeName=userId,AttributeType=S AttributeName=sk,AttributeType=S --key-schema AttributeName=userId,KeyType=HASH AttributeName=sk,KeyType=RANGE --billing-mode PAY_PER_REQUEST
aws bedrock-agentcore-control create-memory --name semantic_playback_viewing --event-expiry-duration 30   # → SP_AGENTCORE_MEMORY_ID
aws ivs create-channel --name semantic-playback-live --latency-mode LOW --type BASIC                       # → SP_IVS_CHANNEL_ARN / _INGEST / _STREAM_KEY / _PLAYBACK
```
`.env`: `SP_MEMORY=dynamodb`, `SP_AGENTCORE_MEMORY_ID`, `SP_IVS_*`, `SP_LLM=openrouter|bedrock`.
New accounts cannot call Bedrock, Transcribe or Translate until AWS finishes account verification; every
feature keeps working on its fallback and says which engine ran. `npm test` uses local backends.

## Architecture

```
Fire TV app (Kotlin, Media3) ⇄ WebSocket player bridge ⇄ Orchestrator
                                                          ├─ Context service (Context Envelope: relevant core · ambient · deep refs)
                                                          ├─ Router: simple asks → rules + hybrid search (no model call)
                                                          │          open-ended → LLM agent (deadline-bounded, MCP client)
                                                          └─ MCP server (Streamable HTTP, 2025-11-25, 26 tools)
                                                               player.* · moments.* · lens.* · entities.* · memory.search
                                                               clip.create · share.send · content.open · live.*
                                                               → Rekognition · Polly · DynamoDB · AgentCore Memory · IVS · S3
```

## Demo film

```bash
npx tsx scripts/demo-video/record.ts artifacts/demo        # scripted scenes on the device + every turn's real trace
python scripts/demo-video/launch.py artifacts/demo out.mp4 # film: TV on the left, the real trace "under the hood" on the right
```

## Evals

```bash
npm run eval            # golden set (35 paraphrased requests across four videos) with the configured interpreter
SP_LLM= npm run eval    # rules-only baseline
```

## License

MIT (see [LICENSE](./LICENSE)). Footage is Creative Commons (see `data/content/ATTRIBUTION.md`).
