// Copyright 2026 UCP Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Regression coverage for the "zero new exports beyond the discovery
// baseline is a failed family" rule generate_models.sh's per-family loop
// now applies (see its own comment, and the constraint_expression entry in
// check-generation-completeness.mjs's KNOWN_UNREPRESENTABLE_FAMILIES, for
// the full failure-mode writeup). Every per-family quicktype invocation
// bundles --src discovery/*.json alongside the family's own --src, so a
// family whose own type quicktype cannot represent still exits 0 with a
// NON-EMPTY fragment (the shared discovery content alone), indistinguishable
// from success by exit code or non-empty output alone -- the real bug this
// closes: before this fix, such a family was silently treated as
// successful, its fragment merged (contributing nothing, since none of its
// content was ever in the fragment to begin with), and no one was ever
// told.
//
// Tested here directly against scripts/count-new-exports.mjs, independent
// of quicktype or any spec tree, because the comparison itself is pure
// string logic -- exercising it through the full pipeline would make this
// test depend on quicktype's actual (environment-sensitive, slow)
// type-ordering behavior for what is a deterministic set-difference.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/count-new-exports.mjs");

const {
  exportedConstNames,
  newExportNames,
} = require("../scripts/count-new-exports.mjs");

const DISCOVERY_ONLY_BASELINE = `
export const TransportSchema = z.enum(["a2a", "embedded", "mcp", "rest"]);
export type Transport = z.infer<typeof TransportSchema>;

export const CapabilityDiscoverySchema = z.object({
  name: z.string(),
});
export type CapabilityDiscovery = z.infer<typeof CapabilityDiscoverySchema>;
`;

test("exportedConstNames: reads every top-level export const name", () => {
  assert.deepEqual(
    exportedConstNames(DISCOVERY_ONLY_BASELINE),
    new Set(["TransportSchema", "CapabilityDiscoverySchema"])
  );
});

test("newExportNames: a family that only re-emits the shared discovery baseline contributes nothing", () => {
  // Reproduces the real bug directly: 2026-08-25's common/types/
  // constraint_expression.json is genuinely self-referential and quicktype
  // cannot place it, but its per-family invocation (bundled with
  // discovery/*.json) still exits 0 -- the fragment it produces is BYTE-
  // IDENTICAL to the discovery-only baseline, because none of its own
  // content ever made it in.
  const fragmentIdenticalToBaseline = DISCOVERY_ONLY_BASELINE;
  assert.deepEqual(
    newExportNames(DISCOVERY_ONLY_BASELINE, fragmentIdenticalToBaseline),
    new Set()
  );
});

test("newExportNames: a family that generates its own type contributes it, even if the name also happens to duplicate main", () => {
  // A genuinely successful family -- including one whose content duplicates
  // something already reachable elsewhere in the main output -- still
  // freshly emits its OWN requested export name(s) in its isolated
  // invocation: quicktype has no notion of "already declared in main" at
  // that point (merge-generated-fragment.mjs is what skips true duplicates,
  // later, by comparing against the MAIN file, not the discovery baseline).
  // This must never false-flag a duplicative but working family.
  const fragmentWithOwnType = `${DISCOVERY_ONLY_BASELINE}
export const PanCredentialSchema = z.object({
  pan: z.string().optional(),
});
export type PanCredential = z.infer<typeof PanCredentialSchema>;
`;
  assert.deepEqual(
    newExportNames(DISCOVERY_ONLY_BASELINE, fragmentWithOwnType),
    new Set(["PanCredentialSchema"])
  );
});

test("newExportNames: an empty fragment (quicktype produced nothing at all) also contributes nothing", () => {
  assert.deepEqual(newExportNames(DISCOVERY_ONLY_BASELINE, ""), new Set());
});

test("CLI: prints the new-export count as a bare integer", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ucp-js-sdk-count-new-exports-")
  );
  const baselinePath = path.join(dir, "baseline.ts");
  const fragmentPath = path.join(dir, "fragment.ts");
  fs.writeFileSync(baselinePath, DISCOVERY_ONLY_BASELINE);
  fs.writeFileSync(
    fragmentPath,
    `${DISCOVERY_ONLY_BASELINE}\nexport const PanCredentialSchema = z.object({});\n`
  );
  const output = execFileSync("node", [SCRIPT, baselinePath, fragmentPath], {
    encoding: "utf8",
  });
  assert.equal(output, "1");
});

test("CLI: prints 0 when the fragment matches the baseline exactly (the constraint_expression failure mode)", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ucp-js-sdk-count-new-exports-")
  );
  const baselinePath = path.join(dir, "baseline.ts");
  const fragmentPath = path.join(dir, "fragment.ts");
  fs.writeFileSync(baselinePath, DISCOVERY_ONLY_BASELINE);
  fs.writeFileSync(fragmentPath, DISCOVERY_ONLY_BASELINE);
  const output = execFileSync("node", [SCRIPT, baselinePath, fragmentPath], {
    encoding: "utf8",
  });
  assert.equal(output, "0");
});
