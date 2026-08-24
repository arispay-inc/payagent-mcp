import { describe, expect, it } from "vitest";
import { buildEuropFundingResult, resolveFundingHandoffBase } from "./funding-handoff.js";

describe("resolveFundingHandoffBase", () => {
  it("has NO default — unset/empty means null, never the retired domain", () => {
    expect(resolveFundingHandoffBase({})).toBeNull();
    expect(resolveFundingHandoffBase({ BUYFORME_URL: "" })).toBeNull();
    expect(resolveFundingHandoffBase({ BUYFORME_URL: "   " })).toBeNull();
  });

  it("honors an operator-set host and strips the trailing slash", () => {
    expect(resolveFundingHandoffBase({ BUYFORME_URL: "https://handoff.example/" })).toBe(
      "https://handoff.example",
    );
  });
});

describe("buildEuropFundingResult — unavailable path (regression for the retired-domain default)", () => {
  it("returns a structured FUNDING_HANDOFF_UNAVAILABLE error when no host is configured", () => {
    const result = buildEuropFundingResult(null, "groceries", "agt_1");
    expect(result.isError).toBe(true);

    const payload = JSON.parse(result.text);
    expect(payload.error.code).toBe("FUNDING_HANDOFF_UNAVAILABLE");
    expect(payload.error.retryable).toBe(false);
    expect(payload.error.detail.rail).toBe("europ");
  });

  it("never emits the retired domain, the preview host, or any invented URL", () => {
    const result = buildEuropFundingResult(null, "groceries", "agt_1");
    expect(result.text).not.toContain("buyforme.arispay.app");
    expect(result.text).not.toContain("preview-buyforme");
    expect(result.text).not.toMatch(/https?:\/\//);
  });

  it("surfaces the Lane P alternative (self-custody wallet + local signing)", () => {
    const payload = JSON.parse(buildEuropFundingResult(null, "groceries", "agt_1").text);
    const laneP = payload.alternatives.find(
      (a: { id: string }) => a.id === "lane-p-self-custody",
    );
    expect(laneP).toBeDefined();
    expect(laneP.description).toContain("USDC on Base");
    expect(laneP.env.PAYAGENT_PRIVATE_KEY).toBeDefined();
    expect(laneP.sdk).toContain("payFetchLocal");
    // The trade-off is stated: no platform limits in this mode.
    expect(laneP.description).toMatch(/spend limits.*do not apply/);
  });

  it("also offers the card rail as the delegated (Lane D) alternative", () => {
    const payload = JSON.parse(buildEuropFundingResult(null, "groceries", "agt_1").text);
    const card = payload.alternatives.find((a: { id: string }) => a.id === "card");
    expect(card.tool).toBe("fund_wallet");
    expect(card.args.rail).toBe("card");
  });
});

describe("buildEuropFundingResult — configured path", () => {
  it("builds the handoff URL from the operator host with the wallet id bound", () => {
    const result = buildEuropFundingResult("https://handoff.example", "groceries", "agt 1/x");
    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      "https://handoff.example/onboarding/fund-europ?agentId=agt%201%2Fx",
    );
  });
});
