import "./load-env.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHMEM } from "../src/engine.ts";

export type EventType =
  | "query"
  | "verdict"
  | "plan"
  | "sentiment"
  | "journey"
  | "pain"
  | "recommendation"
  | "cold-detection"
  | "world-state";

export interface MemoryEvent {
  id: string;
  dealId: string;
  type: EventType;
  payload: unknown;
  confidence: number;
  timestamp: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const persistDir = process.env.HMEM_PERSIST_DIR || path.join(here, "..", ".deal-memory");

let engine: Promise<{ query: Function; add: Function; sleep: { preview: Function; execute: Function }; store: { all: Function; update: Function }; ledger: { all: Function } }> | undefined;

async function getHmem() {
  if (!engine) {
    engine = loadHMEM().then(({ HMEM }) => new HMEM({ persistDir }));
  }
  return engine;
}

function payloadText(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function isVerdictLineage(record: { tags?: string[]; source?: string; content?: string }): boolean {
  if (record.tags?.includes("event:verdict")) return true;
  if (typeof record.source === "string" && record.source.endsWith(":verdict")) return true;
  const content = record.content ?? "";
  return content.includes('"evidenceIds"') && content.includes('"reason"');
}

function excludedFromRecallAndSleep(record: { tags?: string[]; source?: string; content?: string }): boolean {
  if (isVerdictLineage(record)) return true;
  if (record.source === "sleep:synthesis") return true;
  if (record.tags?.includes("event:cold-detection") || record.tags?.includes("event:world-state")) return true;
  return (record.content ?? "").startsWith("Synthesis:");
}

export async function recall(
  dealId: string,
  query: string,
  topK = 5
): Promise<MemoryEvent[]> {
  const hmem = await getHmem();
  const result = hmem.query(query, { topN: topK, threshold: 0.1, chatId: dealId });
  return result.memories
    .filter((r: { memory: { tags?: string[]; source?: string; content?: string } }) => !excludedFromRecallAndSleep(r.memory))
    .map((r: { memory: { id: string; content: string; confidence: number; timestamp: number; tags?: string[] } }) => ({
    id: r.memory.id,
    dealId,
    type: (r.memory.tags?.find((t) => t.startsWith("event:"))?.slice("event:".length) as EventType) ?? "query",
    payload: r.memory.content,
    confidence: r.memory.confidence,
    timestamp: r.memory.timestamp,
  }));
}

export async function writeEvent(event: Omit<MemoryEvent, "id" | "timestamp"> & { tags?: string[] }): Promise<string> {
  const hmem = await getHmem();
  const extra = (event.tags ?? []).filter((tag) => tag.length > 0 && tag.length < 200 && !/eyJ[A-Za-z0-9_-]+\./.test(tag));
  const record = hmem.add({
    content: payloadText(event.payload),
    source: `deal:${event.dealId}:${event.type}`,
    confidence: event.confidence,
    chatId: event.dealId,
    tags: [...new Set([`deal:${event.dealId}`, `event:${event.type}`, ...extra])],
  });
  return record.id;
}

export async function sleep(): Promise<void> {
  const hmem = await getHmem();
  const before = hmem.store.all() as { id: string; tags?: string[]; source?: string; content?: string }[];
  const blocked = new Set(before.filter((record) => excludedFromRecallAndSleep(record)).map((record) => record.id));
  const preview = hmem.sleep.preview();
  preview.toSynthesize = (preview.toSynthesize as string[][])
    .map((group) => group.filter((id) => !blocked.has(id)))
    .filter((group) => group.length >= 2);
  hmem.sleep.execute(preview);
  const records = hmem.store.all() as { id: string; relatedTo?: string[] }[];
  const live = new Set(records.map((r) => r.id));
  for (const record of records) {
    const related = record.relatedTo ?? [];
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const id of related) {
      if (!live.has(id) || seen.has(id)) continue;
      seen.add(id);
      kept.push(id);
    }
    if (kept.length !== related.length || kept.some((id, i) => id !== related[i])) {
      hmem.store.update(record.id, { relatedTo: kept });
    }
  }
}

export async function audit(dealId: string): Promise<MemoryEvent[]> {
  const hmem = await getHmem();
  return hmem.store
    .all()
    .filter((m: { chatId?: string }) => m.chatId === dealId)
    .map((m: { id: string; content: string; confidence: number; timestamp: number; tags?: string[] }) => ({
      id: m.id,
      dealId,
      type: (m.tags?.find((t) => t.startsWith("event:"))?.slice("event:".length) as EventType) ?? "query",
      payload: m.content,
      confidence: m.confidence,
      timestamp: m.timestamp,
    }));
}

export async function listRecords(): Promise<{ id: string; derivedFrom?: string[] }[]> {
  const hmem = await getHmem();
  return hmem.store.all() as { id: string; derivedFrom?: string[] }[];
}

export type StoredMemory = {
  id: string;
  content: string;
  tags: string[];
  chatId: string;
  source: string;
  confidence: number;
  timestamp: number;
};

export async function listMemories(): Promise<StoredMemory[]> {
  const hmem = await getHmem();
  const records = hmem.store.all() as StoredMemory[];
  return records.map((record) => ({
    id: record.id,
    content: typeof record.content === "string" ? record.content : "",
    tags: Array.isArray(record.tags) ? record.tags : [],
    chatId: record.chatId ?? "",
    source: record.source ?? "",
    confidence: typeof record.confidence === "number" ? record.confidence : 0,
    timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
  }));
}

export async function latestEvent<T>(dealId: string, type: EventType): Promise<T | null> {
  const records = (await listMemories())
    .filter((record) => record.chatId === dealId && record.source === `deal:${dealId}:${type}`)
    .sort((left, right) => right.timestamp - left.timestamp || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
  const latest = records[0];
  if (!latest) return null;
  try {
    return JSON.parse(latest.content) as T;
  } catch (error) {
    throw new Error(`H-MEM event ${latest.id} (${type}) contains invalid JSON`, { cause: error });
  }
}
