import { describe, it, expect } from "vitest";
import { imageCostUY, IMAGE_SUANLI, suanliToUY } from "../src/usage.js";

describe("image pricing", () => {
  it("IMAGE_SUANLI is 1.8", () => { expect(IMAGE_SUANLI).toBe(1.8); });
  it("imageCostUY == suanliToUY(1.8) == 78261 微元", () => {
    expect(imageCostUY()).toBe(suanliToUY(1.8));
    expect(imageCostUY()).toBe(78261);
  });
});
