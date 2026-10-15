import { describe, expect, it } from "vitest";
import { slugId } from "../src/OrgEditor.tsx";

describe("ids made from names", () => {
  it("drops Vietnamese marks and punctuation, and stays unique", () => {
    expect(slugId("Thực đơn mùa thu!", new Set(), "project")).toBe("thuc-don-mua-thu");
    expect(slugId("Đà Lạt", new Set(["da-lat", "da-lat-2"]), "project")).toBe("da-lat-3");
    expect(slugId("  ", new Set(), "team")).toBe("team");
    const long = slugId("a".repeat(80), new Set(), "x");
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/);
  });
});
