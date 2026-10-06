import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parsePlan, dockerArgs } from "./index.mjs";
test("validates plans and sets sandbox boundaries", () => {
  assert.deepEqual(parsePlan('{"plan":["run"],"code":"print(1)"}'), { plan: ["run"], code: "print(1)" });
  assert.throws(() => parsePlan('{"plan":[],"code":""}'));
  const args = dockerArgs("test", "print(1)");
  for (const flag of ["--network", "none", "--read-only", "--memory", "--pids-limit", "--cap-drop", "ALL", "--user"])
    assert.ok(args.includes(flag));
  assert.equal(args.at(-1), "print(1)");
});
