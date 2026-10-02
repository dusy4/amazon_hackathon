# Amazon Hackathon — Semantic Playback

Semantic Playback is an agentic context layer for video.

> **Video players understand timestamps. Humans remember moments.**

## Source of truth

**Notion is the persistent project source of truth.**

Do not maintain duplicate local Markdown logs for product state, research, decisions, friction, feature requests, or handoffs.

Canonical Notion pages:

- **v2** — product canon, full end-state vision, architecture, API/tool status
- **Product Exploration — Feature Base** — ideas, alternatives, unresolved possibilities
- **Dev + Friction Log** — implementation friction, Amazon product feedback, feature requests
- **Demo Video** — implementation-faithful demo pipeline
- **Agent Operating System** — rules for agents working on this project

## Agent guidance

Read [AGENTS.md](./AGENTS.md) before substantial work.

Reusable operating skills live under:

```text
skills/
```

## Workspace

```text
.
├── AGENTS.md
├── README.md
├── skills/
│   ├── notion-workflow/
│   ├── product-canon/
│   ├── research/
│   ├── friction-and-feature-requests/
│   ├── demo-truth/
│   └── implementation-discipline/
├── apps/
│   └── fire-tv/
├── services/
│   ├── agent/
│   ├── context/
│   └── media/
├── packages/
│   └── contracts/
├── infra/
├── scripts/
└── tests/
```

Code folders are intentionally lightweight until implementation choices are validated.

## Hackathon

Build, Ship, Shape: Amazon Developer Hackathon 2026

- Overview: https://amazonappdev2026.devpost.com/
- Resources: https://amazonappdev2026.devpost.com/resources
- Rules: https://amazonappdev2026.devpost.com/rules
- FAQs: https://amazonappdev2026.devpost.com/details/faqs
