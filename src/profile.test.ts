import { describe, expect, it } from "vitest";
import { platformToolsEnabled } from "./profile.js";

describe("platformToolsEnabled", () => {
  it("defaults to all tools when the env var is unset", () => {
    expect(platformToolsEnabled(undefined)).toBe(true);
  });

  it("disables platform tools for the core profile (case/whitespace tolerant)", () => {
    expect(platformToolsEnabled("core")).toBe(false);
    expect(platformToolsEnabled(" CORE ")).toBe(false);
  });

  it("treats unknown values as the full profile (fail open, never hide pay_api siblings)", () => {
    expect(platformToolsEnabled("all")).toBe(true);
    expect(platformToolsEnabled("everything")).toBe(true);
    expect(platformToolsEnabled("")).toBe(true);
  });
});
