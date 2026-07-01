import { test } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../src/events.ts";

test("subscribe receives published events", () => {
  const hub = new EventHub();
  const got: any[] = [];
  hub.subscribe("j1", (ev, data) => got.push([ev, data]));
  hub.publish("j1", "progress", { percent: 50 });
  hub.publish("j2", "progress", { percent: 99 }); // other job, ignored
  assert.deepEqual(got, [["progress", { percent: 50 }]]);
});

test("unsubscribe stops delivery", () => {
  const hub = new EventHub();
  const got: any[] = [];
  const off = hub.subscribe("j1", (ev) => got.push(ev));
  off();
  hub.publish("j1", "done", {});
  assert.equal(got.length, 0);
});
