import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PaymentReceipt,
  UNDELIVERED_RETRY_WINDOW_MS,
  decodeSettlementHeader,
  getReceipt,
  listReceipts,
  saveReceipt,
  undeliveredMarker,
  undeliveredRetryAgent,
} from "./receipts.js";

function receipt(key: string, overrides: Partial<PaymentReceipt> = {}): PaymentReceipt {
  return {
    idempotencyKey: key,
    url: "https://api.example.com/paid",
    method: "GET",
    timestamp: new Date().toISOString(),
    mode: "local",
    paid: true,
    httpStatus: 200,
    amountBaseUnits: "10000",
    ...overrides,
  };
}

describe("receipt store — idempotency guard", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "payagent-mcp-receipts-"));
    process.env.PAYAGENT_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.PAYAGENT_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for an unknown key", () => {
    expect(getReceipt("never-used-key")).toBeUndefined();
  });

  it("save + get roundtrip", () => {
    saveReceipt(receipt("idem-abc-123"));
    const found = getReceipt("idem-abc-123");
    expect(found?.paid).toBe(true);
    expect(found?.amountBaseUnits).toBe("10000");
  });

  it("records post-payment failures so a blind retry cannot double-pay", () => {
    saveReceipt(receipt("idem-fail-1", { httpStatus: null, error: "socket hang up" }));
    const found = getReceipt("idem-fail-1");
    expect(found?.paid).toBe(true);
    expect(found?.error).toBe("socket hang up");
  });

  it("lists newest first and respects the limit", () => {
    saveReceipt(receipt("idem-1"));
    saveReceipt(receipt("idem-2"));
    saveReceipt(receipt("idem-3"));
    const listed = listReceipts(2);
    expect(listed.map((r) => r.idempotencyKey)).toEqual(["idem-3", "idem-2"]);
  });

  it("bounds the store to the newest 200 receipts", () => {
    for (let i = 0; i < 205; i++) saveReceipt(receipt(`idem-${i}`));
    expect(getReceipt("idem-0")).toBeUndefined();
    expect(getReceipt("idem-204")).toBeTruthy();
  });
});

describe("decodeSettlementHeader", () => {
  it("decodes a base64 x402 settlement response", () => {
    const header = Buffer.from(
      JSON.stringify({ success: true, transaction: "0xabc", network: "base", payer: "0xdef" }),
    ).toString("base64");
    expect(decodeSettlementHeader(header)).toEqual({
      transaction: "0xabc",
      network: "base",
      payer: "0xdef",
    });
  });

  it("returns null for absent or garbage headers", () => {
    expect(decodeSettlementHeader(null)).toBeNull();
    expect(decodeSettlementHeader("not-base64-json")).toBeNull();
    expect(decodeSettlementHeader(Buffer.from("{}").toString("base64"))).toBeNull();
  });
});

describe("undelivered retry — the one same-key retry that is safe", () => {
  const START = "2026-10-07T12:00:00.000Z";
  const T0 = Date.parse(START);
  const undeliveredError = Object.assign(new Error("settled, not delivered"), {
    name: "PaymentUndeliveredError",
    txHash: "0xsettled",
  });

  function delegatedUndelivered(overrides: Partial<PaymentReceipt> = {}): PaymentReceipt {
    return receipt("intent-0001", {
      mode: "delegated",
      agent: "wallet",
      httpStatus: null,
      error: "settled, not delivered",
      undelivered: {
        txHash: "0xsettled",
        retryUntil: new Date(T0 + UNDELIVERED_RETRY_WINDOW_MS).toISOString(),
      },
      ...overrides,
    });
  }

  it("allows a retry of an undelivered delegated payment inside the window, with its agent", () => {
    expect(undeliveredRetryAgent(delegatedUndelivered(), T0 + 60_000)).toBe("wallet");
  });

  it("locks the key once the window passes (the server would sign a NEW payment)", () => {
    expect(
      undeliveredRetryAgent(delegatedUndelivered(), T0 + UNDELIVERED_RETRY_WINDOW_MS),
    ).toBeNull();
  });

  it("never allows a retry of a local-key payment (every call signs a fresh nonce)", () => {
    expect(undeliveredRetryAgent(delegatedUndelivered({ mode: "local" }), T0)).toBeNull();
  });

  it("never allows a retry of an ordinary paid or failed receipt", () => {
    expect(
      undeliveredRetryAgent(receipt("k", { mode: "delegated", agent: "wallet" }), T0),
    ).toBeNull();
    expect(undeliveredRetryAgent(undefined, T0)).toBeNull();
  });

  it("keeps the window inside the server's 10-minute sign cache", () => {
    expect(UNDELIVERED_RETRY_WINDOW_MS).toBeLessThan(10 * 60_000);
  });

  it("marks only PaymentUndeliveredError, with a deadline from the first attempt", () => {
    expect(undeliveredMarker(new Error("network down"), START)).toBeUndefined();
    const first = undeliveredMarker(undeliveredError, START);
    expect(first).toEqual({
      txHash: "0xsettled",
      retryUntil: new Date(T0 + UNDELIVERED_RETRY_WINDOW_MS).toISOString(),
    });
    // A second undelivered attempt never extends the deadline.
    const later = undeliveredMarker(
      undeliveredError,
      "2026-10-07T12:05:00.000Z",
      delegatedUndelivered(),
    );
    expect(later?.retryUntil).toBe(first?.retryUntil);
  });
});
