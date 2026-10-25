import { listRecords, sleep, writeEvent } from "./memory.ts";
import { aggregate, crmRecord, emptyDealEvidence, widen } from "./feedback-aggregator.ts";
import { applyJourney } from "./journey-mapper.ts";
import { detectPain, rankPain } from "./pain-detector.ts";
import { recommend } from "./recommender.ts";
import { updateWorldModel } from "./world-model.ts";
import { profileFromContext, tagsFor } from "./recall.ts";
import { tagSentiment } from "./sentiment-agent.ts";
import { beginSpan, recordTrace } from "./trace.ts";
import type { DealPain, DealVerdict, PainRank, SharedContext, VerdictConfidence } from "./types.ts";

export const DEAL_IDS = ["D001", "D002", "D003", "D004", "D005", "D006", "D007", "D008"] as const;

export type AllDealsResult = {
  deals: {
    dealId: string;
    reason: string;
    confidence: VerdictConfidence;
    crmEvidenceIds: string[];
    pain: DealPain;
    messages: SharedContext["messages"];
  }[];
  ranking: PainRank[];
};

function createContext(dealId: string): SharedContext {
  return {
    dealId,
    evidence: emptyDealEvidence(dealId),
    feedback: [],
    sentimentModel: "",
    sentimentWarning: null,
    sentiments: [],
    journey: null,
    pain: null,
    recommendations: [],
    priorColdContext: null,
    worldModel: null,
    rootCause: "",
    confidence: "LOW",
    attempts: 0,
    audit: [],
    plan: "",
    recalled: [],
    recallHits: [],
    similarHits: [],
    evidenceIds: [],
    messages: [],
  };
}

function evidenceIdsAfterSleep(
  evidenceIds: string[],
  records: { id: string; derivedFrom?: string[] }[]
): string[] {
  const live = new Set(records.map((record) => record.id));
  const mergedInto = new Map<string, string>();
  for (const record of records) {
    for (const parentId of record.derivedFrom ?? []) {
      if (!live.has(parentId)) mergedInto.set(parentId, record.id);
    }
  }
  const resolved = evidenceIds.map((id) => {
    let current = id;
    const seen = new Set<string>();
    while (!live.has(current) && mergedInto.has(current) && !seen.has(current)) {
      seen.add(current);
      current = mergedInto.get(current)!;
    }
    return current;
  });
  const unique: string[] = [];
  const seenIds = new Set<string>();
  for (const id of resolved) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    unique.push(id);
  }
  return unique;
}

function feedbackPhrase(count: number): string {
  return count === 1 ? "1 feedback item" : `${count} feedback items`;
}

function feedbackIds(ctx: SharedContext): string[] {
  return ctx.feedback.map((item) => item.id);
}

async function handoff(
  dealId: string,
  from: string,
  to: string,
  work: () => Promise<void>,
  done: () => { summary: string; evidenceIds: string[] }
): Promise<void> {
  const span = beginSpan({ dealId, from, to, kind: "handoff" });
  try {
    await work();
    const update = done();
    span.finish(update);
  } catch (err) {
    span.finish({ summary: "failed", evidenceIds: [] });
    throw err;
  }
}

async function passDownstream(ctx: SharedContext): Promise<void> {
  await handoff(ctx.dealId, "Feedback Aggregator", "Sentiment Agent", () => tagSentiment(ctx), () => ({
    summary: feedbackPhrase(ctx.feedback.length),
    evidenceIds: feedbackIds(ctx),
  }));
  await handoff(ctx.dealId, "Sentiment Agent", "Journey Mapper", () => applyJourney(ctx), () => ({
    summary: ctx.journey
      ? `${ctx.journey.stage}, ${ctx.journey.negativeTurn ? `negative turn ${ctx.journey.negativeTurn.id}` : "no negative turn"}`
      : "no journey",
    evidenceIds: ctx.journey?.negativeTurn ? [ctx.journey.negativeTurn.id] : [],
  }));
  await handoff(ctx.dealId, "Journey Mapper", "Pain Detector", () => detectPain(ctx), () => ({
    summary: ctx.pain && ctx.pain.tags.length > 0 ? `tags ${ctx.pain.tags.map((tag) => tag.tag).join(", ")}` : "no pain tags",
    evidenceIds: ctx.pain?.tags.flatMap((tag) => tag.evidenceIds) ?? [],
  }));
}

function toVerdict(ctx: SharedContext): DealVerdict {
  if (!ctx.journey || !ctx.pain || !ctx.worldModel) throw new Error("agent pipeline did not fill the shared context");
  return {
    reason: ctx.rootCause,
    crm: crmRecord(ctx.evidence),
    confidence: ctx.confidence,
    evidenceIds: ctx.evidenceIds,
    plan: ctx.plan,
    recalled: ctx.recalled,
    attempts: ctx.attempts,
    audit: ctx.audit,
    feedback: ctx.feedback,
    sentimentModel: ctx.sentimentModel,
    sentimentWarning: ctx.sentimentWarning,
    sentiments: ctx.sentiments,
    journey: ctx.journey,
    pain: ctx.pain,
    recommendations: ctx.recommendations,
    priorColdContext: ctx.priorColdContext,
    worldModel: ctx.worldModel,
    messages: ctx.messages,
    recallHits: ctx.recallHits,
    similarHits: ctx.similarHits,
  };
}

export async function whyDidDealGoCold(dealId: string): Promise<DealVerdict> {
  const ctx = createContext(dealId);
  await handoff(dealId, "Orchestrator", "Feedback Aggregator", () => aggregate(ctx), () => ({
    summary: `${feedbackPhrase(ctx.feedback.length)}, ${ctx.confidence}`,
    evidenceIds: feedbackIds(ctx),
  }));
  await passDownstream(ctx);
  if (ctx.pain?.widenRequested) {
    recordTrace({
      dealId,
      from: "Pain Detector",
      to: "Feedback Aggregator",
      kind: "widen request",
      summary: `no pain tags for ${dealId}`,
      evidenceIds: [],
      durationMs: 0,
    });
    const started = Date.now();
    const result = await widen(ctx);
    ctx.messages.push({
      from: "feedback-aggregator",
      to: "pain-detector",
      kind: result.widened ? "widen-result" : "widen-refused",
      detail: result.detail,
    });
    recordTrace({
      dealId,
      from: "Feedback Aggregator",
      to: "Pain Detector",
      kind: result.widened ? "result" : "widen refused",
      summary: result.detail,
      evidenceIds: feedbackIds(ctx),
      durationMs: Date.now() - started,
    });
    if (result.widened) await passDownstream(ctx);
  }
  await handoff(dealId, "Pain Detector", "Recommender", () => recommend(ctx), () => ({
    summary: `${ctx.recommendations.length === 1 ? "1 recommendation" : `${ctx.recommendations.length} recommendations`}, ${ctx.confidence}`,
    evidenceIds: ctx.recommendations.flatMap((item) => item.evidenceIds),
  }));
  await updateWorldModel(ctx);
  recordTrace({
    dealId,
    from: "Recommender",
    to: "Orchestrator",
    kind: "result",
    summary: ctx.confidence,
    evidenceIds: ctx.evidenceIds,
    durationMs: 0,
  });

  const verdict = toVerdict(ctx);
  await sleep();
  const records = await listRecords();
  verdict.evidenceIds = evidenceIdsAfterSleep(verdict.evidenceIds, records);
  const evidenceIdSet = new Set(verdict.evidenceIds);
  verdict.recalled = evidenceIdsAfterSleep(verdict.recalled, records).filter((id) => !evidenceIdSet.has(id));
  await writeEvent({
    dealId,
    type: "verdict",
    payload: verdict,
    confidence: verdict.confidence === "HIGH" ? 0.9 : verdict.confidence === "MEDIUM" ? 0.7 : 0.4,
    tags: tagsFor(profileFromContext(ctx)),
  });
  return verdict;
}

export async function runAllDeals(): Promise<AllDealsResult> {
  const deals: AllDealsResult["deals"] = [];
  const pains: DealPain[] = [];
  for (const dealId of DEAL_IDS) {
    const verdict = await whyDidDealGoCold(dealId);
    pains.push(verdict.pain);
    deals.push({
      dealId,
      reason: verdict.reason,
      confidence: verdict.confidence,
      crmEvidenceIds: verdict.evidenceIds.filter((id) => !id.startsWith("mem-")),
      pain: verdict.pain,
      messages: verdict.messages,
    });
  }
  return { deals, ranking: rankPain(pains) };
}
