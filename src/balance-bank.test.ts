/**
 * `balance` tells the agent where the money is: with an ArisPay key it reads
 * the holder's own bank accounts (GET /v1/keel/customers/me) and prints the
 * balances and pay-in details. Network is stubbed; no real calls.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

const ENV_KEYS = ["ARISPAY_API_KEY", "ARISPAY_URL", "PAYAGENT_CONFIG_DIR", "PAYAGENT_PRIVATE_KEY"];
let saved: Record<string, string | undefined>;
let dir: string;
let origFetch: typeof fetch;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "payagent-mcp-"));
  process.env.PAYAGENT_CONFIG_DIR = dir;
  process.env.ARISPAY_URL = "https://api.arispay.test";
  process.env.ARISPAY_API_KEY = "ap_test_dev";
  Reflect.deleteProperty(process.env, "PAYAGENT_PRIVATE_KEY");
  origFetch = globalThis.fetch;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = origFetch;
});

async function callBalance(): Promise<string> {
  const server = createServer("core");
  const client = new Client({ name: "balance-bank-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const res = await client.callTool({ name: "balance", arguments: {} });
  await client.close();
  await server.close();
  return (res.content as Array<{ text: string }>)[0].text;
}

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("balance — bank accounts", () => {
  it("prints the bank balance and pay-in details", async () => {
    const fn = stubFetch(200, {
      accounts: [
        {
          currency: "GBP",
          status: "enabled",
          fundingAccountId: "fa_1",
          iban: "GB33KEEL00000000000001",
          bic: "KEELGB22",
          sortCode: "04-00-04",
          accountNumber: "12345678",
          balanceCents: 2500,
        },
      ],
    });
    const text = await callBalance();
    expect(fn).toHaveBeenCalledWith(
      "https://api.arispay.test/v1/keel/customers/me",
      expect.objectContaining({ method: "GET" }),
    );
    expect(text).toContain("GBP  £25.00  (enabled)");
    expect(text).toContain("Sort code 04-00-04  Account 12345678");
    expect(text).not.toContain("No wallet known");
    expect(text).not.toContain("ap_test_dev");
  });

  it("tells the human where to open an account when there is none", async () => {
    stubFetch(404, { error: { code: "KEEL_CUSTOMER_NOT_FOUND", message: "none" } });
    expect(await callBalance()).toContain("no bank account yet");
  });

  it("stays silent about banks when the rail is off", async () => {
    stubFetch(503, { error: { code: "KEEL_NOT_ENABLED", message: "off" } });
    const text = await callBalance();
    expect(text).not.toContain("Bank");
    expect(text).toContain("No wallet known");
  });
});
