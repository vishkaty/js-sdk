// Regression tests for js-sdk#33: the generated zod schemas must enforce the
// value constraints declared in the UCP JSON Schemas, not just object shape.
//
// The schemas are compiled from src/spec_generated.ts by the "pretest" step so
// the test exercises the generated zod schemas directly.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  PriceSchema,
  TotalResponseSchema,
  MediaSchema,
  ProductOptionSchema,
  CheckoutCreateRequestContextSchema,
  CartResponseSchema,
  OrderLineItemSchema,
  CheckoutResponseMessageSchema,
} = require("./.dist/spec_generated.js");

const accepts = (schema, value) => schema.safeParse(value).success === true;
const rejects = (schema, value) => schema.safeParse(value).success === false;

// --- PriceSchema: the headline of issue #33 --------------------------------
// amount is { type: integer, minimum: 0 }; currency is ^[A-Z]{3}$.

test("PriceSchema rejects a negative amount (minimum: 0)", () => {
  assert.ok(rejects(PriceSchema, { amount: -50, currency: "USD" }));
});

test("PriceSchema rejects a non-integer amount (type: integer)", () => {
  assert.ok(rejects(PriceSchema, { amount: 9.99, currency: "USD" }));
});

test("PriceSchema rejects a lowercase currency (pattern ^[A-Z]{3}$)", () => {
  assert.ok(rejects(PriceSchema, { amount: 5, currency: "usd" }));
});

test("PriceSchema accepts a spec-valid price", () => {
  assert.ok(accepts(PriceSchema, { amount: 5, currency: "USD" }));
  assert.ok(accepts(PriceSchema, { amount: 0, currency: "EUR" })); // 0 = free
});

test("PriceSchema: the exact invalid payloads from issue #33 are rejected", () => {
  // Each of these `.parse()` calls succeeded before the fix.
  assert.ok(rejects(PriceSchema, { amount: -50 }));
  assert.ok(rejects(PriceSchema, { amount: 9.99 }));
  assert.ok(rejects(PriceSchema, { currency: "usd" }));
});

// --- TotalResponseSchema: object-scoped correctness ------------------------
// A signed total amount is { type: integer } WITHOUT `minimum`. The fix must
// enforce `.int()` here but must NOT wrongly add `.gte(0)` -- a discount total
// is legitimately negative.

test("TotalResponseSchema accepts a negative integer amount", () => {
  assert.ok(accepts(TotalResponseSchema, { amount: -100, type: "discount" }));
});

test("TotalResponseSchema still rejects a non-integer amount", () => {
  assert.ok(rejects(TotalResponseSchema, { amount: 1.5, type: "discount" }));
});

// --- MediaSchema: integer + minimum on dimensions --------------------------
// height / width are { type: integer, minimum: 1 }.

test("MediaSchema rejects a zero dimension (minimum: 1)", () => {
  assert.ok(
    rejects(MediaSchema, { type: "image", url: "https://x/y.png", height: 0 })
  );
});

test("MediaSchema rejects a fractional dimension (type: integer)", () => {
  assert.ok(
    rejects(MediaSchema, { type: "image", url: "https://x/y.png", width: 1.5 })
  );
});

test("MediaSchema accepts positive integer dimensions", () => {
  assert.ok(
    accepts(MediaSchema, {
      type: "image",
      url: "https://x/y.png",
      height: 1,
      width: 640,
    })
  );
});

// --- ProductOptionSchema: array minItems -----------------------------------
// values is an array with minItems: 1.

test("ProductOptionSchema rejects an empty values array (minItems: 1)", () => {
  assert.ok(rejects(ProductOptionSchema, { name: "size", values: [] }));
});

test("ProductOptionSchema accepts a non-empty values array", () => {
  assert.ok(
    accepts(ProductOptionSchema, { name: "size", values: [{ label: "S" }] })
  );
});

// ---------------------------------------------------------------------------
// Refine-layer constraints: uniqueItems, contains/minContains/maxContains, and
// object-scoped `const` (js-sdk#33 deferred these). Each field schema is
// isolated via `.shape.<field>` so the assertion targets one constraint.
// ---------------------------------------------------------------------------

const totalEntry = (type, amount = 100) => ({ amount, type });

// --- uniqueItems: Context.eligibility is { type: array, uniqueItems: true } --

test("Context.eligibility rejects duplicate items (uniqueItems)", () => {
  const schema = CheckoutCreateRequestContextSchema.shape.eligibility;
  assert.ok(rejects(schema, ["com.example.gold", "com.example.gold"]));
});

test("Context.eligibility accepts unique items (and an empty array)", () => {
  const schema = CheckoutCreateRequestContextSchema.shape.eligibility;
  assert.ok(accepts(schema, ["com.example.gold", "org.school.student"]));
  assert.ok(accepts(schema, []));
});

// --- minContains/maxContains: response totals MUST contain exactly one --------
// `subtotal` and exactly one `total` entry (Totals schema, both bounds = 1).

test("CartResponse.totals rejects totals missing the subtotal entry", () => {
  const schema = CartResponseSchema.shape.totals;
  assert.ok(rejects(schema, [totalEntry("total")]));
});

test("CartResponse.totals rejects two subtotals (maxContains: 1)", () => {
  const schema = CartResponseSchema.shape.totals;
  assert.ok(
    rejects(schema, [
      totalEntry("subtotal"),
      totalEntry("subtotal"),
      totalEntry("total"),
    ])
  );
});

test("CartResponse.totals accepts exactly one subtotal and one total", () => {
  const schema = CartResponseSchema.shape.totals;
  assert.ok(
    accepts(schema, [
      totalEntry("subtotal"),
      totalEntry("tax"),
      totalEntry("total"),
    ])
  );
});

// --- object-scoping: an itemized `totals` field (LineItem/Order line) carries
// NO contains rule and must accept a breakdown without subtotal/total. Same
// field name as above, different containing object -> must not be constrained.

test("OrderLineItem.totals accepts an itemized breakdown with no subtotal/total", () => {
  const schema = OrderLineItemSchema.shape.totals;
  assert.ok(accepts(schema, [totalEntry("tax"), totalEntry("fee")]));
  assert.ok(accepts(schema, []));
});

// --- object-scoped `const`: message_error/info/warning each pin `type` to a
// different const. They collapse into one Message schema, so `type` is
// genuinely ambiguous and MUST NOT be locked to any single const value.

test("CheckoutResponseMessage.type is not locked to a single const value", () => {
  const schema = CheckoutResponseMessageSchema.shape.type;
  assert.ok(accepts(schema, "error"));
  assert.ok(accepts(schema, "info"));
  assert.ok(accepts(schema, "warning"));
  assert.ok(rejects(schema, "not-a-message-type"));
});
