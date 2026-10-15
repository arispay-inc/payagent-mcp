/**
 * Bank account (vIBAN) lines for `balance`, `fund_agent` and `setup`.
 *
 * The account holder's own bank accounts are the fiat funding source
 * (payagent ≥ 3 pays `arispay-fiat` offers from them). They are the same
 * accounts BuyForMe shows; the agent reads them so it can tell its human
 * where the money is and how to add more. Read-only, moves no money.
 */
import type { BankAccount, BankAccountsResult } from "payagent";

/** Where a human opens the account (identity goes to the bank, not to us). */
export const BANK_OPEN_URL = "https://buyforme.arispay.app/me/bank";

const ORDER = ["GBP", "EUR", "USD"];
const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };

/** Integer cents → "£12.50". No float division of money. */
export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const major = Math.floor(abs / 100).toLocaleString("en-GB");
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${SYMBOL[currency] ?? `${currency} `}${major}.${minor}`;
}

function sorted(accounts: BankAccount[]): BankAccount[] {
  const rank = (c: string) => (ORDER.indexOf(c) === -1 ? ORDER.length : ORDER.indexOf(c));
  return [...accounts].sort((a, b) => rank(a.currency) - rank(b.currency));
}

function detailLines(a: BankAccount): string[] {
  const lines: string[] = [];
  if (a.sortCode && a.accountNumber) {
    lines.push(`    Sort code ${a.sortCode}  Account ${a.accountNumber}`);
  }
  if (a.iban) lines.push(`    IBAN ${a.iban}${a.bic ? `  BIC ${a.bic}` : ""}`);
  if (!lines.length) lines.push("    Opening — details appear shortly.");
  return lines;
}

/**
 * Lines describing the bank accounts. `withDetails` adds the pay-in details
 * (what a human needs to send a bank transfer).
 */
export function bankLines(result: BankAccountsResult, withDetails: boolean): string[] {
  switch (result.status) {
    case "unavailable":
      return [];
    case "none":
      return [
        "Bank:        no bank account yet. The human opens one (their own vIBAN) at",
        `             ${BANK_OPEN_URL}`,
      ];
    case "open": {
      if (!result.accounts.length)
        return ["Bank:        accounts opening — details appear shortly."];
      const lines = ["Bank accounts (yours — fiat payments draw from these):"];
      for (const a of sorted(result.accounts)) {
        lines.push(`  ${a.currency}  ${formatCents(a.balanceCents, a.currency)}  (${a.status})`);
        if (withDetails) lines.push(...detailLines(a));
      }
      if (withDetails) {
        lines.push("Add money by bank transfer from an account in the holder's own name.");
      }
      return lines;
    }
  }
}
