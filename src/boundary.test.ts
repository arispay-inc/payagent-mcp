import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Package boundary test — `@arispay/payagent-mcp` may only depend on the
 * public exports of `payagent`.
 *
 * Per Component Contract 4 in root CLAUDE.md:
 *   "Only use the public exports of `payagent` (`.`, `./vercel`,
 *    `./langchain`). Never reach into `payagent/src/*` or
 *    `payagent/dist/internal`."
 *
 * `payagent-mcp` is a regular npm consumer of `payagent` (declared as
 * `"payagent": "^2.x.x"` in package.json — not a workspace dep). If
 * a future PR reaches into internal paths, it ships via `^2.x.x` and
 * breaks MCP clients the moment `payagent` refactors anything internal.
 *
 * This test scans every .ts file under `packages/payagent-mcp/src/` (skip
 * tests) and fails CI if any import string starts with `payagent/src/`,
 * `payagent/dist/`, or `payagent/internal`.
 */
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip nested node_modules, dist, build artefacts.
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
      listTsFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("payagent-mcp — package boundary against payagent", () => {
  it("forbids imports into payagent internals (src/, dist/, internal)", () => {
    const files = listTsFiles(__dirname);
    expect(files.length).toBeGreaterThan(0);

    // Match any `from '...'` / `from "..."` whose module path starts with
    // `payagent/` followed by a forbidden segment. Allow exact `payagent`
    // and the documented public sub-paths `payagent/vercel`,
    // `payagent/langchain`.
    const violationRe = /from\s+['"]payagent\/(src|dist|internal)/g;

    const violations: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        if (violationRe.test(line)) {
          violations.push({ file, line: idx + 1, snippet: line.trim() });
        }
        violationRe.lastIndex = 0; // reset stateful regex
      });
    }

    expect(
      violations,
      [
        "",
        "payagent-mcp imported a payagent internal path. The contract says",
        "only `payagent`, `payagent/vercel`, `payagent/langchain` are allowed.",
        "Reaching into src/ or dist/ ships through `^2.x.x` and breaks every",
        "MCP client the moment payagent refactors that path.",
        "",
        "See Component Contract 4 in CLAUDE.md.",
        "",
      ].join("\n"),
    ).toEqual([]);
  });
});
