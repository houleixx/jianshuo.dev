import { describe, it, expect } from "vitest";
import { imageCostUY, IMAGE_SUANLI, suanliToUY } from "../src/usage.js";

describe("image pricing", () => {
  it("IMAGE_SUANLI is 4.2", () => { expect(IMAGE_SUANLI).toBe(4.2); });
  it("imageCostUY == suanliToUY(4.2) == 182609 微元", () => {
    expect(imageCostUY()).toBe(suanliToUY(4.2));
    expect(imageCostUY()).toBe(182609);
  });
});
