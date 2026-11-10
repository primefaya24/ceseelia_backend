import { describe, it, expect } from "vitest";

import {
  CA_PROVINCES,
  CA_TAX_RATES,
  canadaTaxComponents,
  normalizePostalCode,
  provinceFromPostalCode,
} from "../layers/core/tax/canada";

const registered = { homeProvince: "ON" as const, gstRegistered: true, provincialRegistrations: [] };

describe("Canadian tax rules (4.4)", () => {
  it("normalizes valid postal codes and refuses anything else", () => {
    expect(normalizePostalCode("k1a0b1")).toBe("K1A 0B1");
    expect(normalizePostalCode(" M5V 3L9 ")).toBe("M5V 3L9");
    expect(normalizePostalCode("V6B-1A1")).toBe("V6B 1A1");
    for (const bad of ["", "12345", "K1A 0B", "D1A 0B1", "W1A 0B1", "K1A 0B1X", "K1A0O1", "<script>", "K1A 0B1".repeat(2)]) {
      expect(normalizePostalCode(bad)).toBeNull();
    }
    expect(normalizePostalCode(12345 as unknown as string)).toBeNull();
  });

  it("finds the province from the first letter", () => {
    expect(provinceFromPostalCode("M5V 3L9")).toBe("ON");
    expect(provinceFromPostalCode("H2X 1Y4")).toBe("QC");
    expect(provinceFromPostalCode("V6B 1A1")).toBe("BC");
    expect(provinceFromPostalCode("T2P 1J9")).toBe("AB");
    expect(provinceFromPostalCode("B3H 1A1")).toBe("NS");
    expect(provinceFromPostalCode("X1A 2P5")).toBe("NT");
    expect(provinceFromPostalCode("90210")).toBeNull();
  });

  it("has a rate entry for every province", () => {
    for (const p of CA_PROVINCES) expect(CA_TAX_RATES[p]).toBeDefined();
  });

  it("charges HST in HST provinces, GST elsewhere, and PST/QST only where registered", () => {
    expect(canadaTaxComponents("ON", registered)).toEqual([{ code: "HST", label: "HST", percent: 13 }]);
    expect(canadaTaxComponents("NS", registered)).toEqual([{ code: "HST", label: "HST", percent: 14 }]);
    expect(canadaTaxComponents("AB", registered)).toEqual([{ code: "GST", label: "GST", percent: 5 }]);
    expect(canadaTaxComponents("BC", registered)).toEqual([{ code: "GST", label: "GST", percent: 5 }]);
    expect(canadaTaxComponents("BC", { ...registered, provincialRegistrations: ["BC"] })).toEqual([
      { code: "GST", label: "GST", percent: 5 },
      { code: "PST", label: "PST", percent: 7 },
    ]);
    expect(canadaTaxComponents("QC", { ...registered, provincialRegistrations: ["QC"] })[1]).toEqual({
      code: "QST",
      label: "QST",
      percent: 9.975,
    });
  });

  it("a small supplier (not registered) charges no GST/HST", () => {
    expect(canadaTaxComponents("ON", { ...registered, gstRegistered: false })).toEqual([]);
    expect(canadaTaxComponents("MB", { ...registered, gstRegistered: false, provincialRegistrations: ["MB"] })).toEqual([
      { code: "RST", label: "RST", percent: 7 },
    ]);
  });
});
