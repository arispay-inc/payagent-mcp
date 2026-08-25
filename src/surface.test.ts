/**
 * Release gates for the payagent-mcp surface (owner directive 2026-08-25).
 *
 * CI fails unless:
 *   1. package.json and server.json (both fields) report one identical
 *      version — the runtime reads package.json, so all three lockstep.
 *   2. tools/list returns exactly the expected tool names and count,
 *      per profile.
 *   3. Every tool carries complete MCP safety annotations, and every
 *      description states its money semantics (the Glama TDQS rubric's
 *      side-effect requirement).
 *   4. No card, EURØP, EURC, SEPA, or Schuman product references remain
 *      anywhere in the published package surface.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import {
  ADMIN_TOOL_NAMES,
  CORE_TOOL_NAMES,
  TOOL_META,
  resolveProfile,
  toolNamesForProfile,
} from "./tool-meta.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pkgRoot, rel), "utf8"));
}

async function listToolsFor(profile: "core" | "admin") {
  const server = createServer(profile);
  const client = new Client({ name: "surface-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await client.close();
  await server.close();
  return result.tools;
}

describe("release gate — one identical version", () => {
  it("package.json and both server.json version fields match", () => {
    const pkg = readJson("package.json") as { version: string };
    const serverJson = readJson("server.json") as {
      version: string;
      packages: Array<{ version: string }>;
    };
    expect(serverJson.version).toBe(pkg.version);
    for (const p of serverJson.packages) {
      expect(p.version).toBe(pkg.version);
    }
  });
});

describe("release gate — tools/list surface", () => {
  it("core profile exposes exactly the six core tools", async () => {
    const tools = await listToolsFor("core");
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it("admin profile exposes core + admin tools", async () => {
    const tools = await listToolsFor("admin");
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...CORE_TOOL_NAMES, ...ADMIN_TOOL_NAMES].sort(),
    );
  });

  it("every listed tool carries complete safety annotations", async () => {
    const tools = await listToolsFor("admin");
    for (const tool of tools) {
      const a = tool.annotations as Record<string, unknown> | undefined;
      expect(a, `${tool.name} has annotations`).toBeTruthy();
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof a?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("pay is the only destructive tool and is marked as spending money", async () => {
    const tools = await listToolsFor("admin");
    for (const tool of tools) {
      const destructive = (tool.annotations as { destructiveHint?: boolean }).destructiveHint;
      expect(destructive, `${tool.name}.destructiveHint`).toBe(tool.name === "pay");
    }
  });
});

describe("release gate — description rubric (TDQS)", () => {
  it("every tool description states its money semantics", () => {
    for (const [name, meta] of Object.entries(TOOL_META)) {
      const d = meta.description;
      expect(d.length, `${name} description length`).toBeGreaterThanOrEqual(100);
      const statesMoney =
        /SPENDS REAL MONEY/.test(d) || /[Mm]oves no money/.test(d) || /[Ss]pends no money/.test(d);
      expect(statesMoney, `${name} states whether it spends real funds`).toBe(true);
    }
  });

  it("read-only annotations match read-only description claims", () => {
    for (const [name, meta] of Object.entries(TOOL_META)) {
      if (meta.annotations.readOnlyHint) {
        expect(
          /[Rr]ead-only|[Ss]pends no money|[Mm]oves no money/.test(meta.description),
          `${name} read-only tool says so`,
        ).toBe(true);
        expect(meta.annotations.destructiveHint, `${name} read-only is not destructive`).toBe(false);
      }
    }
  });
});

describe("release gate — no retired product references", () => {
  // The v4 surface is USDC/x402 only. None of these product terms may
  // appear anywhere in the published package surface (owner decision
  // 2026-08-25). \b keeps 'card' from matching 'discard' etc.
  const FORBIDDEN = /\bcards?\b|eur[øo]p|\beurc\b|\bsepa\b|schuman/i;

  const srcDir = join(pkgRoot, "src");
  const sources = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join("src", f));
  const surfaces = [...sources, "README.md", "server.json", "smithery.yaml", "package.json"];

  for (const rel of surfaces) {
    it(`${rel} is clean`, () => {
      const text = readFileSync(join(pkgRoot, rel), "utf8");
      // This test file names the forbidden terms on purpose; skip self.
      if (rel.endsWith("surface.test.ts")) return;
      const match = text.match(FORBIDDEN);
      expect(match, `found "${match?.[0]}" in ${rel}`).toBeNull();
    });
  }
});

describe("profile resolution", () => {
  it("defaults to core, honors admin + legacy aliases", () => {
    expect(resolveProfile(undefined)).toBe("core");
    expect(resolveProfile("")).toBe("core");
    expect(resolveProfile("core")).toBe("core");
    expect(resolveProfile("admin")).toBe("admin");
    expect(resolveProfile("all")).toBe("admin");
    expect(resolveProfile("FULL")).toBe("admin");
    expect(toolNamesForProfile("core")).toHaveLength(6);
    expect(toolNamesForProfile("admin")).toHaveLength(10);
  });
});
