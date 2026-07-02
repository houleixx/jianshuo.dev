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

  it("a _pending turn (destructive action awaiting confirm) is NOT marked done and broadcasts no updated/reply", async () => {
    // LibraryAgent.runTurn returns {_pending:true} after it stages a delete and
    // broadcasts its own `confirm`. The queue must leave the row 'running' (so
    // drain won't re-pick it) and must NOT emit updated/reply — otherwise the
    // user is told "done" before confirming and the pending is orphaned on reconnect.
    const runTurn = vi.fn(async () => ({ ok: true, _pending: true, reply: "好了" }));
    const { q, store, events } = harness({ runTurn });
    await q.submit({ id: "a", text: "删掉第一篇" });
    await q.drain();
    expect(store.get("a").status).toBe("running"); // not done, not error
    expect(events.some((e) => e.type === "updated")).toBe(false);
    expect(events.some((e) => e.type === "reply")).toBe(false);
    // recover() must flip it back to pending so a DO restart re-stages + re-asks.
    expect(q.recover()).toBe(true);
    expect(store.get("a").status).toBe("pending");
  });

  it("skips the model when the doc already carries this instruction's id (exactly-once)", async () => {
    const { q, store, events, ran } = harness({ loadDoc: async () => ({ lastEditId: "a", articles: [] }) });
    await q.submit({ id: "a", text: "1" });
    await q.drain();
    expect(ran).toEqual([]); // never called runTurn
    expect(store.get("a").status).toBe("done");
    expect(events.filter((e) => e.type === "updated").map((e) => e.id)).toEqual(["a"]);
  });

  it("a throwing loadDoc does not abort the drain — the row still runs", async () => {
    const { q, store, ran } = harness({ loadDoc: async () => { throw new Error("storage down"); } });
    await q.submit({ id: "a", text: "1" });
    await q.drain();
    expect(ran).toEqual(["a"]);
    expect(store.get("a").status).toBe("done");
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

  it("recover returns false when no work is pending", async () => {
    const { q, store } = harness();
    await q.submit({ id: "a", text: "1" });
    await q.drain(); // a -> done
    expect(q.recover()).toBe(false);
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
