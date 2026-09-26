/**
 * Typert contract test — guards the dual-shape strict-codec contract.
 *
 * DSH changed the strict-codec validation twice across the 0.1.x line:
 *   - <= 0.1.5: validators require a live zod schema (`codec.schema` with a
 *     working `.parse()`); `create` is ignored.
 *   - >= 0.1.7: validators require a `codec.create()` factory returning the
 *     schema; `schema` is ignored.
 * Each side only checks its own field, so a codec carrying BOTH shapes passes
 * every 0.1.x loader (verified against 0.1.0-rc.7, 0.1.5, 0.1.6-alpha.2 and
 * 0.1.7-rc.1). This test pins that contract for both halves:
 *
 *   1. Host half — every parameter/result codec in typert.host.js must expose
 *      `schema.parse()` (0.1.5 contract) AND `create()` (0.1.7 contract).
 *   2. Client half — execute the client.js bundle factory and capture the
 *      CLIENT_REMOTE contribution through ctx.remote.$mount; every codec must
 *      satisfy the same dual contract (passthrough schemas for the browser).
 *
 * Run: node scripts/test-typert-contract.mjs   (also part of `npm test`)
 */

import assert from "node:assert/strict";
import { TYPERT } from "../typert.host.js";

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks += 1;
};

/** Every strict codec must satisfy BOTH host-side contract shapes. */
function checkCodec(codec, where) {
  ok(codec !== null && typeof codec === "object", `${where}: codec must be an object`);
  ok(codec.mode === "strict", `${where}: codec.mode must be "strict"`);
  ok(typeof codec.typeSymbol === "string" && codec.typeSymbol.length > 0, `${where}: typeSymbol must be a non-empty string`);
  // <= 0.1.5: live schema with working parse().
  ok(codec.schema !== null && typeof codec.schema === "object", `${where}: codec.schema must be a live schema object (<=0.1.5 contract)`);
  ok(typeof codec.schema.parse === "function", `${where}: codec.schema.parse must be a function (<=0.1.5 contract)`);
  // >= 0.1.7: create() factory returning the schema.
  ok(typeof codec.create === "function", `${where}: codec.create must be a factory function (>=0.1.7 contract)`);
  const produced = codec.create();
  ok(produced !== null && typeof produced === "object", `${where}: codec.create() must return a schema object`);
  ok(typeof produced.parse === "function", `${where}: codec.create().parse must be a function`);
}

// ---- 1. Host manifest (typert.host.js) ------------------------------------

ok(TYPERT.package === "@duke-dsh-plugins/dsh-memory-manager", "manifest package must match package.json name");
ok(TYPERT.face === "host", "manifest face must be host");
ok(Array.isArray(TYPERT.invocations) && TYPERT.invocations.length > 0, "manifest must declare invocations");

for (const invocation of TYPERT.invocations) {
  ok(invocation.id.includes("#"), `invocation ${invocation.id}: id must contain #`);
  ok(Array.isArray(invocation.parameters), `${invocation.id}: parameters must be an array`);
  invocation.parameters.forEach((parameter, i) => {
    checkCodec(parameter.codec, `${invocation.id} parameter[${i}] (${parameter.name})`);
  });
  checkCodec(invocation.result, `${invocation.id} result`);
}

// ---- 2. Client bundle (client.js CLIENT_REMOTE via $mount) -----------------

const registrations = [];
globalThis.window = {
  __ModuleLoader__: { load: (registration) => registrations.push(registration) },
};
await import("../client.js");
assert.equal(registrations.length, 1, "client.js must register exactly one module");
const registration = registrations[0];

// Execute the factory with stubs: react + ui primitives are the only requires.
const stubModule = new Proxy({}, { get: (_t, prop) => (prop === "default" ? {} : () => null) });
const moduleExports = registration.factory((name) => {
  if (name === "react" || name === "react/jsx-runtime") return stubModule;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return stubModule;
  throw new Error(`client.js factory must not require unexpected module: ${name}`);
});
checks += 1;
ok(typeof moduleExports.apply === "function", "client module must export apply()");
ok(Array.isArray(moduleExports.inject) && moduleExports.inject.includes("remote"), "client module must inject remote");

// apply() mounts CLIENT_REMOTE first; capture it and stop before any DOM work.
let contribution = null;
const mountSentinel = Symbol("mount-captured");
const fakeCtx = {
  remote: {
    $mount: async (c) => {
      contribution = c;
      throw mountSentinel;
    },
  },
};
let applyError = null;
try {
  await moduleExports.apply(fakeCtx);
} catch (error) {
  applyError = error;
}
assert.equal(applyError, mountSentinel, "apply() must reach ctx.remote.$mount before touching the DOM");

ok(contribution !== null, "ctx.remote.$mount must receive the CLIENT_REMOTE contribution");
ok(contribution.package === "dsh-memory-manager", "contribution package must stay unscoped dsh-memory-manager");
ok(Array.isArray(contribution.descriptors) && contribution.descriptors.length === 8, "contribution must declare 8 descriptors");
for (const descriptor of contribution.descriptors) {
  ok(descriptor.service === "memoryManager", `${descriptor.id}: service must be memoryManager`);
  ok(descriptor.namespace === "memoryManager", `${descriptor.id}: namespace must be memoryManager`);
  descriptor.parameters.forEach((parameter, i) => {
    checkCodec(parameter.codec, `${descriptor.id} parameter[${i}] (${parameter.name})`);
  });
  checkCodec(descriptor.result, `${descriptor.id} result`);
}

console.log(`typert-contract: ${checks} checks passed`);
