import assert from "node:assert/strict";
import test from "node:test";
import { AgentControl } from "../control.ts";
import { AgentTranscriptViewer } from "../viewer.ts";

function control(): any {
 const c = new AgentControl({} as any, "/tmp/pi-agents/index.ts") as any;
 c.persistState = () => {};
 c.changed = () => {};
 c.scheduleQueued = async () => {};
 c.notices = [];
 c.deliver = async (...args: unknown[]) => { c.notices.push(args); };
 return c;
}

test("explicit cancellation rejects without overwriting result or emitting an error", async () => {
 const c = control();
 let reject!: (error: Error) => void;
 const pending = new Promise<void>((_, fail) => { reject = fail; });
 const record: any = { path: "/root/worker", parentPath: "/root", launchGeneration: 0,
  holdsExecutionSlot: true, finalAnswer: "previous result",
  session: { sendCustomMessage: () => pending, isIdle: true } };
 c.launch(record, "work");
 record.cancelledGeneration = record.launchGeneration;
 record.status = "interrupted";
 reject(new Error("This operation was aborted"));
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(record.status, "interrupted");
 assert.equal(record.finalAnswer, "previous result");
 c.completeRun(record, [{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", timestamp: 123 }]);
 assert.equal(record.status, "interrupted");
 assert.equal(record.finalAnswer, "previous result");
 assert.deepEqual(c.notices, []);
});

test("late rejection from old run cannot overwrite a new run", async () => {
 const c = control();
 let reject!: (error: Error) => void;
 const record: any = { path: "/root/worker", parentPath: "/root", launchGeneration: 0,
  holdsExecutionSlot: true, session: { sendCustomMessage: () => new Promise((_, fail) => { reject = fail; }), isIdle: false } };
 c.launch(record, "work");
 record.cancelledGeneration = record.launchGeneration;
 record.launchGeneration++;
 reject(new Error("aborted"));
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(record.status, "running");
});

test("live tool events retain partial output and stop the execution clock", () => {
 const c = control();
 let emit!: (event: any) => void;
 const record: any = { path: "/root/worker", session: { subscribe: (listener: any) => { emit = listener; return () => {}; } } };
 c.subscribe(record);
 emit({ type: "tool_execution_start", toolCallId: "t", toolName: "bash" });
 const start = record.liveTools.get("t").startedAt;
 const partial = { content: [{ type: "text", text: "working" }], details: {} };
 emit({ type: "tool_execution_update", toolCallId: "t", partialResult: partial });
 assert.equal(record.liveTools.get("t").partial, partial);
 emit({ type: "tool_execution_end", toolCallId: "t" });
 assert.ok(record.liveTools.get("t").endedAt >= start);
 assert.equal(record.liveTools.get("t").partial, undefined);
 assert.equal(record.activity.label, "Waiting for model");
});

test("viewer shows tool elapsed time separately from model waiting", () => {
 const viewer = Object.create(AgentTranscriptViewer.prototype) as any;
 viewer.tui = { terminal: { rows: 24 } };
 viewer.theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
 viewer.content = { render: () => [] };
 viewer.followTail = true;
 viewer.snapshot = { agent: { path: "/root/w", status: "running", model: "test/model" }, messages: [], createdAt: 1,
 liveTools: new Map([["t", { name: "bash", startedAt: Date.now() - 32000 }]]),
 activity: { label: "Waiting for model", since: Date.now() - 18000 } };
 assert.match(viewer.render(160).join("\n"), /bash executing · 32s/);
 viewer.snapshot.liveTools.get("t").endedAt = Date.now();
 assert.match(viewer.render(160).join("\n"), /Waiting for model · 18s/);
 assert.doesNotMatch(viewer.render(160).join("\n"), /bash executing/);
});
