import { listMemories, type StoredMemory } from "./memory.ts";
import type { JourneyStage, MemoryProfile, RecallHit, SharedContext } from "./types.ts";

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

function journeyStageFor(status: string, crmStage: string): JourneyStage {
  if (!status && !crmStage) return "Discovery";
  return STAGE_BY_STATUS[status.toLowerCase()] ?? STAGE_BY_CRM[crmStage.toLowerCase()] ?? "Discovery";
}

export const PAIN_RULES: { tag: string; re: RegExp }[] = [
  { tag: "budget", re: /\b(budget|discount|pricing|price)\b/i },
  { tag: "competitor", re: /another provider|other vendors|other vendor|\bcompetitor\b/i },
  { tag: "integration", re: /\bintegrat/i },
  { tag: "timing", re: /next quarter|this quarter|two weeks|\btimeline\b|circle back|\bpause\b/i },
  { tag: "no-response", re: /no response|no answer|left voicemail/i },
  { tag: "legal", re: /\blegal\b/i },
];

const KNOWN_STAGES = ["Discovery", "Qualified", "Negotiation", "Proposal Sent", "Closed-Lost", "Closed-Won", "Stalled"];

function tagValue(tags: string[], key: string): string {
  const prefix = `${key}:`;
  const found = tags.find((tag) => tag.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : "";
}

function tagValues(tags: string[], key: string): string[] {
  const prefix = `${key}:`;
  return tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length).trim()).filter(Boolean);
}

export function painTagsInText(text: string): string[] {
  return PAIN_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.tag);
}

export function tagsFor(profile: MemoryProfile): string[] {
  const tags = [
    `deal:${profile.dealId}`,
    profile.company ? `company:${profile.company}` : "",
    profile.contactName ? `contact:${profile.contactName}` : "",
    profile.contactEmail ? `email:${profile.contactEmail}` : "",
    profile.status ? `status:${profile.status}` : "",
    profile.journeyStage ? `stage:${profile.journeyStage}` : "",
    profile.confidence ? `confidence:${profile.confidence}` : "",
    ...profile.painTags.map((tag) => `pain:${tag}`),
  ];
  return [...new Set(tags.filter((tag) => tag.length > 1 && !/eyJ[A-Za-z0-9_-]+\./.test(tag)))];
}

export function profileFromContext(ctx: SharedContext, texts?: string[]): MemoryProfile {
  const contact = ctx.evidence.contacts[0];
  const painTags = ctx.pain?.tags.map((tag) => tag.tag) ?? painTagsInText((texts ?? ctx.feedback.map((item) => item.text)).join("\n"));
  return {
    dealId: ctx.dealId,
    company: ctx.evidence.companyName,
    contactName: contact?.name ?? "",
    contactEmail: contact?.email ?? "",
    status: ctx.evidence.status,
    journeyStage: ctx.journey?.stage ?? journeyStageFor(ctx.evidence.status, ctx.evidence.stage),
    painTags,
    confidence: ctx.confidence,
  };
}

function confidenceLabel(value: number): string {
  if (value >= 0.85) return "HIGH";
  if (value >= 0.6) return "MEDIUM";
  return "LOW";
}

function deriveProfile(record: StoredMemory): MemoryProfile | null {
  try {
    if (record.source === "sleep:synthesis" || record.content.startsWith("Synthesis:")) return null;
    const tags = record.tags;
    const taggedDeal = tagValue(tags, "deal");
    const chatDeal = /^D\d{3}$/.test(record.chatId) ? record.chatId : "";
    const contentDeal = /\b(D\d{3})\b/.exec(record.content)?.[1] ?? "";
    const dealId = /^D\d{3}$/.test(taggedDeal) ? taggedDeal : chatDeal || contentDeal;
    if (!/^D\d{3}$/.test(dealId)) return null;

    const company = tagValue(tags, "company") || (/([A-Za-z0-9&'. ]{2,}?) \(D\d{3}\)/.exec(record.content)?.[1] ?? "").trim();
    const contactName = tagValue(tags, "contact") || (/Contact: ([^,\n]+)/.exec(record.content)?.[1] ?? "").trim();
    const contactEmail = tagValue(tags, "email") || (/\bfrom ([A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(record.content)?.[1] ?? "");
    const status = (tagValue(tags, "status") || (/\bstatus (lost|won|open|stalled)\b/i.exec(record.content)?.[1] ?? "")).toLowerCase();
    const taggedStage = tagValue(tags, "stage");
    const journeyStage = KNOWN_STAGES.includes(taggedStage) ? taggedStage : (status ? journeyStageFor(status, "") : "");
    const taggedConfidence = tagValue(tags, "confidence").toUpperCase();
    const confidence = taggedConfidence === "HIGH" || taggedConfidence === "MEDIUM" || taggedConfidence === "LOW"
      ? taggedConfidence
      : confidenceLabel(record.confidence);
    const painTags = [...new Set([...tagValues(tags, "pain"), ...painTagsInText(record.content)])];
    return { dealId, company, contactName, contactEmail, status, journeyStage, painTags, confidence };
  } catch {
    return null;
  }
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function scoreProfile(query: MemoryProfile, item: MemoryProfile): { score: number; reasons: string[] } {
  const weighted: { weight: number; text: string }[] = [];
  if (query.dealId && item.dealId === query.dealId) weighted.push({ weight: 1000, text: "same deal" });
  if (query.company && item.company && sameText(query.company, item.company)) weighted.push({ weight: 100, text: "same company" });
  const contact = (query.contactEmail && item.contactEmail && sameText(query.contactEmail, item.contactEmail))
    || (query.contactName && item.contactName && sameText(query.contactName, item.contactName));
  if (contact) weighted.push({ weight: 40, text: "same contact" });
  for (const tag of query.painTags) {
    if (item.painTags.includes(tag)) weighted.push({ weight: 20, text: `shared tag ${tag}` });
  }
  if (query.status && item.status && sameText(query.status, item.status)) {
    weighted.push({ weight: 10, text: `same status ${item.status.toLowerCase()}` });
  }
  weighted.sort((left, right) => right.weight - left.weight || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
  return { score: weighted.reduce((sum, item) => sum + item.weight, 0), reasons: weighted.map((item) => item.text) };
}

function compactSummary(profile: MemoryProfile): string {
  const parts = [profile.dealId, profile.company, profile.status, profile.journeyStage, profile.painTags.join(" "), profile.confidence].filter(Boolean);
  return parts.join(", ").slice(0, 180);
}

function eventType(tags: string[]): string {
  const event = tagValue(tags, "event");
  return event || "query";
}

export async function recallScored(query: MemoryProfile, opts?: { topN?: number; excludeDealId?: string }): Promise<RecallHit[]> {
  const topN = opts?.topN ?? 5;
  const records = await listMemories();
  const hits: (RecallHit & { timestamp: number })[] = [];
  for (const record of records) {
    const profile = deriveProfile(record);
    if (!profile) continue;
    if (opts?.excludeDealId && profile.dealId === opts.excludeDealId) continue;
    const scored = scoreProfile(query, profile);
    if (scored.score <= 0) continue;
    hits.push({
      id: record.id,
      dealId: profile.dealId,
      type: eventType(record.tags),
      summary: compactSummary(profile),
      score: scored.score,
      reasons: scored.reasons,
      status: profile.status,
      painTags: profile.painTags,
      confidence: record.confidence,
      timestamp: record.timestamp,
    });
  }
  hits.sort((left, right) => right.score - left.score || right.timestamp - left.timestamp || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return hits.slice(0, topN).map(({ timestamp: _timestamp, ...hit }) => hit);
}

export function recallTraceSummary(hits: RecallHit[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const hit of hits) {
    const key = `${hit.id}:${hit.dealId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${hit.id} ${hit.dealId} ${hit.reasons.join(", ")}`);
    if (parts.length >= 5) break;
  }
  return parts.join("; ") || "no matching memories";
}
