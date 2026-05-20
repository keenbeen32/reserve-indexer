import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// Smoke test only — full per-handler tests added as handlers are implemented.
describe("DTF indexer smoke", () => {
  it("starts up and processes at least one event on chain 1", async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({ chains: { 1: {} } });
    expect(result.changes.length).toBeGreaterThan(0);
    const firstChange = result.changes[0]!;
    expect(firstChange.chainId).toBe(1);
    expect(firstChange.eventsProcessed).toBeGreaterThan(0);
  }, 60_000);
});
