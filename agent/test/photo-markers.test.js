import { describe, it, expect } from "vitest";
import { renderPhotos, stripPhotoMarkers, photoRefsInBodies } from "../../functions/voicedrop/[token].js";

// photoURIs is keyed BOTH by 1-based index (legacy) and relative key (new),
// exactly as loadPhotoURIs builds it.
const URIS = {
  1: "data:img1", 2: "data:img2",
  "photos/s/a.jpg": "data:imgA",
  "photos/s/b.jpg": "data:imgB",
};

describe("renderPhotos — [[photo:<token>]] resolution", () => {
  it("resolves a relative-key token to its own image", () => {
    const out = renderPhotos("<p>[[photo:photos/s/a.jpg]]</p>", URIS);
    expect(out).toContain("data:imgA");
    expect(out).toContain("<figure");
  });

  it("two different key markers render two DIFFERENT images (the core bug)", () => {
    const out = renderPhotos(
      "<p>[[photo:photos/s/b.jpg]]</p><p>[[photo:photos/s/a.jpg]]</p>",
      URIS,
    );
    // Order in the body wins, and each key maps to its own URI — never the same one.
    expect(out.indexOf("data:imgB")).toBeLessThan(out.indexOf("data:imgA"));
    expect(out.match(/data:imgA/g)).toHaveLength(1);
    expect(out.match(/data:imgB/g)).toHaveLength(1);
  });

  it("still honors legacy numeric tokens", () => {
    expect(renderPhotos("<p>[[photo:1]]</p>", URIS)).toContain("data:img1");
    expect(renderPhotos("[[photo:2]]", URIS)).toContain("data:img2");
  });

  it("handles both block (<p>-wrapped) and inline markers", () => {
    expect(renderPhotos("x[[photo:photos/s/a.jpg]]y", URIS)).toContain("data:imgA");
  });

  it("drops a marker whose photo is missing", () => {
    expect(renderPhotos("[[photo:photos/s/zzz.jpg]]", URIS)).not.toContain("<figure");
    expect(renderPhotos("[[photo:9]]", URIS)).not.toContain("<figure");
  });
});

describe("stripPhotoMarkers — both formats", () => {
  it("strips a legacy numeric marker", () => {
    expect(stripPhotoMarkers("a[[photo:1]]b")).toBe("ab");
  });
  it("strips a relative-key marker (slashes + dots)", () => {
    expect(stripPhotoMarkers("a[[photo:photos/s/a.jpg]]b")).toBe("ab");
  });
});

describe("photoRefsInBodies — body is the sole source of truth", () => {
  it("extracts new key tokens in appearance order, no photos array needed", () => {
    const refs = photoRefsInBodies(["a[[photo:photos/s/a.jpg]]b[[photo:photos/s/b.jpg]]c"]);
    expect(refs).toEqual([
      { token: "photos/s/a.jpg", key: "photos/s/a.jpg" },
      { token: "photos/s/b.jpg", key: "photos/s/b.jpg" },
    ]);
  });

  it("resolves legacy numeric tokens via the photos array (old articles)", () => {
    const refs = photoRefsInBodies(["x[[photo:2]]y"], ["photos/s/a.jpg", "photos/s/b.jpg"]);
    expect(refs).toEqual([{ token: "2", key: "photos/s/b.jpg" }]);
  });

  it("dedupes repeated tokens and spans multiple article bodies", () => {
    const refs = photoRefsInBodies([
      "[[photo:photos/s/a.jpg]]",
      "[[photo:photos/s/a.jpg]] and [[photo:photos/s/c.jpg]]",
    ]);
    expect(refs.map((r) => r.key)).toEqual(["photos/s/a.jpg", "photos/s/c.jpg"]);
  });

  it("drops a legacy index with no array entry", () => {
    expect(photoRefsInBodies(["[[photo:9]]"], [])).toEqual([]);
  });
});
