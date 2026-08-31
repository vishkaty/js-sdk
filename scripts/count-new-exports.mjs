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

// generate_models.sh's per-family loop bundles --src discovery/*.json
// alongside every family's own --src, so quicktype can resolve $refs into
// it. That means a family's isolated invocation exiting 0 with a non-empty
// fragment does NOT prove the family itself generated anything: a family
// whose own type quicktype cannot represent (e.g. 2026-08-25's genuinely
// self-referential common/types/constraint_expression.json) still exits 0
// and still successfully emits the shared discovery-only content alongside
// literally nothing of its own -- indistinguishable from success by exit
// code or a non-empty fragment alone (see check-generation-completeness.mjs's
// KNOWN_UNREPRESENTABLE_FAMILIES entry for constraint_expression, and
// generate_models.sh's own comment, for the full failure-mode writeup).
//
// What a family's fragment must clear is not "zero exports total" (the
// bundled discovery content alone already contributes many) but "zero NEW
// exports beyond a plain discovery-only baseline" -- computed here. On its
// own, though, that is NOT a safe failure signal: verified directly against
// the real 2026-08-25 tree, several genuinely successful families ALSO
// produce zero new names (a common/types file whose root schema is a bare
// scalar has nothing to name at the top level; a common/types file already
// reachable transitively from discovery/*.json alone produces an identical
// declaration in both). generate_models.sh only treats a family as failed
// when this reaches zero AND its own quicktype log shows the specific
// type-ordering warning that failure mode emits (see that script's own
// comment) -- the conjunction of the two is what this module exists to
// compute the first half of. Isolated here -- pure string logic, no
// quicktype, no shell quoting -- the same way
// check-generation-completeness.mjs isolates the allowlist decision, so it
// is directly unit-testable (tests/count-new-exports.test.js) independent
// of whether quicktype or the full pipeline can run in a given environment.

import fs from "node:fs";

const EXPORT_CONST_NAME_RE = /^export const (\w+)/gm;

export function exportedConstNames(text) {
  return new Set([...text.matchAll(EXPORT_CONST_NAME_RE)].map((match) => match[1]));
}

// Names present in `fragmentText` that are NOT present in `baselineText`.
// A genuinely successful family -- including one that happens to duplicate
// content already reachable elsewhere in the main output -- still freshly
// emits its OWN requested export name(s) in its isolated invocation
// (quicktype has no notion of "already declared in main" at that point;
// merge-generated-fragment.mjs is what skips true duplicates, later), so
// this never false-flags a duplicative but working family: only a family
// that contributed nothing beyond the shared discovery baseline returns an
// empty set here.
export function newExportNames(baselineText, fragmentText) {
  const baseline = exportedConstNames(baselineText);
  const fragment = exportedConstNames(fragmentText);
  const added = new Set();
  for (const name of fragment) {
    if (!baseline.has(name)) {
      added.add(name);
    }
  }
  return added;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , baselinePath, fragmentPath] = process.argv;
  if (!baselinePath || !fragmentPath) {
    console.error(
      "Usage: node scripts/count-new-exports.mjs <baseline.ts> <fragment.ts>"
    );
    process.exit(1);
  }
  const baselineText = fs.readFileSync(baselinePath, "utf8");
  const fragmentText = fs.readFileSync(fragmentPath, "utf8");
  process.stdout.write(String(newExportNames(baselineText, fragmentText).size));
}
