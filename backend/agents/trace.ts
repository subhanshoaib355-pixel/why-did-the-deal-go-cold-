import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TraceKind = "handoff" | "widen request" | "widen refused" | "result" | "recall";

export type TraceEvent = {
  timestamp: string;
  runId: string;
  dealId: string;
  from: string;
  to: string;
  kind: TraceKind;
  summary: string;
  evidenceIds: string[];
  durationMs: number;
};

type OpenRun = {
  runId: string;
  events: TraceEvent[];
};

const logsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");

let active: OpenRun | undefined;

function scrub(value: string): string {
  return value
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b(authorization|password|secret|token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

export function traceEvidenceIds(ids: string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || id.startsWith("mem-") || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}

function runIdFor(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "run";
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp = [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    pad(now.getMilliseconds(), 3),
  ].join("-");
  return `${stamp}-${safe}`;
}

export function hasTrace(): boolean {
  return active != null;
}

export function openTrace(label: string): string {
  if (active) throw new Error("a trace run is already open");
  const runId = runIdFor(label);
  active = { runId, events: [] };
  return runId;
}

export function recordTrace(input: {
  dealId: string;
  from: string;
  to: string;
  kind: TraceKind;
  summary: string;
  evidenceIds: string[];
  durationMs: number;
}): void {
  if (!active) return;
  const summary = scrub(input.summary).trim() || "redacted";
  active.events.push({
    timestamp: new Date().toISOString(),
    runId: active.runId,
    dealId: scrub(input.dealId),
    from: scrub(input.from),
    to: scrub(input.to),
    kind: input.kind,
    summary,
    evidenceIds: traceEvidenceIds(input.evidenceIds),
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0,
  });
}

export function beginSpan(input: { dealId: string; from: string; to: string; kind: TraceKind }): {
  finish(update: { summary: string; evidenceIds: string[]; kind?: TraceKind }): void;
} {
  if (!active) return { finish() {} };
  const event: TraceEvent = {
    timestamp: new Date().toISOString(),
    runId: active.runId,
    dealId: scrub(input.dealId),
    from: scrub(input.from),
    to: scrub(input.to),
    kind: input.kind,
    summary: "",
    evidenceIds: [],
    durationMs: 0,
  };
  active.events.push(event);
  const started = Date.now();
  let closed = false;
  return {
    finish(update) {
      if (closed) return;
      closed = true;
      event.summary = scrub(update.summary).trim() || "redacted";
      event.evidenceIds = traceEvidenceIds(update.evidenceIds);
      event.durationMs = Math.max(0, Date.now() - started);
      if (update.kind) event.kind = update.kind;
    },
  };
}

function clock(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatTraceLine(event: TraceEvent): string {
  const ids = event.evidenceIds.length ? ` [${event.evidenceIds.join(", ")}]` : "";
  return `${clock(event.timestamp)} ${event.from} -> ${event.to}: ${event.summary}${ids} (${event.durationMs} ms)`;
}

export function closeTrace(): { runId: string; timeline: string; events: TraceEvent[] } | null {
  const run = active;
  if (!run) return null;
  active = undefined;
  fs.mkdirSync(logsDir, { recursive: true });
  const jsonl = run.events.map((event) => JSON.stringify(event)).join("\n") + (run.events.length ? "\n" : "");
  const lines = run.events.map(formatTraceLine);
  const markdown = [`# Trace ${run.runId}`, "", ...lines, ""].join("\n");
  fs.writeFileSync(path.join(logsDir, `${run.runId}.jsonl`), jsonl);
  fs.writeFileSync(path.join(logsDir, `${run.runId}.md`), markdown);
  return {
    runId: run.runId,
    timeline: [`trace ${run.runId}`, ...lines].join("\n"),
    events: run.events.map((event) => ({ ...event, evidenceIds: [...event.evidenceIds] })),
  };
}
