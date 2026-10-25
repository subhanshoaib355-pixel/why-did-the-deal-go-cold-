export type SourceName = "deals" | "contacts" | "emails" | "callNotes";

export type SourceCounts = Record<SourceName, number>;

export type AttemptAudit = {
  attempt: number;
  strategy: string;
  queries: string[];
  rowsFound: SourceCounts;
  judgment: "STRONG" | "WEAK";
  why: string;
};

export type VerdictConfidence = "HIGH" | "MEDIUM" | "LOW";

export type EmailEvidence = {
  id: string;
  subject: string;
  from: string;
  to: string;
  sentAt: string;
  body: string;
};

export type CallNoteEvidence = {
  id: string;
  date: string;
  note: string;
};

export type ContactEvidence = {
  id: string;
  name: string;
  role: string;
  email: string;
};

export type DealEvidence = {
  dealId: string;
  companyName: string;
  status: string;
  stage: string;
  lastActivityDate: string;
  dealValue: string;
  contactId: string;
  emails: EmailEvidence[];
  callNotes: CallNoteEvidence[];
  contacts: ContactEvidence[];
};

export type CrmRecord = {
  deal_id: string;
  company_name: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  contact_role: string;
  stage: string;
  status: string;
  last_activity_date: string;
  deal_value: string;
};

export type FeedbackSource = "email" | "call_note";

export type FeedbackItem = {
  id: string;
  deal_id: string;
  date: string;
  source: FeedbackSource;
  text: string;
};

export type SentimentLabel = "positive" | "neutral" | "negative";

export type SentimentTag = {
  id: string;
  deal_id: string;
  label: SentimentLabel;
  tone: string;
  reason: string;
};

export type JourneyStage =
  | "Discovery"
  | "Qualified"
  | "Negotiation"
  | "Proposal Sent"
  | "Closed-Lost"
  | "Closed-Won"
  | "Stalled";

export type LeadTemperature = "hot" | "warm" | "cold" | "frozen";

export type JourneyMap = {
  dealId: string;
  stage: JourneyStage;
  crmStage: string;
  crmStatus: string;
  negativeTurn: { id: string; date: string; source: FeedbackSource } | null;
  activityStoppedAt: string | null;
  activityStopNote: string;
};

export type PainHit = {
  tag: string;
  evidenceIds: string[];
};

export type DealPain = {
  dealId: string;
  tags: PainHit[];
  widenRequested: boolean;
};

export type Recommendation = {
  priority: number;
  action: string;
  evidenceIds: string[];
  memoryContext?: {
    reason: string;
    suggestedAction: string;
    detectedAt: string;
  };
};

export type ColdLeadContext = {
  dealId: string;
  temperature: "cold" | "frozen";
  reason: string;
  suggestedAction: string;
  detectedAt: string;
};

export type WorldModelState = {
  dealId: string;
  crmStatus: string;
  crmStage: string;
  journeyStage: JourneyStage;
  temperature: LeadTemperature;
  lastActivityDate: string;
  reason: string;
  suggestedAction: string;
  updatedAt: string;
};

export type AgentMessage = {
  from: string;
  to: string;
  kind: "widen" | "widen-result" | "widen-refused";
  detail: string;
};

export type MemoryProfile = {
  dealId: string;
  company: string;
  contactName: string;
  contactEmail: string;
  status: string;
  journeyStage: string;
  painTags: string[];
  confidence: string;
};

export type RecallHit = {
  id: string;
  dealId: string;
  type: string;
  summary: string;
  score: number;
  reasons: string[];
  status: string;
  painTags: string[];
  confidence: number;
};

export type SharedContext = {
  dealId: string;
  evidence: DealEvidence;
  feedback: FeedbackItem[];
  sentimentModel: string;
  sentimentWarning: string | null;
  sentiments: SentimentTag[];
  journey: JourneyMap | null;
  pain: DealPain | null;
  recommendations: Recommendation[];
  priorColdContext: ColdLeadContext | null;
  worldModel: WorldModelState | null;
  rootCause: string;
  confidence: VerdictConfidence;
  attempts: number;
  audit: AttemptAudit[];
  plan: string;
  recalled: string[];
  recallHits: RecallHit[];
  similarHits: RecallHit[];
  evidenceIds: string[];
  messages: AgentMessage[];
};

export type DealVerdict = {
  reason: string;
  crm: CrmRecord;
  confidence: VerdictConfidence;
  evidenceIds: string[];
  plan: string;
  recalled: string[];
  attempts: number;
  audit: AttemptAudit[];
  feedback: FeedbackItem[];
  sentimentModel: string;
  sentimentWarning: string | null;
  sentiments: SentimentTag[];
  journey: JourneyMap;
  pain: DealPain;
  recommendations: Recommendation[];
  priorColdContext: ColdLeadContext | null;
  worldModel: WorldModelState;
  messages: AgentMessage[];
  recallHits: RecallHit[];
  similarHits: RecallHit[];
};

export type PainRank = {
  tag: string;
  deals: string[];
  dealCount: number;
  evidenceCount: number;
};
