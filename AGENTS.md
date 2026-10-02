# AGENTS.md — Semantic Playback

This file tells agents **how to work on the project**.

## Source of truth

**Notion is the persistent project source of truth.**

Do not create or maintain parallel local Markdown logs for:
- project state
- research
- decisions
- friction
- feature requests
- session handoffs

Repository Markdown should only contain implementation-specific docs when actually useful for the codebase.

## Canonical Notion pages

- **v2** — product canon, end-state vision, architecture, verified API/tool status, documentation index
  - ID: `3e664c31-bfb3-81cd-b039-ec2af07c0017`
- **Product Exploration — Feature Base** — ideas, alternatives, unresolved possibilities
  - ID: `3e664c31-bfb3-8190-8763-ceb8aeaf5a66`
- **Dev + Friction Log** — real friction, Amazon product feedback, feature requests, implementation discoveries
  - ID: `3e664c31-bfb3-814f-a2a7-e79508e34b21`
- **Demo Video** — implementation-faithful demo flow and real pipeline
  - ID: `3e664c31-bfb3-818e-9341-d980f7f6c522`
- **Agent Operating System** — working rules for agents
  - ID: `3ed64c31-bfb3-8152-b474-c58092a7c420`

## Product principle

> **Video players understand timestamps. Humans remember moments.**

Semantic Playback is an agentic context layer for video.

Core loop:

**Understand → Ground → Act → Remember → Continue**

Do not reduce the product to semantic search, subtitle chat, or a smarter remote.

## No-pruning rule

Until the human explicitly starts scope pruning:

- do not delete product ideas because implementation is difficult;
- do not rewrite the product vision around current API limitations;
- update feasibility/classification instead;
- preserve alternatives and contradictions;
- distinguish ideal product from current implementation.

Feasibility:
- **A** official direct API/SDK
- **B** official building blocks composed by us
- **C** consumer capability exists, developer interface unverified/closed
- **D** feasible with own infrastructure
- **E** official third-party integration
- **F** unverified/research hypothesis

## Before a substantial task

1. Read this file.
2. Read the relevant `skills/*/SKILL.md`.
3. Read the relevant Notion page(s).
4. If the task depends on current public APIs, verify current official docs first.
5. Inspect the current implementation before proposing architecture changes.

## Notion routing

### Update `v2` when
- product behavior changes;
- architecture changes;
- tool/API status is verified or corrected;
- canonical use cases are added;
- stack/tooling materially changes;
- an assumption is superseded.

### Update `Product Exploration — Feature Base` when
- a new product idea appears;
- an alternative integration is discovered;
- a future possibility should be preserved;
- an idea is exploratory rather than canonical.

### Update `Dev + Friction Log` when
- a real implementation attempt produces friction;
- an Amazon tool/API/SDK is actually used and needs Product Feedback;
- a missing Amazon capability suggests a Feature Request;
- implementation reveals a constraint or workaround.

### Update `Demo Video` when
- the real service/tool pipeline changes;
- demo scene behavior changes;
- a payload shown in the demo changes;
- a service is replaced;
- an integration is simulated rather than native.

## Research rules

Prefer:
1. official Amazon/AWS/Alexa/Fire TV/Ring/IMDb docs
2. Devpost rules/resources/FAQ
3. official GitHub repositories
4. official third-party docs
5. secondary sources only when necessary

For material findings, update Notion with:
- finding
- source
- date
- access status: public / preview / partner-gated / deprecated / unclear
- feasibility class
- architecture/product effect

Do not say “there is no API” just because none was found.
Use:
> “No public developer interface was found in the official sources searched as of [date].”

## Friction vs Feature Request

These are separate.

### Friction
Only after a real implementation attempt.

Capture in `Dev + Friction Log`:
- task attempted
- exact steps
- expected
- actual
- exact error/log
- severity
- workaround
- actionable suggestion

Never fabricate friction from research.

### Feature Request
Can come from research or implementation.

Capture:
- what Amazon should build/change
- why it matters to Semantic Playback
- concrete use case
- priority: Critical / Important / Nice-to-have
- current workaround
- evidence/docs
- related friction if any

## Demo truthfulness

Never show a fake integration.

If the implementation:
- calls tools directly, do not show AgentCore Gateway unless actually used;
- uses a simulated Alexa+ client, do not imply gated Alexa+ tooling was used;
- uses a companion backend for contacts, do not show native Alexa contact-book access;
- uses a fallback service, show the real fallback.

Simplified real payloads are fine. Fictional service calls are not.

## LLM vs deterministic actions

Use the model for:
- intent interpretation
- ambiguity resolution
- tool selection
- grounded synthesis

Use deterministic tools for:
- seek
- play/pause
- speed
- loop
- clip generation
- sharing
- contact lookup
- event persistence
- shopping actions
- automation persistence

After a moment is grounded, prefer deterministic relative operations.

## Context Envelope

Use:
- **Relevant Core** — directly needed current facts
- **Ambient Context** — optional context that can improve continuity/personalization
- **Deep Context** — retrievable references to full data

Principle:

> **All data is addressable. Relevant data is inlined. Optional data is summarized. Deep data is retrievable.**

## End-of-task rule

Before declaring a material task complete:

- run the strongest relevant validation;
- update the relevant Notion page(s);
- log real friction if encountered;
- log feature requests if identified;
- update `Demo Video` if the pipeline changed;
- do not silently delete product capabilities.

**Notion is the source of truth. AGENTS.md and skills only explain how to work.**
