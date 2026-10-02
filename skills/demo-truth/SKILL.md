---
name: demo-truth
description: Keep the Semantic Playback demo faithful to the actual implementation and synchronize changes into Notion.
---

# Demo Truth

Use when a real service, tool, payload, latency, or interaction changes.

Update `Demo Video`.

## Core rule

Show the real implemented pipeline.

Good:

voice → transcript → intent → Context Envelope → tool call → returned timestamp/entity → player action

Bad:
- fake Bedrock/AgentCore calls
- fake Alexa+ access
- fake contact integration
- decorative services not used by code

## For each demo scene

Capture:
- user utterance
- actual tool/service sequence
- important arguments
- important returned fields
- visible result
- fallback path
- actual tested behavior

Simplify payloads visually, but do not invent the underlying integration.
