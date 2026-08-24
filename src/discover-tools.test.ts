/**
 * Unit tests for the discover_paid_api / inspect_paid_api handlers.
 *
 * The `payagent` SDK functions are injected, so these tests run without a
 * built `payagent` dist. Locks in:
 *   - result shaping (ranked list, pay_api follow-up hint)
 *   - cents integrity: output carries integer cents; never a float dollars value
 *   - budget validation (integer cents only), limit clamping (default 5, max 20)
 *   - error paths: empty results, non-402 inspect, SDK failure
 *   - facilitator surfaced as SERVER-declared
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoverInput, DiscoverResult, InspectChallengeResult } from "payagent";
import { runDiscoverPaidApi, runInspectPaidApi } from "./discover-tools.js";

const sampleDiscover: DiscoverResult = {
  candidates: [
    {
      slug: "acme/flights",
      name: "Acme Flight Search",
      endpoint: { transport: "http-x402", url: "https://api.acme.example/flights" },
      pricing: { model: "x402", amount: 3, currency: "USD", per: "call" },
      healthy: true,
      verified: true,
      source: "arispay",
      score: 902,
    },
    {
      slug: "euro/weather",
      name: "Euro Weather",
      endpoint: { transport: "http-x402", url: "https://api.euro.example/weather" },
      pricing: { model: "x402", amount: 150, currency: "EUR", per: "call" },
      healthy: false,
      verified: false,
      source: "bazaar",
      score: 400,
    },
  ],
  query: { intent: "flights" },
};

describe("runDiscoverPaidApi", () => {
  it("shapes ranked results with integer cents and a pay_api follow-up", async () => {
    const impl = vi.fn(async (_input: DiscoverInput) => sampleDiscover);
    const result = await runDiscoverPaidApi({ query: "flight search" }, impl);

    expect(result.isError).toBe(false);
    expect(impl).toHaveBeenCalledWith({ intent: "flight search", limit: 5 });
    expect(result.text).toContain("1. Acme Flight Search");
    expect(result.text).toContain("https://api.acme.example/flights");
    // Canonical integer cents, plus display formatting from those cents.
    expect(result.text).toContain("3¢ ($0.03)");
    expect(result.text).toContain("150¢ (€1.50)");
    expect(result.text).toContain("healthy:  yes   verified: yes   source: arispay");
    expect(result.text).toContain("healthy:  no   verified: no   source: bazaar");
    expect(result.text).toContain("pay_api({ url })");
    // Never a float dollars value.
    expect(result.text).not.toMatch(/\$0\.030+[1-9]?/);
    expect(result.text).not.toMatch(/0\.030{2,}/);
  });

  it("passes budgetCentsMax through only as an integer", async () => {
    const impl = vi.fn(async (_input: DiscoverInput) => sampleDiscover);
    await runDiscoverPaidApi({ query: "x", budgetCentsMax: 500 }, impl);
    expect(impl).toHaveBeenCalledWith({ intent: "x", budgetCentsMax: 500, limit: 5 });

    const rejected = await runDiscoverPaidApi({ query: "x", budgetCentsMax: 5.5 }, impl);
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/integer number of cents/);
    expect(impl).toHaveBeenCalledTimes(1); // float budget never reaches the SDK
  });

  it("clamps limit to 20 and defaults to 5", async () => {
    const impl = vi.fn(async (_input: DiscoverInput) => sampleDiscover);
    await runDiscoverPaidApi({ query: "x", limit: 99 }, impl);
    expect(impl).toHaveBeenLastCalledWith({ intent: "x", limit: 20 });
  });

  it("returns a friendly non-error message on empty results", async () => {
    const impl = vi.fn(async () => ({ candidates: [], query: {} }) as DiscoverResult);
    const result = await runDiscoverPaidApi({ query: "nothing" }, impl);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('No paid APIs matched "nothing"');
  });

  it("surfaces SDK failures as tool errors", async () => {
    const impl = vi.fn(async () => {
      throw new Error("payagent discover failed (500): boom");
    });
    const result = await runDiscoverPaidApi({ query: "x" }, impl);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("discover_paid_api failed");
  });
});

describe("runInspectPaidApi", () => {
  const gated: InspectChallengeResult = {
    gated: true,
    url: "https://api.acme.example/premium",
    status: 402,
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amountBaseUnits: "30000",
        amountCents: 3,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        assetName: "USD Coin",
        currency: "USD",
        payTo: "0x1111111111111111111111111111111111111111",
      },
    ],
    serverDeclaredFacilitator: "https://facilitator.arispay.app",
  };

  it("reports price/asset/network without paying, facilitator as server-declared", async () => {
    const impl = vi.fn(async () => gated);
    const result = await runInspectPaidApi({ url: gated.url }, impl);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("network:  eip155:8453");
    expect(result.text).toContain("30000 base units = 3¢ ($0.03)");
    expect(result.text).toContain("payTo:    0x1111111111111111111111111111111111111111");
    expect(result.text).toContain(
      "Server-declared facilitator: https://facilitator.arispay.app",
    );
    expect(result.text).toContain("no payment was sent");
    // Integer cents only — no float dollars.
    expect(result.text).not.toMatch(/0\.030{2,}/);
  });

  it("errors clearly when the URL is not x402-gated", async () => {
    const impl = vi.fn(
      async () => ({ gated: false, url: "https://free.example/", status: 200 }) as const,
    );
    const result = await runInspectPaidApi({ url: "https://free.example/" }, impl);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("does not appear to be x402-gated");
    expect(result.text).toContain("HTTP 200");
  });

  it("shows base units alone when cents don't divide cleanly", async () => {
    const odd: InspectChallengeResult = {
      ...gated,
      accepts: [{ ...gated.accepts[0]!, amountBaseUnits: "12345", amountCents: undefined }],
    };
    const impl = vi.fn(async () => odd);
    const result = await runInspectPaidApi({ url: gated.url }, impl);
    expect(result.text).toContain("12345 base units");
    expect(result.text).not.toContain("12345 base units =");
    expect(result.text).not.toContain("1.2345");
  });

  it("surfaces parse failures as tool errors", async () => {
    const impl = vi.fn(async () => {
      throw new Error("402 but the body is not valid JSON");
    });
    const result = await runInspectPaidApi({ url: "https://broken.example/" }, impl);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("inspect_paid_api failed");
  });
});
