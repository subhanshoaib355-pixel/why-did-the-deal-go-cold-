import type { DealPain, FeedbackItem, PainHit, PainRank, SharedContext } from "./types.ts";
import { writeEvent } from "./memory.ts";
import { PAIN_RULES, profileFromContext, recallScored, recallTraceSummary, tagsFor } from "./recall.ts";
import { recordTrace } from "./trace.ts";

export function extractPain(feedback: FeedbackItem[]): PainHit[] {
  const hits = new Map<string, string[]>();
  for (const item of feedback) {
    for (const rule of PAIN_RULES) {
      if (!rule.re.test(item.text)) continue;
      const ids = hits.get(rule.tag) ?? [];
      if (!ids.includes(item.id)) ids.push(item.id);
      hits.set(rule.tag, ids);
    }
  }
  return [...hits.entries()]
    .map(([tag, evidenceIds]) => ({ tag, evidenceIds }))
    .sort((left, right) => (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0));
}

export function rankPain(deals: DealPain[]): PainRank[] {
  const grouped = new Map<string, { deals: Set<string>; hits: number }>();
  for (const deal of deals) {
    for (const tag of deal.tags) {
      const row = grouped.get(tag.tag) ?? { deals: new Set<string>(), hits: 0 };
      row.deals.add(deal.dealId);
      row.hits += tag.evidenceIds.length;
      grouped.set(tag.tag, row);
    }
  }
  return [...grouped.entries()]
    .map(([tag, row]) => ({
      tag,
      deals: [...row.deals].sort(),
      dealCount: row.deals.size,
      evidenceCount: row.hits,
    }))
    .sort((left, right) =>
      right.dealCount - left.dealCount ||
      right.evidenceCount - left.evidenceCount ||
      (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)
    );
}

export async function detectPain(ctx: SharedContext): Promise<void> {
  const tags = extractPain(ctx.feedback);
  const alreadyAsked = ctx.messages.some((message) => message.from === "pain-detector" && message.kind === "widen");
  const widenRequested = tags.length === 0 && !alreadyAsked;
  ctx.pain = { dealId: ctx.dealId, tags, widenRequested };
  const started = Date.now();
  const similar = await recallScored(profileFromContext(ctx), { topN: 5, excludeDealId: ctx.dealId });
  ctx.similarHits = similar.filter((hit) => hit.reasons.some((reason) => reason.startsWith("shared tag")));
  recordTrace({
    dealId: ctx.dealId,
    from: "Pain Detector",
    to: "Feedback Aggregator",
    kind: "recall",
    summary: ctx.similarHits.length ? `cross-check ${recallTraceSummary(ctx.similarHits)}` : "cross-check no shared pain tags",
    evidenceIds: ctx.similarHits.map((hit) => hit.dealId),
    durationMs: Date.now() - started,
  });
  await writeEvent({
    dealId: ctx.dealId,
    type: "pain",
    payload: ctx.pain,
    confidence: 0.75,
    tags: tagsFor(profileFromContext(ctx)),
  });
  if (widenRequested) {
    ctx.messages.push({
      from: "pain-detector",
      to: "feedback-aggregator",
      kind: "widen",
      detail: `no pain tags for ${ctx.dealId}`,
    });
  }
}
