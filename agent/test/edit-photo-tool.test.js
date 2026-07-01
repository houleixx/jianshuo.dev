import { describe, it, expect } from "vitest";
import { makeEditedKey } from "../src/tools.js";

describe("makeEditedKey", () => {
  it("keeps session dir, new ts, .png", () => {
    expect(makeEditedKey("photos/1719900000/1719900000.jpg", 1719999999))
      .toBe("photos/1719900000/1719999999.png");
  });
  it("falls back to nowMs session when unparseable", () => {
    expect(makeEditedKey("weird", 42)).toBe("photos/42/42.png");
  });
  it("result matches the public /photo key shape after scope prefix", () => {
    const rel = makeEditedKey("photos/abc/def.png", 7);
    expect("users/sub/" + rel).toMatch(/^users\/[^/]+\/photos\/.+\.(jpe?g|png)$/i);
  });
});
