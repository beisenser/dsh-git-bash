import assert from "node:assert/strict";
import test from "node:test";
import z from "@deepseek-ai/schemastery";

/**
 * The host validates a plugin's Config through schemastery's `~standard`
 * interface (cordis `resolveConfig`). schemastery rejects a volatile field that
 * sits under a non-fixed path, and an `intersect` is a list — so
 * `z.intersect([baseExecutorConfig, extra])` fails at `$.0.<field>` for every
 * volatile budget field of the base executor.
 *
 * This plugin's Config therefore has to be a flat object schema built from the
 * base schema's own field entries. These tests pin that contract without
 * needing the executor packages to be loadable.
 */
function hostValidate(schema, input) {
  const result = schema["~standard"].validate(input);
  assert.ok(!("then" in result), "config validation must be synchronous");
  return result;
}

/** A stand-in for the executor base schema: the same volatile budget fields. */
function baseConfig() {
  return z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120000).volatile(),
    maxTimeoutMs: z.number().default(600000).volatile(),
    maxOutputBytes: z.number().default(64000).volatile(),
    maxSpillBytes: z.number().default(67108864).volatile(),
    graceMs: z.number().default(3000).volatile(),
  });
}

test("intersect cannot carry the base executor's volatile fields", () => {
  const base = baseConfig();
  const intersected = z.intersect([base, z.object({ executable: z.string().default("") })]);
  const result = hostValidate(intersected, {});
  assert.ok(result.issues, "the host would reject an intersect around volatile fields");
  assert.match(String(result.issues[0].message), /volatile fields require a fixed object path/);
});

test("a flat rebuild of the base fields is accepted and keeps volatile refs", () => {
  const base = baseConfig();
  const flat = z.object({ ...base.dict, executable: z.string().default("").role("path") });

  const result = hostValidate(flat, {});
  assert.equal(result.issues, undefined);
  const value = result.value;

  assert.equal(typeof value.timeoutMs.get, "function", "budget fields must stay volatile refs");
  assert.equal(value.timeoutMs.get(), 120000);
  assert.equal(value.executable, "");
});

test("the flat rebuild preserves every inherited default and override", () => {
  const base = baseConfig();
  const flat = z.object({ ...base.dict, executable: z.string().default("") });

  const mine = hostValidate(flat, {}).value;
  const theirs = hostValidate(base, {}).value;
  for (const field of ["timeoutMs", "maxTimeoutMs", "maxOutputBytes", "maxSpillBytes", "graceMs"]) {
    assert.equal(mine[field].get(), theirs[field].get(), `default drift on ${field}`);
  }

  const configured = hostValidate(flat, { timeoutMs: 30000, executable: "D:\\Git\\bin\\bash.exe" }).value;
  assert.equal(configured.timeoutMs.get(), 30000);
  assert.equal(configured.executable, "D:\\Git\\bin\\bash.exe");
});

test("the plugin's Config is declared as a flat object, never an intersect", async () => {
  // The host rules depend on the declaration shape, so assert on the source:
  // `Config` must be built with `z.object` from the base schema's field entries.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

  const declaration = /export const Config = z\.object\(\{([\s\S]*?)\}\) as unknown as z<Config>;/.exec(source);
  assert.ok(declaration, "Config must be declared with z.object({...}) in src/index.ts");
  assert.match(declaration[1], /\.\.\.LOCAL_BASH_FIELDS/, "Config must reuse the base executor's fields");
  assert.match(declaration[1], /executable:/, "Config must add the executable field");

  assert.doesNotMatch(
    source,
    /z\.intersect\(\[/,
    "composing the base executor's volatile fields as a list is rejected by the host",
  );
});
