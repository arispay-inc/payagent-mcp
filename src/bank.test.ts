import type { BankAccount } from "payagent";
import { describe, expect, it } from "vitest";
import { BANK_OPEN_URL, bankLines, formatCents } from "./bank.js";

const account = (currency: string, extra: Partial<BankAccount> = {}): BankAccount => ({
  currency,
  status: "enabled",
  fundingAccountId: `fa_${currency}`,
  iban: null,
  bic: null,
  sortCode: null,
  accountNumber: null,
  balanceCents: 0,
  ...extra,
});

describe("formatCents", () => {
  it("formats integer cents per currency", () => {
    expect(formatCents(2500, "GBP")).toBe("£25.00");
    expect(formatCents(123456, "EUR")).toBe("€1,234.56");
    expect(formatCents(5, "CHF")).toBe("CHF 0.05");
  });
});

describe("bankLines", () => {
  it("says nothing when the bank rail is off", () => {
    expect(bankLines({ status: "unavailable" }, true)).toEqual([]);
  });

  it("points the human to the open-account page when there is none", () => {
    expect(bankLines({ status: "none" }, false).join("\n")).toContain(BANK_OPEN_URL);
  });

  it("lists balances in GBP, EUR, USD order", () => {
    const lines = bankLines(
      {
        status: "open",
        accounts: [account("USD", { balanceCents: 100 }), account("GBP", { balanceCents: 2500 })],
      },
      false,
    );
    expect(lines).toEqual([
      "Bank accounts (yours — fiat payments draw from these):",
      "  GBP  £25.00  (enabled)",
      "  USD  $1.00  (enabled)",
    ]);
  });

  it("adds the pay-in details when asked", () => {
    const text = bankLines(
      {
        status: "open",
        accounts: [
          account("GBP", {
            sortCode: "04-00-04",
            accountNumber: "12345678",
            iban: "GB33KEEL00000000000001",
            bic: "KEELGB22",
          }),
          account("EUR"),
        ],
      },
      true,
    ).join("\n");
    expect(text).toContain("Sort code 04-00-04  Account 12345678");
    expect(text).toContain("IBAN GB33KEEL00000000000001  BIC KEELGB22");
    expect(text).toContain("Opening — details appear shortly.");
    expect(text).toContain("bank transfer");
  });
});
