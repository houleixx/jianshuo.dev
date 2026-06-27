import { describe, it, expect, vi } from "vitest";
import { ArticleQueue, makeMemStore } from "../src/queue.js";

// Build an ArticleQueue wired to in-memory store + spies. `runTurn` returns a
// canned success unless overridden; it records every row it was asked to run.
function harness({ runTurn, loadDoc } = {}) {
  const store = makeMemStore(() => 1);
  const events = [];
  const ran = [];
  const q = new ArticleQueue({
    store,
    loadDoc: loadDoc || (async () => null),
    broadcast: (m) => events.push(m),
    schedule: () => {},
    runTurn: runTurn || (async (row) => { ran.push(row.id); return { ok: true, reply: "改好了", article: { t: row.id } }; }),
    now: () => 1,
  });
  return { q, store, events, ran };
}

describe("ArticleQueue.submit", () => {
  it("enqueues a new id and replays a known id without a second row", async () => {
    const { q, store } = harness();
    expect(await q.submit({ id: "a", text: "x" })).toEqual({ kind: "enqueued" });
    const again = await q.submit({ id: "a", text: "x" });
    expect(again.kind).toBe("replay");
    expect(store.list().length).toBe(1);
  });
});

describe("ArticleQueue.drain", () => {
  it("drains pending rows in FIFO seq order and marks them done", async () => {
    const { q, store, ran, events } = harness();
    await q.submit({ id: "a", text: "1" });
    await q.submit({ id: "b", text: "2" });
    await q.drain();
    expect(ran).toEqual(["a", "b"]);
    expect(store.get("a").status).toBe("done");
    expect(store.get("b").status).toBe("done");
    expect(events.filter((e) => e.type === "updated").map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("idempotent replay does NOT run the model a second time", async () => {
    const { q, ran } = harness();
    await q.submit({ id: "a", text: "1" });
    await q.drain();
    await q.submit({ id: "a", text: "1" }); // re-send after done
    await q.drain();
    expect(ran).toEqual(["a"]); // ran once
  });

  it("an erroring row is marked error and does NOT block the next row", async () => {
    const runTurn = vi.fn(async (row) =>
      row.id === "a" ? { ok: false, error: "boom" } : { ok: true, reply: "ok", article: {} });
    const { q, store } = harness({ runTurn });
    await q.submit({ id: "a", text: "1" });
    await q.submit({ id: "b", text: "2" });
    await q.drain();
    expect(store.get("a").status).toBe("error");
    expect(store.get("b").status).toBe("done");
  });

  it("skips the model when the doc already carries this instruction's id (exactly-once)", async () => {
    const { q, ran } = harness({ loadDoc: async () => ({ lastEditId: "a", articles: [] }) });
    await q.submit({ id: "a", text: "1" });
    await q.drain();
    expect(ran).toEqual([]); // never called runTurn
  });
});

describe("ArticleQueue.recover + snapshot", () => {
  it("resets a leftover running row to pending and reports work is due", async () => {
    const { q, store } = harness();
    await q.submit({ id: "a", text: "1" });
    store.markRunning("a");
    expect(q.recover()).toBe(true);
    expect(store.get("a").status).toBe("pending");
  });

  it("snapshot lists id+text+status in seq order", async () => {
    const { q } = harness();
    await q.submit({ id: "a", text: "1" });
    await q.submit({ id: "b", text: "2" });
    expect(q.snapshot()).toEqual([
      { id: "a", text: "1", status: "pending" },
      { id: "b", text: "2", status: "pending" },
    ]);
  });
});
