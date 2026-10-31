import { describe, expect, it } from "vitest";
import {
  flattenExposures,
  validateExposureGraph,
} from "../src/server/exposure.js";
import type { Exposure } from "../src/shared/types.js";

const leaf = (
  name: string,
  weight: string,
  overrides: Partial<Exposure> = {},
): Exposure => ({
  name,
  weight,
  basis: "net_assets",
  kind: "fund",
  reportDate: "2026-09-30",
  sourceUrl: "https://www.efundcf.com.cn/test",
  ...overrides,
});

describe("look-through accounting", () => {
  it("keeps NAV holdings distinct from total-assets allocation", () => {
    const graph = [
      leaf("基金投资", "88.34", { basis: "total_assets", kind: "asset_class" }),
      leaf("Fund A", "60"),
      leaf("Fund B", "30.35"),
    ];
    const result = validateExposureGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basis: "net_assets",
          reportedWeight: "90.35",
          unreportedWeight: "9.65",
        }),
        expect.objectContaining({
          basis: "total_assets",
          reportedWeight: "88.34",
          unreportedWeight: "11.66",
        }),
      ]),
    );
    expect(flattenExposures(graph)).toHaveLength(2);
  });
  it("multiplies matching denominators and preserves unknown portions", () => {
    const graph = [leaf("FOF", "50", { children: [leaf("Gold ETF", "80")] })];
    const flat = flattenExposures(graph);
    expect(flat.find((x) => x.name === "Gold ETF")?.effectiveWeight).toBe("40");
    expect(flat.find((x) => x.kind === "unreported")?.effectiveWeight).toBe(
      "10",
    );
  });
  it("refuses implicit NAV to total-assets conversion", () => {
    const graph = [
      leaf("FOF", "50", {
        children: [leaf("Gold", "80", { basis: "total_assets" })],
      }),
    ];
    expect(
      validateExposureGraph(graph).issues.some((x) => x.code === "mixed_basis"),
    ).toBe(true);
    const flat = flattenExposures(graph);
    expect(flat[0].effectiveWeight).toBeUndefined();
    expect(flat[0].unresolved).toContain("分母");
  });
  it("detects cycles, duplicate instruments and inconsistent reporting periods", () => {
    const cycle = leaf("Cycle", "100");
    cycle.children = [cycle];
    expect(validateExposureGraph([cycle]).valid).toBe(false);
    expect(
      flattenExposures([cycle]).some((x) => x.unresolved === "循环引用"),
    ).toBe(true);
    expect(
      validateExposureGraph([leaf("A", "10"), leaf("A", "10")]).valid,
    ).toBe(false);
    expect(
      validateExposureGraph([
        leaf("Parent", "50", {
          children: [leaf("Child", "100", { reportDate: "2026-06-30" })],
        }),
      ]).issues.some((x) => x.code === "mixed_dates"),
    ).toBe(true);
  });
  it("never normalizes a leveraged or incomplete report to 100%", () => {
    const result = validateExposureGraph([leaf("A", "110")]);
    expect(result.coverage[0].reportedWeight).toBe("110");
    expect(result.coverage[0].unreportedWeight).toBeNull();
    expect(result.issues.some((x) => x.code === "over_100")).toBe(true);
    expect(validateExposureGraph([leaf("Bad", "NaN")]).valid).toBe(false);
    expect(
      validateExposureGraph([
        leaf("Impossible date", "10", { reportDate: "2026-02-30" }),
      ]).valid,
    ).toBe(false);
  });
});
