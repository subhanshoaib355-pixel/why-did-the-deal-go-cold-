import type { Recommendation, SharedContext } from "./types.ts";
import { writeEvent } from "./memory.ts";
import { profileFromContext, tagsFor } from "./recall.ts";

const RANK: Record<string, number> = {
  competitor: 1,
  budget: 2,
  "no-response": 3,
  integration: 4,
  legal: 5,
  timing: 6,
};

const ACTION: Record<string, string> = {
  competitor: "Prepare a comparison for the competitor evidence",
  budget: "Address the budget constraint in the evidence",
  "no-response": "Re-engage the contact on the no-response evidence",
  integration: "Answer the integration questions in the evidence",
  legal: "Support the legal review in the evidence",
  timing: "Confirm the timeline in the evidence",
};

function numbered(items: Recommendation[]): Recommendation[] {
  return items.map((item, index) => ({ ...item, priority: index + 1 }));
}

export function buildRecommendations(ctx: SharedContext): Recommendation[] {
  const tags = [...(ctx.pain?.tags ?? [])].sort(
    (left, right) => (RANK[left.tag] ?? 99) - (RANK[right.tag] ?? 99) || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)
  );
  const items: Recommendation[] = tags.map((tag) => ({
    priority: RANK[tag.tag] ?? 99,
    action: ACTION[tag.tag] ?? `Review the ${tag.tag} evidence`,
    evidenceIds: [...tag.evidenceIds],
  }));
  if (ctx.confidence === "LOW") {
    items.unshift({
      priority: 1,
      action: "Collect the missing email or call note before changing the deal",
      evidenceIds: [ctx.dealId],
    });
  } else if (items.length === 0) {
    const ids = ctx.feedback.map((item) => item.id);
    items.push({
      priority: 1,
      action: ids.length ? "No pain tag. Keep the cited evidence on file" : "No pain tag and no feedback text. Collect an email or call note",
      evidenceIds: ids.length ? ids : [ctx.dealId],
    });
  }
  return numbered(items);
}

function similarRecommendation(ctx: SharedContext): Recommendation | null {
  const painTags = [...(ctx.pain?.tags ?? [])].map((tag) => tag.tag).sort(
    (left, right) => (RANK[left] ?? 99) - (RANK[right] ?? 99)
  );
  if (painTags.length === 0) return null;
  const seen = new Set<string>();
  for (const hit of ctx.similarHits) {
    if (hit.dealId === ctx.dealId || seen.has(hit.dealId)) continue;
    seen.add(hit.dealId);
    const shared = painTags.find((tag) => hit.reasons.includes(`shared tag ${tag}`));
    if (!shared) continue;
    const action = hit.status === "lost"
      ? `Similar past deal ${hit.dealId} lost on ${shared}`
      : `Similar past deal ${hit.dealId} shares ${shared}`;
    return { priority: 0, action, evidenceIds: [hit.dealId] };
  }
  return null;
}

export async function recommend(ctx: SharedContext): Promise<void> {
  const recommendations = buildRecommendations(ctx);
  if (ctx.priorColdContext && recommendations[0]) {
    recommendations[0] = {
      ...recommendations[0],
      memoryContext: {
        reason: ctx.priorColdContext.reason,
        suggestedAction: ctx.priorColdContext.suggestedAction,
        detectedAt: ctx.priorColdContext.detectedAt,
      },
    };
  }
  const similar = similarRecommendation(ctx);
  if (similar) recommendations.push({ ...similar, priority: recommendations.length + 1 });
  ctx.recommendations = recommendations;
  await writeEvent({
    dealId: ctx.dealId,
    type: "recommendation",
    payload: { rootCause: ctx.rootCause, recommendations: ctx.recommendations },
    confidence: ctx.confidence === "HIGH" ? 0.9 : ctx.confidence === "MEDIUM" ? 0.7 : 0.4,
    tags: tagsFor(profileFromContext(ctx)),
  });
}
