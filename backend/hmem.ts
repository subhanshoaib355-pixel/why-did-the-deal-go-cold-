import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEAL_IDS, runAllDeals, whyDidDealGoCold } from "./agents/orchestrator.ts";
import { rankPain } from "./agents/pain-detector.ts";
import { closeTrace, openTrace } from "./agents/trace.ts";
import type { DealVerdict } from "./agents/types.ts";

export type { EventType, MemoryEvent } from "./agents/memory.ts";
export { audit, recall, sleep, writeEvent } from "./agents/memory.ts";
export { runAllDeals, whyDidDealGoCold } from "./agents/orchestrator.ts";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function printResult(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
  const trace = closeTrace();
  if (trace) console.log(`\n${trace.timeline}`);
}

function dealPayload(dealId: string, verdict: DealVerdict) {
  return {
    deal_id: dealId,
    crm: verdict.crm,
    verdict,
    confidence: verdict.confidence,
    sentiment: verdict.sentiments,
    journey: verdict.journey,
    pain: verdict.pain,
    recommendations: verdict.recommendations,
  };
}

function printJson(value: unknown): void {
  const trace = closeTrace();
  const payload = value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : { result: value };
  payload.trace = trace
    ? { runId: trace.runId, timeline: trace.timeline, events: trace.events }
    : null;
  console.log(JSON.stringify(payload));
}

if (isDirectRun()) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--json");
  const jsonMode = process.argv.includes("--json");
  const arg = args[0] ?? "D004";
  openTrace(arg === "all" ? "all" : arg);
  const fail = (err: unknown) => {
    closeTrace();
    console.error(err);
    process.exitCode = 1;
  };
  if (jsonMode && arg === "all") {
    (async () => {
      const deals = [];
      for (const dealId of DEAL_IDS) deals.push(dealPayload(dealId, await whyDidDealGoCold(dealId)));
      printJson({ deal_id: "all", deals, ranking: rankPain(deals.map((deal) => deal.pain)) });
    })().catch(fail);
  } else if (jsonMode) {
    whyDidDealGoCold(arg).then((verdict) => {
      printJson({
        ...dealPayload(arg, verdict),
        ranking: rankPain([verdict.pain]),
      });
    }).catch(fail);
  } else if (arg === "all") {
    console.log("reached all-deals pain ranking");
    runAllDeals().then(printResult).catch(fail);
  } else {
    console.log("reached whyDidDealGoCold call");
    whyDidDealGoCold(arg).then(printResult).catch(fail);
  }
}
