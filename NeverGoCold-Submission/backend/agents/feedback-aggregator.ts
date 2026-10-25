import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getZetarisToken } from "../zetaris-auth.ts";
import { zetarisPost } from "../zetarisAuth.ts";
import { writeEvent, type MemoryEvent } from "./memory.ts";
import { profileFromContext, recallScored, recallTraceSummary } from "./recall.ts";
import { recordTrace } from "./trace.ts";
import { recallPriorColdContext } from "./world-model.ts";
import type {
  AttemptAudit,
  CallNoteEvidence,
  ContactEvidence,
  CrmRecord,
  DealEvidence,
  EmailEvidence,
  FeedbackItem,
  SharedContext,
  SourceCounts,
  SourceName,
  VerdictConfidence,
} from "./types.ts";

type CrmRow = Record<string, unknown>;

type LoggedQuery = {
  source: SourceName;
  sql: string;
  rows: number;
  note?: string;
};

type AggregatorRun = {
  written: Set<string>;
  searchGaps: string[];
  missing: Set<string>;
  strength: "STRONG" | "WEAK";
  memories: MemoryEvent[];
};

export type WidenResult = {
  widened: boolean;
  attempt: number | null;
  queries: string[];
  rowsFound: SourceCounts | null;
  detail: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");

const SAFE_SQL_VALUE = /^[A-Za-z0-9_@.-]+$/;

const runs = new WeakMap<SharedContext, AggregatorRun>();

function assertSqlValue(value: string): string {
  if (!SAFE_SQL_VALUE.test(value)) {
    throw new Error("refusing unsafe SQL value");
  }
  return value;
}

function cell(row: CrmRow, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function byDateDesc(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

const SAMPLE_FILES: Record<string, string> = {
  "dealtrace_crm.deals": "deals.json",
  "contact.contact": "contacts.json",
  "emails.emails": "emails.json",
  "call_note.call_note": "call_notes.json",
};

const sampleCache = new Map<string, CrmRow[]>();

function loadSample(file: string): CrmRow[] {
  const cached = sampleCache.get(file);
  if (cached) return cached;
  const raw = fs.readFileSync(path.join(dataDir, file), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`sample file ${file} is not a row array`);
  const rows = parsed as CrmRow[];
  sampleCache.set(file, rows);
  return rows;
}

function matchesSampleWhere(row: CrmRow, where: string): boolean {
  const party = /^`from` = '([^']*)' OR `to` = '([^']*)'$/.exec(where);
  if (party) return cell(row, "from") === party[1] || cell(row, "to") === party[2];
  const equal = /^(`?[A-Za-z0-9_]+`?) = '([^']*)'$/.exec(where);
  if (!equal) throw new Error("sample mode does not support this filter");
  return cell(row, equal[1].replace(/`/g, "")) === equal[2];
}

function sampleSelect(select: string): CrmRow[] {
  const sql = select.replace(/\s+/g, " ").trim();
  const parsed = /^SELECT \* FROM ([A-Za-z0-9_.]+)(?: WHERE (.+?))?(?: ORDER BY date DESC)?$/i.exec(sql);
  if (!parsed) throw new Error("sample mode does not support this query");
  const file = SAMPLE_FILES[parsed[1]];
  if (!file) throw new Error("sample mode does not support this table");
  let rows = loadSample(file);
  if (parsed[2]) rows = rows.filter((row) => matchesSampleWhere(row, parsed[2]));
  if (/ORDER BY date DESC$/i.test(sql)) {
    rows = [...rows].sort((left, right) => byDateDesc(cell(left, "date"), cell(right, "date")));
  }
  return rows;
}

async function runSelect(select: string): Promise<CrmRow[]> {
  if (process.env.SAMPLE_MODE === "true") return sampleSelect(select);
  await getZetarisToken();
  const res = await zetarisPost("/query/sql/start", { select, pageLimit: 100 });
  if (!res.ok) {
    const text = (await res.text()).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]");
    throw new Error(`zetaris query failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { records?: CrmRow[] };
  return Array.isArray(body.records) ? body.records : [];
}

const ATTEMPT_STRATEGIES = [
  "Deal row, contact by contact_id, all emails for the deal, call notes for the deal",
  "All emails for the deal regardless of date, plus emails whose from or to matches the deal contact email",
  "Other contacts at the same company and their emails, plus call notes matched by company name when that column exists",
];

const MAX_ATTEMPTS = 3;

const CALL_NOTE_COMPANY_COLUMNS = ["company", "company_name"];

const STATUS_EXPLANATION: Record<string, RegExp> = {
  lost: /another provider|decided to go with|better fits|declin|not moving forward|went with|chose another|no longer/i,
  won: /signed|kickoff|purchase order|closed[- ]won/i,
  stalled: /no response|on hold|paused|circle back|stall|went cold|reallocat/i,
};

function emptyCounts(): SourceCounts {
  return { deals: 0, contacts: 0, emails: 0, callNotes: 0 };
}

export function emptyDealEvidence(dealId: string): DealEvidence {
  return {
    dealId,
    companyName: "",
    status: "",
    stage: "",
    lastActivityDate: "",
    dealValue: "",
    contactId: "",
    emails: [],
    callNotes: [],
    contacts: [],
  };
}

function mapEmail(row: CrmRow): EmailEvidence {
  return {
    id: cell(row, "email_id"),
    subject: cell(row, "subject"),
    from: cell(row, "from"),
    to: cell(row, "to"),
    sentAt: cell(row, "date"),
    body: cell(row, "body"),
  };
}

function mapNote(row: CrmRow): CallNoteEvidence {
  return {
    id: cell(row, "note_id"),
    date: cell(row, "date"),
    note: cell(row, "summary"),
  };
}

export function crmRecord(evidence: DealEvidence): CrmRecord {
  const contact = evidence.contacts.find((item) => item.id === evidence.contactId) ?? evidence.contacts[0];
  return {
    deal_id: evidence.dealId,
    company_name: evidence.companyName,
    contact_id: evidence.contactId,
    contact_name: contact?.name ?? "",
    contact_email: contact?.email ?? "",
    contact_role: contact?.role ?? "",
    stage: evidence.stage,
    status: evidence.status,
    last_activity_date: evidence.lastActivityDate,
    deal_value: evidence.dealValue,
  };
}

function mapContact(row: CrmRow): ContactEvidence {
  return {
    id: cell(row, "contact_id"),
    name: cell(row, "name"),
    role: cell(row, "role"),
    email: cell(row, "email"),
  };
}

function mergeById<T extends { id: string }>(current: T[], extra: T[], compare?: (left: T, right: T) => number): T[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of extra) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return compare ? merged.sort(compare) : merged;
}

async function selectLogged(source: SourceName, sql: string, logs: LoggedQuery[], note?: string): Promise<CrmRow[]> {
  const rows = await runSelect(sql);
  logs.push({ source, sql, rows: rows.length, note });
  return rows;
}

function formatQuery(query: LoggedQuery): string {
  const count = `${query.rows} ${query.rows === 1 ? "row" : "rows"}`;
  const suffix = query.note ? `; ${query.note}` : "";
  return `${query.sql} (${count}${suffix})`;
}

function dealEmailSql(dealId: string): string {
  const id = assertSqlValue(dealId);
  return `SELECT * FROM emails.emails WHERE deal_id = '${id}' ORDER BY date DESC`;
}

function partyEmailSql(address: string): string {
  const safe = assertSqlValue(address);
  return "SELECT * FROM emails.emails WHERE `from` = '" + safe + "' OR `to` = '" + safe + "'";
}

function daysBefore(evidenceDate: string, activityDate: string): number | null {
  const evidence = /^(\d{4})-(\d{2})-(\d{2})$/.exec(evidenceDate);
  const activity = /^(\d{4})-(\d{2})-(\d{2})$/.exec(activityDate);
  if (!evidence || !activity) return null;
  const evidenceUtc = Date.UTC(Number(evidence[1]), Number(evidence[2]) - 1, Number(evidence[3]));
  const activityUtc = Date.UTC(Number(activity[1]), Number(activity[2]) - 1, Number(activity[3]));
  return Math.round((activityUtc - evidenceUtc) / 86_400_000);
}

function explainingRecord(evidence: DealEvidence): { kind: string; id: string; text: string } | undefined {
  const pattern = STATUS_EXPLANATION[evidence.status.toLowerCase()];
  if (!pattern) return undefined;
  for (const email of evidence.emails) {
    if (pattern.test(email.body)) return { kind: "email", id: email.id, text: email.body };
  }
  for (const note of evidence.callNotes) {
    if (pattern.test(note.note)) return { kind: "call note", id: note.id, text: note.note };
  }
  return undefined;
}

function judgeEvidence(evidence: DealEvidence): { strength: "STRONG" | "WEAK"; why: string; missing: string[] } {
  const missing: string[] = [];
  const why: string[] = [];
  if (evidence.emails.length === 0 && evidence.callNotes.length === 0) {
    missing.push(`emails for deal ${evidence.dealId}`);
    missing.push(`call notes for deal ${evidence.dealId}`);
    why.push(`no emails and no call notes for ${evidence.dealId}`);
  }

  const dated: { kind: string; id: string; date: string }[] = [];
  if (evidence.emails[0]) dated.push({ kind: "email", id: evidence.emails[0].id, date: evidence.emails[0].sentAt });
  if (evidence.callNotes[0]) dated.push({ kind: "call note", id: evidence.callNotes[0].id, date: evidence.callNotes[0].date });
  let newestGap: number | undefined;
  let badDate = false;
  for (const item of dated) {
    const gap = daysBefore(item.date, evidence.lastActivityDate);
    if (gap == null) {
      badDate = true;
      why.push(`${item.kind} ${item.id} date ${item.date} cannot be compared with last_activity_date ${evidence.lastActivityDate}`);
      continue;
    }
    why.push(`${item.kind} ${item.id} date ${item.date} is ${gap} ${gap === 1 ? "day" : "days"} before last_activity_date ${evidence.lastActivityDate}`);
    if (newestGap == null || gap < newestGap) newestGap = gap;
  }
  if (badDate) {
    missing.push(`a YYYY-MM-DD date on the latest email or call note for ${evidence.dealId}`);
  } else if (newestGap != null && newestGap > 30) {
    missing.push(`an email or call note within 30 days before last_activity_date ${evidence.lastActivityDate}`);
  }

  const status = evidence.status.toLowerCase();
  if (status === "lost" || status === "won" || status === "stalled") {
    const explained = explainingRecord(evidence);
    if (!explained) {
      missing.push(`email or call note text that states why status is ${evidence.status}`);
      why.push(`status ${evidence.status} has no email body or call note summary that states a reason`);
    } else {
      why.push(`status ${evidence.status} is stated in ${explained.kind} ${explained.id}: ${explained.text}`);
    }
  } else if (evidence.status) {
    why.push(`status ${evidence.status} is not lost, won, or stalled`);
  }

  return {
    strength: missing.length === 0 ? "STRONG" : "WEAK",
    why: why.join(". ").replace(/\.\. /g, ". "),
    missing,
  };
}

async function queryZetaris(dealId: string): Promise<{ evidence: DealEvidence; logs: LoggedQuery[] }> {
  const id = assertSqlValue(dealId);
  const logs: LoggedQuery[] = [];
  const evidence = emptyDealEvidence(id);
  const deals = await selectLogged("deals", `SELECT * FROM dealtrace_crm.deals WHERE deal_id = '${id}'`, logs);
  const deal = deals[0];
  if (!deal) return { evidence, logs };

  evidence.dealId = cell(deal, "deal_id");
  evidence.companyName = cell(deal, "company_name");
  evidence.status = cell(deal, "status");
  evidence.stage = cell(deal, "stage");
  evidence.lastActivityDate = cell(deal, "last_activity_date");
  evidence.dealValue = cell(deal, "deal_value");
  evidence.contactId = cell(deal, "contact_id");

  if (SAFE_SQL_VALUE.test(evidence.contactId)) {
    const contactId = assertSqlValue(evidence.contactId);
    const contacts = await selectLogged("contacts", `SELECT * FROM contact.contact WHERE contact_id = '${contactId}'`, logs);
    evidence.contacts = contacts.map(mapContact);
  } else if (evidence.contactId) {
    logs.push({
      source: "contacts",
      sql: "SELECT * FROM contact.contact WHERE contact_id = <rejected>",
      rows: 0,
      note: "contact_id failed ^[A-Za-z0-9_@.-]+$",
    });
  }

  const emailRows = await selectLogged("emails", dealEmailSql(id), logs);
  evidence.emails = emailRows.map(mapEmail).sort((a, b) => byDateDesc(a.sentAt, b.sentAt));
  const noteRows = await selectLogged("callNotes", `SELECT * FROM call_note.call_note WHERE deal_id = '${id}' ORDER BY date DESC`, logs);
  evidence.callNotes = noteRows.map(mapNote).sort((a, b) => byDateDesc(a.date, b.date));
  return { evidence, logs };
}

async function widenByContactEmail(evidence: DealEvidence): Promise<{ emails: EmailEvidence[]; logs: LoggedQuery[]; absent: string[] }> {
  const logs: LoggedQuery[] = [];
  const absent: string[] = [];
  const id = assertSqlValue(evidence.dealId);
  const dealRows = await selectLogged("emails", dealEmailSql(id), logs);
  let emails = dealRows.map(mapEmail);
  const address = evidence.contacts[0]?.email ?? "";
  if (!address) {
    absent.push(`contact email for ${evidence.contactId || evidence.dealId}`);
    logs.push({ source: "emails", sql: "SELECT * FROM emails.emails WHERE `from` = <contact email> OR `to` = <contact email>", rows: 0, note: "deal contact has no email" });
  } else if (!SAFE_SQL_VALUE.test(address)) {
    absent.push("contact email failed ^[A-Za-z0-9_@.-]+$");
    logs.push({ source: "emails", sql: "SELECT * FROM emails.emails WHERE `from` = <rejected> OR `to` = <rejected>", rows: 0, note: "contact email failed ^[A-Za-z0-9_@.-]+$" });
  } else {
    const partyRows = await selectLogged("emails", partyEmailSql(address), logs);
    const partyEmails = partyRows.map(mapEmail);
    if (partyEmails.length === 0) absent.push(`emails from or to ${address}`);
    emails = mergeById(emails, partyEmails, (left, right) => byDateDesc(left.sentAt, right.sentAt));
  }
  return { emails, logs, absent };
}

async function widenByCompany(evidence: DealEvidence): Promise<{ contacts: ContactEvidence[]; emails: EmailEvidence[]; notes: CallNoteEvidence[]; logs: LoggedQuery[]; absent: string[] }> {
  const logs: LoggedQuery[] = [];
  const absent: string[] = [];
  const contactRows = await selectLogged(
    "contacts",
    "SELECT * FROM contact.contact",
    logs,
    evidence.companyName
      ? "company filter applied in memory on column company"
      : "deal company_name is empty"
  );
  const others = evidence.companyName
    ? contactRows
        .filter((row) => cell(row, "company") === evidence.companyName && cell(row, "contact_id") !== evidence.contactId)
        .map(mapContact)
    : [];
  if (evidence.companyName && others.length === 0) absent.push(`other contacts with company ${evidence.companyName}`);

  let emails: EmailEvidence[] = [];
  for (const contact of others) {
    if (!SAFE_SQL_VALUE.test(contact.email)) {
      logs.push({ source: "emails", sql: "SELECT * FROM emails.emails WHERE `from` = <rejected> OR `to` = <rejected>", rows: 0, note: `contact ${contact.id} email failed ^[A-Za-z0-9_@.-]+$` });
      continue;
    }
    const rows = await selectLogged("emails", partyEmailSql(contact.email), logs);
    emails = mergeById(emails, rows.map(mapEmail), (left, right) => byDateDesc(left.sentAt, right.sentAt));
  }

  const noteRows = await selectLogged("callNotes", "SELECT * FROM call_note.call_note", logs, "read columns before any company filter");
  const columns = Object.keys(noteRows[0] ?? {});
  const companyColumn = CALL_NOTE_COMPANY_COLUMNS.find((name) => columns.includes(name) && SAFE_SQL_VALUE.test(name)) ?? null;
  let notes: CallNoteEvidence[] = [];
  if (!companyColumn) {
    logs[logs.length - 1].note = `columns ${columns.join(", ") || "none"}. No company column, so no company call-note filter`;
    absent.push(`call notes by company name. call_note.call_note columns are ${columns.join(", ") || "none"}`);
  } else if (!SAFE_SQL_VALUE.test(evidence.companyName)) {
    notes = noteRows.filter((row) => cell(row, companyColumn) === evidence.companyName).map(mapNote);
    logs[logs.length - 1].note = `column ${companyColumn} filtered in memory because company_name failed ^[A-Za-z0-9_@.-]+$. Matched ${notes.length}`;
    if (notes.length === 0) absent.push(`call notes with ${companyColumn} ${evidence.companyName}`);
  } else {
    const sql = `SELECT * FROM call_note.call_note WHERE ${assertSqlValue(companyColumn)} = '${assertSqlValue(evidence.companyName)}' ORDER BY date DESC`;
    const matched = await selectLogged("callNotes", sql, logs);
    notes = matched.map(mapNote);
    if (notes.length === 0) absent.push(`call notes with ${companyColumn} ${evidence.companyName}`);
  }

  return { contacts: others, emails, notes, logs, absent };
}

function gapStillOpen(evidence: DealEvidence, gap: string): boolean {
  const party = /^emails from or to (.+)$/.exec(gap);
  if (party) {
    const address = party[1];
    return !evidence.emails.some((email) => email.from === address || email.to === address);
  }
  if (gap.startsWith("other contacts with company ") && evidence.contacts.length > 1) return false;
  return true;
}

function reasonForMissing(evidence: DealEvidence, missing: string[]): string {
  const parts = [
    `${evidence.companyName} (${evidence.dealId}) status ${evidence.status}, stage ${evidence.stage}, last_activity_date ${evidence.lastActivityDate}`,
  ];
  const contact = evidence.contacts[0];
  if (contact) parts.push(`Contact: ${contact.name}, ${contact.role}`);
  parts.push(`Missing: ${missing.join(", ")}`);
  return parts.join(". ").replace(/\.\. /g, ". ");
}

function reasonFromEvidence(evidence: DealEvidence): string {
  const parts = [
    `${evidence.companyName} (${evidence.dealId}) status ${evidence.status}, stage ${evidence.stage}, last_activity_date ${evidence.lastActivityDate}`,
  ];
  const latest = evidence.emails[0];
  if (latest) {
    parts.push(
      `Latest email ${latest.id} (${latest.sentAt}) from ${latest.from}, subject ${latest.subject}: ${latest.body}`
    );
  }
  const contact = evidence.contacts[0];
  if (contact) {
    parts.push(`Contact: ${contact.name}, ${contact.role}`);
  }
  for (const note of evidence.callNotes) {
    parts.push(`Call note ${note.id} (${note.date}): ${note.note}`);
  }
  return parts.join(". ").replace(/\.\. /g, ". ");
}

export function toFeedback(evidence: DealEvidence): FeedbackItem[] {
  const items: FeedbackItem[] = [
    ...evidence.emails.map((email) => ({
      id: email.id,
      deal_id: evidence.dealId,
      date: email.sentAt,
      source: "email" as const,
      text: email.body,
    })),
    ...evidence.callNotes.map((note) => ({
      id: note.id,
      deal_id: evidence.dealId,
      date: note.date,
      source: "call_note" as const,
      text: note.note,
    })),
  ];
  items.sort((left, right) => {
    if (left.date === right.date) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    return left.date < right.date ? -1 : 1;
  });
  return items;
}

function finishReason(ctx: SharedContext, run: AggregatorRun): void {
  const confidence: VerdictConfidence = run.strength === "STRONG" ? (ctx.attempts === 1 ? "HIGH" : "MEDIUM") : "LOW";
  ctx.confidence = confidence;
  ctx.rootCause = run.strength === "STRONG" ? reasonFromEvidence(ctx.evidence) : reasonForMissing(ctx.evidence, [...run.missing]);
}

async function runAttempt(
  ctx: SharedContext,
  run: AggregatorRun
): Promise<{ attempt: number; strategy: string; queries: string[]; rowsFound: SourceCounts }> {
  const started = Date.now();
  ctx.attempts += 1;
  const attempt = ctx.attempts;
  const dealId = ctx.dealId;
  const strategy = ATTEMPT_STRATEGIES[attempt - 1];
  ctx.plan = `Attempt ${attempt}: ${strategy}`;
  await writeEvent({
    dealId,
    type: "plan",
    payload: ctx.plan,
    confidence: 0.7,
  });

  const logs: LoggedQuery[] = [];
  const incorporated = emptyCounts();
  const absent: string[] = [];

  if (attempt === 1) {
    const fetched = await queryZetaris(dealId);
    ctx.evidence = fetched.evidence;
    logs.push(...fetched.logs);
    incorporated.deals = ctx.evidence.companyName || ctx.evidence.status ? 1 : 0;
    incorporated.contacts = ctx.evidence.contacts.length;
    incorporated.emails = ctx.evidence.emails.length;
    incorporated.callNotes = ctx.evidence.callNotes.length;
  } else if (attempt === 2) {
    const widened = await widenByContactEmail(ctx.evidence);
    logs.push(...widened.logs);
    absent.push(...widened.absent);
    ctx.evidence.emails = mergeById(ctx.evidence.emails, widened.emails, (left, right) => byDateDesc(left.sentAt, right.sentAt));
    incorporated.emails = widened.emails.length;
  } else {
    const widened = await widenByCompany(ctx.evidence);
    logs.push(...widened.logs);
    absent.push(...widened.absent);
    ctx.evidence.contacts = mergeById(ctx.evidence.contacts, widened.contacts);
    ctx.evidence.emails = mergeById(ctx.evidence.emails, widened.emails, (left, right) => byDateDesc(left.sentAt, right.sentAt));
    ctx.evidence.callNotes = mergeById(ctx.evidence.callNotes, widened.notes, (left, right) => byDateDesc(left.date, right.date));
    incorporated.contacts = widened.contacts.length;
    incorporated.emails = widened.emails.length;
    incorporated.callNotes = widened.notes.length;
  }

  const judgment = judgeEvidence(ctx.evidence);
  run.strength = judgment.strength;
  for (const item of absent) {
    if (!run.searchGaps.includes(item)) run.searchGaps.push(item);
  }
  run.missing.clear();
  for (const item of judgment.missing) run.missing.add(item);
  for (const item of run.searchGaps) {
    if (gapStillOpen(ctx.evidence, item)) run.missing.add(item);
  }
  const why = absent.length ? `${judgment.why}. ${absent.join(". ")}` : judgment.why;
  const audit: AttemptAudit = {
    attempt,
    strategy,
    queries: logs.map(formatQuery),
    rowsFound: incorporated,
    judgment: run.strength,
    why: why.replace(/\.\. /g, ". "),
  };
  ctx.audit.push(audit);

  for (const email of ctx.evidence.emails) {
    if (run.written.has(`email:${email.id}`)) continue;
    run.written.add(`email:${email.id}`);
    ctx.evidenceIds.push(
      await writeEvent({
        dealId,
        type: "query",
        payload: `Email ${email.id} (${email.sentAt}) from ${email.from} to ${email.to}, subject ${email.subject}: ${email.body}`,
        confidence: 0.8,
      })
    );
  }
  for (const note of ctx.evidence.callNotes) {
    if (run.written.has(`note:${note.id}`)) continue;
    run.written.add(`note:${note.id}`);
    ctx.evidenceIds.push(
      await writeEvent({
        dealId,
        type: "query",
        payload: `Call note ${note.id} (${note.date}): ${note.note}`,
        confidence: 0.9,
      })
    );
  }
  for (const recordId of [
    ctx.evidence.dealId,
    ctx.evidence.contactId,
    ...ctx.evidence.contacts.map((contact) => contact.id),
    ...ctx.evidence.emails.map((email) => email.id),
    ...ctx.evidence.callNotes.map((note) => note.id),
  ]) {
    if (recordId && !ctx.evidenceIds.includes(recordId)) ctx.evidenceIds.push(recordId);
  }

  const recallStarted = Date.now();
  const hits = await recallScored(profileFromContext(ctx, toFeedback(ctx.evidence).map((item) => item.text)), { topN: 5 });
  ctx.recallHits = hits;
  ctx.recalled = hits.map((hit) => hit.id);
  recordTrace({
    dealId,
    from: "Feedback Aggregator",
    to: "Feedback Aggregator",
    kind: "recall",
    summary: recallTraceSummary(hits),
    evidenceIds: hits.map((hit) => hit.dealId),
    durationMs: Date.now() - recallStarted,
  });
  recordTrace({
    dealId,
    from: "Feedback Aggregator",
    to: "Orchestrator",
    kind: "result",
    summary: `attempt ${attempt} ${run.strength}, emails ${incorporated.emails}, call notes ${incorporated.callNotes}`,
    evidenceIds: ctx.evidenceIds,
    durationMs: Date.now() - started,
  });
  return { attempt, strategy, queries: audit.queries, rowsFound: incorporated };
}

export async function aggregate(ctx: SharedContext): Promise<void> {
  const run: AggregatorRun = {
    written: new Set(),
    searchGaps: [],
    missing: new Set(),
    strength: "WEAK",
    memories: [],
  };
  runs.set(ctx, run);
  ctx.evidence = emptyDealEvidence(assertSqlValue(ctx.dealId));
  ctx.attempts = 0;
  ctx.audit = [];
  ctx.evidenceIds = [];
  ctx.plan = ATTEMPT_STRATEGIES[0];
  ctx.recalled = [];
  ctx.priorColdContext = await recallPriorColdContext(ctx.dealId);
  if (ctx.priorColdContext) {
    recordTrace({
      dealId: ctx.dealId,
      from: "H-MEM",
      to: "Feedback Aggregator",
      kind: "recall",
      summary: `prior cold context from ${ctx.priorColdContext.detectedAt}: ${ctx.priorColdContext.reason}`,
      evidenceIds: [ctx.dealId],
      durationMs: 0,
    });
  }
  while (ctx.attempts < MAX_ATTEMPTS) {
    await runAttempt(ctx, run);
    if (run.strength === "STRONG") break;
  }
  if (ctx.evidenceIds.length === 0) {
    ctx.evidenceIds.push(
      await writeEvent({
        dealId: ctx.dealId,
        type: "query",
        payload: ctx.evidence,
        confidence: 0.8,
      })
    );
  }
  finishReason(ctx, run);
  ctx.feedback = toFeedback(ctx.evidence);
}

export async function widen(ctx: SharedContext): Promise<WidenResult> {
  const run = runs.get(ctx);
  if (!run) throw new Error("feedback aggregator has not run");
  if (ctx.attempts >= MAX_ATTEMPTS) {
    return {
      widened: false,
      attempt: null,
      queries: [],
      rowsFound: null,
      detail: "widen refused, attempt cap is 3",
    };
  }
  const snapshot = {
    rootCause: ctx.rootCause,
    confidence: ctx.confidence,
    attempts: ctx.attempts,
    plan: ctx.plan,
    audit: ctx.audit.slice(),
    recalled: ctx.recalled.slice(),
    evidenceIds: ctx.evidenceIds.slice(),
  };
  const wasStrong = run.strength === "STRONG";
  const outcome = await runAttempt(ctx, run);
  ctx.feedback = toFeedback(ctx.evidence);
  if (wasStrong) {
    ctx.rootCause = snapshot.rootCause;
    ctx.confidence = snapshot.confidence;
    ctx.attempts = snapshot.attempts;
    ctx.plan = snapshot.plan;
    ctx.audit = snapshot.audit;
    ctx.recalled = snapshot.recalled;
    ctx.evidenceIds = snapshot.evidenceIds;
  } else {
    finishReason(ctx, run);
  }
  const rows = outcome.rowsFound;
  return {
    widened: true,
    attempt: outcome.attempt,
    queries: outcome.queries,
    rowsFound: rows,
    detail: `attempt ${outcome.attempt} ran. rows deals ${rows.deals}, contacts ${rows.contacts}, emails ${rows.emails}, callNotes ${rows.callNotes}`,
  };
}
