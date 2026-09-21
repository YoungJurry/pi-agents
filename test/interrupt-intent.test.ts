import assert from "node:assert/strict";
import test from "node:test";
import { AgentControl } from "../control.ts";

test("interrupt records intent before abort can emit error completion", async () => {
 const c = new AgentControl({} as any, "/tmp/pi-agents/index.ts") as any;
 const notices: unknown[] = [];
 const record: any = { id: "child", path: "/root/worker", parentPath: "/root", status: "running",
  launchGeneration: 7, holdsExecutionSlot: false, finalAnswer: "saved result" };
 record.session = { abort: async () => {
  assert.equal(record.cancelledGeneration, 7);
  c.completeRun(record, [{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", timestamp: 42 }]);
 } };
 c.callerPath = () => "/root";
 c.requireTarget = () => ({ path: record.path, record });
 c.ensureLoaded = async () => {};
 c.persistState = () => {};
 c.changed = () => {};
 c.scheduleQueued = async () => {};
 c.view = (value: any) => ({ status: value.status });
 c.deliver = async (...args: unknown[]) => { notices.push(args); };
 const result = await c.interrupt({}, record.path);
 assert.equal(result.status, "interrupted");
 assert.equal(record.finalAnswer, "saved result");
 assert.deepEqual(notices, []);
});
