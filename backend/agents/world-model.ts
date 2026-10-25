import { latestEvent, writeEvent } from "./memory.ts";
import { profileFromContext, tagsFor } from "./recall.ts";
import type { ColdLeadContext, LeadTemperature, SharedContext, WorldModelState } from "./types.ts";

export function temperatureFor(ctx: SharedContext): LeadTemperature {
  const status = ctx.evidence.status.trim().toLowerCase();
  if (status === "won") return "hot";
  if (status === "lost" || status === "stalled" || ctx.confidence === "LOW") return "frozen";
  if (ctx.sentiments.some((item) => item.label === "negative") || (ctx.pain?.tags.length ?? 0) > 0) return "cold";
  return ctx.confidence === "HIGH" ? "warm" : "cold";
}

export async function recallPriorColdContext(dealId: string): Promise<ColdLeadContext | null> {
  return latestEvent<ColdLeadContext>(dealId, "cold-detection");
}

export async function updateWorldModel(ctx: SharedContext): Promise<void> {
  if (!ctx.journey) throw new Error("cannot update World Model before the Journey Mapper runs");

  const temperature = temperatureFor(ctx);
  const suggestedAction = ctx.recommendations[0]?.action ?? "Review the latest deal evidence";
  const updatedAt = new Date().toISOString();
  const worldModel: WorldModelState = {
    dealId: ctx.dealId,
    crmStatus: ctx.evidence.status,
    crmStage: ctx.evidence.stage,
    journeyStage: ctx.journey.stage,
    temperature,
    lastActivityDate: ctx.evidence.lastActivityDate,
    reason: ctx.rootCause,
    suggestedAction,
    updatedAt,
  };
  ctx.worldModel = worldModel;

  await writeEvent({
    dealId: ctx.dealId,
    type: "world-state",
    payload: worldModel,
    confidence: ctx.confidence === "HIGH" ? 0.9 : ctx.confidence === "MEDIUM" ? 0.7 : 0.4,
    tags: tagsFor(profileFromContext(ctx)),
  });

  if (temperature !== "cold" && temperature !== "frozen") return;
  const coldContext: ColdLeadContext = {
    dealId: ctx.dealId,
    temperature,
    reason: ctx.rootCause,
    suggestedAction,
    detectedAt: updatedAt,
  };
  await writeEvent({
    dealId: ctx.dealId,
    type: "cold-detection",
    payload: coldContext,
    confidence: ctx.confidence === "HIGH" ? 0.9 : ctx.confidence === "MEDIUM" ? 0.7 : 0.4,
    tags: tagsFor(profileFromContext(ctx)),
  });
}
