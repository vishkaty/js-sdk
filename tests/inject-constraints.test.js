// Injector-level tests for the refine layer (js-sdk#33 deferred constraints).
//
// The spec-constraints tests exercise the constraints that current UCP schemas
// happen to expose in the generated output. These tests drive
// scripts/inject-schema-constraints.mjs directly against small fixture schemas,
// so every new constraint type -- `const`, `uniqueItems`, and
// `contains`/minContains/maxContains -- gets an explicit failing-before /
// passing-after check plus idempotency and object-scoped ambiguity coverage,
// independent of what the live spec surface contains.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const INJECTOR = path.join(
  REPO_ROOT,
  "scripts",
  "inject-schema-constraints.mjs"
);

// A fixture module written as plain CJS + zod so it can be required directly,
// before and after injection, with no TypeScript compile step. The injector
// parses it with the TypeScript compiler API, which accepts this syntax.
const FIXTURE_SOURCE = `const { z } = require("zod");

const BadgeSchema = z.object({
  "kind": z.string(),
  "label": z.string(),
});

const TagsSchema = z.object({
  "tags": z.array(z.string()),
});

const LedgerSchema = z.object({
  "entries": z.array(z.object({ "type": z.string(), "amount": z.number() })),
});

const CodeSchema = z.object({
  "code": z.string(),
});

module.exports = { BadgeSchema, TagsSchema, LedgerSchema, CodeSchema };
`;

const SCHEMAS = {
  // { kind: const "gold", label } -> const refine on `kind`.
  "badge.json": {
    type: "object",
    properties: {
      kind: { type: "string", const: "gold" },
      label: { type: "string" },
    },
  },
  // { tags: array uniqueItems } -> uniqueItems refine on `tags`.
  "tags.json": {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" }, uniqueItems: true },
    },
  },
  // { entries: array that must contain exactly one { type: "opening" } } ->
  // contains refine on `entries`.
  "ledger.json": {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string" }, amount: { type: "number" } },
        },
        contains: {
          properties: { type: { const: "opening" } },
          required: ["type"],
        },
        minContains: 1,
        maxContains: 1,
      },
    },
  },
  // Two objects that share the property set { code } but disagree on the const
  // for `code` -> ambiguous -> `code` must be left untouched.
  "code_a.json": {
    type: "object",
    properties: { code: { type: "string", const: "A" } },
  },
  "code_b.json": {
    type: "object",
    properties: { code: { type: "string", const: "B" } },
  },
};

function setup() {
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, "tests", ".inject-tmp-"));
  const schemaDir = path.join(dir, "schemas");
  fs.mkdirSync(schemaDir);
  for (const [name, doc] of Object.entries(SCHEMAS)) {
    fs.writeFileSync(path.join(schemaDir, name), JSON.stringify(doc, null, 2));
  }
  const modulePath = path.join(dir, "fixture.js");
  fs.writeFileSync(modulePath, FIXTURE_SOURCE);
  return { dir, schemaDir, modulePath };
}

function runInjector(schemaDir, modulePath) {
  return execFileSync("node", [INJECTOR, schemaDir, modulePath], {
    encoding: "utf8",
  });
}

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test("refine layer: const / uniqueItems / contains inject and enforce; ambiguous const is skipped; injection is idempotent", () => {
  const { dir, schemaDir, modulePath } = setup();
  try {
    // --- failing-before: the un-injected fixture enforces none of these ------
    const before = freshRequire(modulePath);
    assert.ok(
      before.BadgeSchema.safeParse({ kind: "silver", label: "x" }).success,
      "pre-injection: a wrong const value is (wrongly) accepted"
    );
    assert.ok(
      before.TagsSchema.safeParse({ tags: ["a", "a"] }).success,
      "pre-injection: duplicate items are (wrongly) accepted"
    );
    assert.ok(
      before.LedgerSchema.safeParse({ entries: [] }).success,
      "pre-injection: a missing required entry is (wrongly) accepted"
    );

    // --- inject ---------------------------------------------------------------
    const firstReport = runInjector(schemaDir, modulePath);
    const injectedText = fs.readFileSync(modulePath, "utf8");

    // Text-level: the expected methods are present, and the ambiguous field is
    // left untouched.
    assert.match(
      injectedText,
      /"kind": z\.string\(\)\.refine\(\(v\) => v === "gold"/
    );
    assert.match(
      injectedText,
      /"tags": z\.array\(z\.string\(\)\)\.refine\(\(arr\) => new Set/
    );
    assert.match(
      injectedText,
      /"entries": z\.array\([\s\S]*?\)\.refine\(\(arr\) => \{ const count/
    );
    assert.doesNotMatch(
      injectedText,
      /"code": z\.string\(\)\.refine/,
      "ambiguous const across a shared property-set must not be injected"
    );
    assert.match(firstReport, /1 property\(ies\) left untouched/);

    // --- passing-after: behaviour is now enforced ----------------------------
    const after = freshRequire(modulePath);

    // const
    assert.ok(
      !after.BadgeSchema.safeParse({ kind: "silver", label: "x" }).success
    );
    assert.ok(
      after.BadgeSchema.safeParse({ kind: "gold", label: "x" }).success
    );
    // uniqueItems
    assert.ok(!after.TagsSchema.safeParse({ tags: ["a", "a"] }).success);
    assert.ok(after.TagsSchema.safeParse({ tags: ["a", "b"] }).success);
    // contains / minContains / maxContains
    assert.ok(!after.LedgerSchema.safeParse({ entries: [] }).success);
    assert.ok(
      !after.LedgerSchema.safeParse({
        entries: [
          { type: "opening", amount: 1 },
          { type: "opening", amount: 2 },
        ],
      }).success
    );
    assert.ok(
      after.LedgerSchema.safeParse({
        entries: [
          { type: "opening", amount: 1 },
          { type: "line", amount: 2 },
        ],
      }).success
    );
    // ambiguous const: still unconstrained
    assert.ok(after.CodeSchema.safeParse({ code: "anything" }).success);

    // --- idempotency: a second run injects nothing and leaves bytes intact ----
    const secondReport = runInjector(schemaDir, modulePath);
    assert.match(secondReport, /0 field\(s\) constrained/);
    assert.equal(fs.readFileSync(modulePath, "utf8"), injectedText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
