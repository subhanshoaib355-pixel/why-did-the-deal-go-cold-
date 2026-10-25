import type { FeedbackItem, JourneyMap, JourneyStage, SharedContext } from "./types.ts";
import { writeEvent } from "./memory.ts";
import { profileFromContext, tagsFor } from "./recall.ts";

const STAGE_BY_STATUS: Record<string, JourneyStage> = {
  lost: "Closed-Lost",
  won: "Closed-Won",
  stalled: "Stalled",
};

const STAGE_BY_CRM: Record<string, JourneyStage> = {
  discovery: "Discovery",
  qualified: "Qualified",
  negotiation: "Negotiation",
  "proposal sent": "Proposal Sent",
  closed: "Closed-Won",
};

export function journeyStageFor(status: string, crmStage: string): JourneyStage {
  return STAGE_BY_STATUS[status.toLowerCase()] ?? STAGE_BY_CRM[crmStage.toLowerCase()] ?? "Discovery";
}

function byDate(left: FeedbackItem, right: FeedbackItem): number {
  if (left.date === right.date) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return left.date < right.date ? -1 : 1;
}

export function mapJourney(ctx: SharedContext): JourneyMap {
  const evidence = ctx.evidence;
  const status = evidence.status.toLowerCase();
  const stage = journeyStageFor(evidence.status, evidence.stage);
  const negative = ctx.sentiments
    .filter((item) => item.label === "negative")
    .map((item) => ctx.feedback.find((feedback) => feedback.id === item.id))
    .filter((item): item is FeedbackItem => item != null)
    .sort(byDate)[0];
  const latest = [...ctx.feedback].sort((left, right) => -byDate(left, right))[0];
  let activityStoppedAt: string | null = null;
  let activityStopNote = "";
  if (status === "lost" || status === "stalled" || status === "won") {
    activityStoppedAt = evidence.lastActivityDate;
    activityStopNote = `status ${evidence.status} at last_activity_date ${evidence.lastActivityDate}`;
  } else if (!latest) {
    activityStoppedAt = evidence.lastActivityDate;
    activityStopNote = `no email or call note before last_activity_date ${evidence.lastActivityDate}`;
  } else {
    activityStopNote = `latest feedback ${latest.id} on ${latest.date}, last_activity_date ${evidence.lastActivityDate}`;
  }
  return {
    dealId: ctx.dealId,
    stage,
    crmStage: evidence.stage,
    crmStatus: evidence.status,
    negativeTurn: negative ? { id: negative.id, date: negative.date, source: negative.source } : null,
    activityStoppedAt,
    activityStopNote,
  };
}

export async function applyJourney(ctx: SharedContext): Promise<void> {
  ctx.journey = mapJourney(ctx);
  await writeEvent({
    dealId: ctx.dealId,
    type: "journey",
    payload: ctx.journey,
    confidence: 0.8,
    tags: tagsFor(profileFromContext(ctx)),
  });
}
