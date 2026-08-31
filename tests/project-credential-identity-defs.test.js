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

// Follow-up to generate-0825-projection.test.js's own fix: that lane proved
// the generation pipeline completes end to end against a reorganized spec
// tree; it deliberately left two gaps as documented, out-of-scope residuals
// (see its own PR body): (1) common/types/* files with no INBOUND $ref from
// anything reachable are projected to disk but never handed to quicktype at
// all -- the real-world instance is 2026-08-25's four payment-credential
// subtypes (card/pan/network_token/token_credential.json), reproduced here
// by tests/fixtures/reorg-spec/source/schemas/common/types/pan_credential.json,
// which nothing in the fixture ever $refs; (2) a capability whose $defs is
// its own platform/business config declaration -- neither a checkout/order/
// cart attachment nor a lookup/search pair -- matched no known shape and was
// reported as skipped; the real-world instances are identity_linking.json
// (present in both spec pins) and permalink.json (2026-08-25 only),
// reproduced here by
// tests/fixtures/reorg-spec/source/schemas/common/identity_linking.json.
//
// This file proves BOTH gaps are closed, generically (no hand list of which
// common/types files are "the orphaned ones"; no hand list of which
// capabilities are "the declaration ones" -- both discovered by shape).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE_SOURCE = path.join(REPO_ROOT, "tests/fixtures/reorg-spec/source");
const PROJECTOR_SCRIPT = path.join(
  REPO_ROOT,
  "scripts/project-current-ucp-schemas.mjs"
);

function runProjector() {
  const outDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ucp-js-sdk-credential-identity-fixture-")
  );
  const result = execFileSync(
    "node",
    [PROJECTOR_SCRIPT, FIXTURE_SOURCE, outDir],
    { encoding: "utf8" }
  );
  return { outDir, stdout: result };
}

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments), "utf8"));
}

// execFileSync spawns quicktype directly, with no shell in between, so a
// literal "*.json" argument is never glob-expanded (unlike the bash-driven
// generate_models.sh, or a manual shell invocation) -- it must be expanded
// here first, or quicktype fails trying to open a file literally named
// "*.json".
function expandGlobs(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function runQuicktype(discoveryDir, extraSrcArgs, cwd) {
  const outputTs = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ucp-js-sdk-quicktype-")),
    "out.ts"
  );
  const discoveryArgs = expandGlobs(discoveryDir).flatMap((file) => [
    "--src",
    file,
  ]);
  execFileSync(
    "npx",
    [
      "quicktype",
      "--lang",
      "typescript-zod",
      "--src-lang",
      "schema",
      ...discoveryArgs,
      ...extraSrcArgs,
      "-o",
      outputTs,
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  );
  return fs.readFileSync(outputTs, "utf8");
}

test("an orphaned common/types file (no inbound $ref) is added to the generation manifest", () => {
  const { outDir } = runProjector();
  const manifest = readJson(outDir, "generated-src-manifest.json");
  assert.ok(
    Array.isArray(manifest.types),
    "generated-src-manifest.json must carry a types array"
  );
  assert.ok(
    manifest.types.includes("common/types/pan_credential.json"),
    "pan_credential.json (referenced by nothing in the fixture, exactly like " +
      "the real card/pan/network_token/token_credential.json subtypes) must " +
      "be on the manifest -- every common/types file is added, not a hand-" +
      "picked subset"
  );
});

test("the orphaned file's manifest entry actually generates a real model with quicktype", () => {
  // Complements the previous test rather than re-proving it: that test
  // proves the MANIFEST now names pan_credential.json (the actual
  // regression -- before this fix it was projected to disk but never
  // reachable from any --src); this one proves quicktype itself can
  // represent what that manifest entry points at, by invoking quicktype
  // directly the same way generate_models.sh's per-family loop would. It
  // passes even against the unfixed generator (it does not depend on the
  // manifest at all), so it is not on its own a kill-test for the fix --
  // see the previous test for that.
  const { outDir } = runProjector();
  const generated = runQuicktype(
    path.join(outDir, "discovery"),
    ["--src", path.join(outDir, "schemas/common/types/pan_credential.json")],
    REPO_ROOT
  );
  assert.match(
    generated,
    /export const PanCredentialSchema/,
    "pan_credential.json must generate its own named model, not silently produce nothing"
  );
  assert.match(generated, /"pan": z\.string\(\)/);
});

test("a declaration capability (platform_schema/business_schema under its own name) is no longer skipped", () => {
  const { outDir, stdout } = runProjector();
  assert.doesNotMatch(
    stdout,
    /identity_linking\.json.*matched no known shape/s,
    "identity_linking-shaped fixture must no longer be reported as an unmodeled gap"
  );

  const projected = readJson(outDir, "schemas/common/identity_linking.json");
  assert.ok(
    !("dev.ucp.common.identity_linking" in projected.$defs),
    "the capability's own name-keyed $defs entry must be hoisted away, not left in place"
  );
  assert.ok(
    "platform_schema" in projected.$defs &&
      "business_schema" in projected.$defs,
    "platform_schema/business_schema must be hoisted to top-level $defs so quicktype can address them directly"
  );

  const manifest = readJson(outDir, "generated-src-manifest.json");
  assert.ok(
    manifest.capabilities.includes(
      "common/identity_linking.json#/$defs/platform_schema"
    ) &&
      manifest.capabilities.includes(
        "common/identity_linking.json#/$defs/business_schema"
      ),
    "both role variants must be on the manifest"
  );
});

test("a declaration capability's hoisted variants generate with no dangling cross-file $ref", () => {
  // capability.json itself is NEVER projected into the output tree (only its
  // FLATTENED discovery/capability.json compat form is) -- the naive "just
  // point quicktype at the nested fragment" approach fails here with
  // quicktype's generic "Internal error: ." because "../capability.json"
  // does not exist at that path in the projected tree, not because the
  // shape itself is unrepresentable (proven separately by running the same
  // fragment against the RAW, unprojected fixture source, where it resolves
  // cleanly). This test proves buildDeclarationVariantSchema's flattening
  // avoids that dependency entirely: the PROJECTED file must generate
  // without capability.json existing anywhere in the projected tree.
  const { outDir } = runProjector();
  assert.ok(
    !fs.existsSync(path.join(outDir, "schemas/capability.json")),
    "capability.json must NOT be projected (sanity check on the premise this test proves against)"
  );

  const generated = runQuicktype(
    path.join(outDir, "discovery"),
    [
      "--src",
      `${path.join(outDir, "schemas/common/identity_linking.json")}#/$defs/platform_schema`,
      "--src",
      `${path.join(outDir, "schemas/common/identity_linking.json")}#/$defs/business_schema`,
    ],
    REPO_ROOT
  );
  assert.match(generated, /export const IdentityLinkingPlatformSchema/);
  assert.match(generated, /export const IdentityLinkingBusinessSchema/);
  // The capability's OWN typed config must survive intact (not collapsed to
  // an untyped blob) -- proving properties are kept as-is, not toCompatLeaf'd
  // (toCompatLeaf would have flattened "config" to a bare
  // z.record(z.string(), z.any())/additionalProperties:true, losing the
  // fixture's own scope_policy $defs entry entirely). quicktype's
  // typescript-zod target drops JSON Schema `description` text rather than
  // emitting it as a comment, so the marker text itself is not observable
  // here -- the nested named type surviving intact (with its own field, not
  // collapsed) is the real proof.
  assert.match(
    generated,
    /export const ScopePolicySchema = z\.object\(\{\s*"marker": z\.string\(\)\.optional\(\),/,
    "identity_linking's own scope_policy $defs entry must survive as a real named type"
  );
  assert.match(
    generated,
    /export const ConfigSchema = z\.object\(\{\s*"scopes": z\.record\(z\.string\(\), ScopePolicySchema\),/,
    "config.scopes must stay a typed record of ScopePolicySchema, not collapse to an untyped blob"
  );
});

test("ucp.json's success/error variants resolve once a common/types file reaches them", () => {
  // common/types/error_response.json (fixture) $refs ucp.json#/$defs/error.
  // Before this fix, the projected compat ucp.json carried only the
  // response_*_schema keys; a file reaching #/$defs/error at all (only
  // possible once common/types files are generated -- previously nothing
  // was) hit "Key not in schema object at .../ucp.json#error".
  const { outDir } = runProjector();
  const generated = runQuicktype(
    path.join(outDir, "discovery"),
    ["--src", path.join(outDir, "schemas/common/types/error_response.json")],
    REPO_ROOT
  );
  assert.match(generated, /error_response_marker/);
});
