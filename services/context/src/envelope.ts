/**
 * Context Envelope builder (v2 "Context Envelope v2").
 *
 * Relevant Core is inlined, Ambient Context is summarised, Deep Context is passed by reference:
 * "All data is addressable. Relevant data is inlined. Optional data is summarized. Deep data is retrievable."
 * Content-derived facts are bounded by the spoiler boundary in strict mode.
 */
import type { ContentIndex, ContextEnvelope, PlayerState } from "../../../packages/contracts/src/index.ts";
import { entityIdForPlayer } from "../../../packages/contracts/src/index.ts";
import type { ViewingMemory } from "./memory.ts";
import type { PlaybackSession } from "./session.ts";

export interface EnvelopeInput {
  utterance: string;
  inputSource: string;
  device: string;
  session: PlaybackSession;
  player: PlayerState | null;
  index: ContentIndex | undefined;
  memory: ViewingMemory;
  devices: { deviceId: string; kind: string }[];
}

export async function buildEnvelope(i: EnvelopeInput): Promise<ContextEnvelope> {
  const { session, player, index } = i;
  const pos = player?.positionMs ?? 0;
  const boundary = Math.max(session.watchedUpToMs, pos);
  const currentEntities: ContextEnvelope["relevantCore"]["currentEntities"] = [];
  let transcriptWindow: ContextEnvelope["relevantCore"]["transcriptWindow"] = [];
  let screenText: string | null = null;

  if (index) {
    const holder = index.possession.find((p) => p.startMs <= pos && pos < p.endMs);
    if (holder) currentEntities.push({ id: entityIdForPlayer(holder.team, holder.number), name: holder.name, why: "in possession now" });
    const lastTouches = index.touches.filter((t) => t.ms <= pos && t.ms > pos - 10000).slice(-3);
    for (const t of lastTouches) {
      const id = entityIdForPlayer(t.team, t.number);
      if (!currentEntities.some((e) => e.id === id)) currentEntities.push({ id, name: t.name, why: "touched the ball in the last 10s" });
    }
    transcriptWindow = index.transcript
      .filter((l) => l.startMs <= pos && l.startMs > pos - 20000)
      .map((l) => ({ startMs: l.startMs, text: l.text }));
    screenText = index.scoreboard.find((s) => s.startMs <= pos && pos < s.endMs)?.text ?? null;
    if (index.kind === "narrative") {
      const speaking = index.transcript.find((l) => l.startMs <= pos && pos < l.endMs + 800);
      for (const p of (index.presence ?? []).filter((p) => p.startMs <= pos && pos < p.endMs))
        currentEntities.push({
          id: p.entityId,
          name: p.name,
          why: speaking && p.entityId === `character:${speaking.speaker}` ? "speaking now" : "on screen",
          appearance: index.entities.find((e) => e.id === p.entityId)?.description?.split("Appearance: ")[1],
        });
      currentEntities.sort((a, b) => Number(b.why === "speaking now") - Number(a.why === "speaking now"));
      screenText = (index.signs ?? []).filter((s) => s.startMs <= pos && pos < s.endMs).map((s) => s.text).join(" · ") || null;
    }
  }
  const activeEntity = session.activeEntityId && index ? index.entities.find((e) => e.id === session.activeEntityId) : undefined;
  const recent = await i.memory.recent(session.userId, 6);

  return {
    request: {
      utterance: i.utterance,
      receivedAt: new Date().toISOString(),
      device: i.device,
      sessionId: session.sessionId,
      inputSource: i.inputSource,
    },
    relevantCore: {
      contentId: index?.contentId ?? null,
      title: index?.title ?? null,
      playback: player
        ? { positionMs: player.positionMs, durationMs: player.durationMs, paused: player.paused, rate: player.rate, loop: player.loop, deviceKind: player.deviceKind }
        : null,
      activeReference: session.activeRef
        ? { ...session.activeRef, results: session.activeRef.results?.slice(0, 5) }
        : null,
      activeEntity: activeEntity ? { id: activeEntity.id, name: activeEntity.name } : null,
      currentEntities,
      transcriptWindow,
      screenText,
      spoilerBoundaryMs: boundary,
      spoilerMode: session.spoilerMode,
      momentTypes: (index?.events ?? []).reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {}),
    },
    ambient: {
      recentActions: recent.map((e) => ({ type: e.type, summary: e.summary, at: e.wallClock })),
      previousUtterances: session.utterances.slice(-5),
      recentClips: session.clips.slice(-3).map((c) => ({ clipId: c.clipId, label: c.label })),
      accessibility: session.accessibility,
      devices: i.devices,
    },
    deep: {
      timelineIndexRef: index ? `data/index/${index.contentId}.json#segments` : null,
      transcriptRef: index ? `data/index/${index.contentId}.json#transcript` : null,
      viewingActivityRef: `${i.memory.backend}?userId=${session.userId}`,
      mediaRef: index ? `/media/${index.contentId}/${index.media}` : null,
      embeddingModel: index?.embeddingModel ?? null,
    },
  };
}
