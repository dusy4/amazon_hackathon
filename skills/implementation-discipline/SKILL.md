---
name: implementation-discipline
description: Keep implementation work validated, deterministic where appropriate, and synchronized with the canonical Notion product state.
---

# Implementation Discipline

## Prefer deterministic tools after grounding

LLM:
- interpret
- resolve ambiguity
- choose tools

Deterministic code:
- seek
- speed
- loop
- clip
- share
- persist
- contact lookup
- shopping action
- automation storage

Example:

“three seconds earlier”
→ `activeSegment.startMs - 3000`
→ `player.seek(...)`

Do not run another global semantic search unnecessarily.

## Validate changes

Run the strongest relevant checks:
- unit tests
- type/lint checks
- API smoke test
- contract/schema tests
- Fire TV/Vega simulator/device
- semantic retrieval cases
- real tool call

## Before completion

If implementation changed:
- architecture → update `v2`
- real constraint/friction → update `Dev + Friction Log`
- demo pipeline → update `Demo Video`
- new possibility → update `Product Exploration — Feature Base`
