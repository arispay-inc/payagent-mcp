import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PaymentReceipt,
  decodeSettlementHeader,
  getReceipt,
  listReceipts,
  saveReceipt,
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
