import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const persistDir = mkdtempSync(path.join(tmpdir(), "never-go-cold-hmem-"));
process.env.HMEM_PERSIST_DIR = persistDir;

const [{ whyDidDealGoCold }, { latestEvent }] = await Promise.all([
  import("../agents/orchestrator.ts"),
  import("../agents/memory.ts"),
]);

after(() => rmSync(persistDir, { recursive: true, force: true }));

test("persists cold context and recalls it before the next recommendation", async () => {
  const first = await whyDidDealGoCold("D001");

  assert.equal(first.priorColdContext, null);
  assert.equal(first.worldModel.temperature, "cold");
  assert.equal(first.worldModel.crmStatus, first.crm.status);

  const storedColdContext = await latestEvent<typeof first.priorColdContext>("D001", "cold-detection");
  assert.ok(storedColdContext);
  assert.equal(storedColdContext.reason, first.reason);
  assert.equal(storedColdContext.suggestedAction, first.recommendations[0].action);

  const second = await whyDidDealGoCold("D001");
  assert.deepEqual(second.priorColdContext, storedColdContext);
  assert.deepEqual(second.recommendations[0].memoryContext, {
    reason: storedColdContext.reason,
    suggestedAction: storedColdContext.suggestedAction,
    detectedAt: storedColdContext.detectedAt,
  });

  const latestWorldState = await latestEvent<typeof first.worldModel>("D001", "world-state");
  assert.equal(latestWorldState?.crmStatus, second.crm.status);
  assert.equal(latestWorldState?.temperature, second.worldModel.temperature);
});
