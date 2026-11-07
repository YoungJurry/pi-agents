// Initialization-failure regression tests: real scheduler/delivery/persistence,
// fake model sessions. All test files stay in a unique temporary directory;
// no providers, API keys, subprocess tools, or network calls are used.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentControl } from "../control.ts";
import { createCollaborationTools } from "../tools.ts";

const ORIGINAL = "ORIGINAL_TASK_ONLY_READ_THE_EXPLICIT_SNAPSHOT_AND_DO_NOT_SCAN_HOME";
const FOLLOWUP = "RETRY_ONLY_PLEASE_CONTINUE_THE_PREVIOUS_COMPLETE_TASK";
const LOAD_ERROR = "model test-provider/test-model is unavailable";

function fixture(t: TestContext, failFirstLoad: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-init-failure-"));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const states: any[] = [];
  const requests: any[] = [];
  const notices: any[] = [];
  const controls: any[] = [];
  const ctx: any = {
    cwd: workspace, model: undefined, thinkingLevel: undefined,
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "isolated-audit-root",
      getEntries: () => states,
      getBranch: () => states,
    },
  };
  let failNext = failFirstLoad;

  function makeControl() {
    const pi: any = {
      appendEntry(customType: string, data: any) {
        states.push({ type: "custom", customType, data: structuredClone(data) });
      },
      sendMessage(message: any) { notices.push(structuredClone(message)); },
    };
    const control: any = new AgentControl(pi, path.join(process.cwd(), "index.ts"), 2, 2);
    control.root = { ctx, sessionId: "isolated-audit-root", cwd: workspace };
    control.pathBySessionId.set("isolated-audit-root", "/root");
    control.childSessionDirectory = path.join(directory, "sessions");
    control.agentResultDirectory = path.join(directory, "results");

    // Only SDK/model initialization is replaced. The actual failure branch,
    // followup dispatcher, FIFO scheduler, launch(), and state persistence run unchanged.
    control.ensureLoaded = async (record: any) => {
      if (record.session) return;
      if (failNext) { failNext = false; throw new Error(LOAD_ERROR); }
      const manager = SessionManager.open(record.sessionFile);
      const listeners = new Set<(event: any) => void>();
      const session: any = {
        sessionId: manager.getSessionId(), sessionManager: manager,
        isIdle: true, isStreaming: false,
        get messages() { return manager.buildSessionContext().messages; },
        subscribe(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
        sendCustomMessage(message: any, options: any) {
          manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
          requests.push({
            id: record.id, sessionFile: record.sessionFile,
            incoming: message.content, context: structuredClone(this.messages),
          });
          // A deterministic dummy response persists the test transcript; no model is called.
          manager.appendMessage({
            role: "assistant", content: [{ type: "text", text: "Dummy response; no tools executed." }],
            api: "audit", provider: "audit", model: "dummy", stopReason: "stop", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          } as any);
          this.isIdle = !options.triggerTurn;
          this.isStreaming = !!options.triggerTurn;
          return Promise.resolve();
        },
        async abort() { this.isIdle = true; this.isStreaming = false; },
        dispose() {},
      };
      record.session = session;
      record.loaded = true;
      control.subscribe(record);
    };
    controls.push(control);
    return control;
  }

  const control = makeControl();
  const [record] = control.materializeQueuedBatch(ctx, [{
    request: { taskName: "audit_child", message: ORIGINAL, forkTurns: "none" },
    childPath: "/root/audit_child", callerPath: "/root",
    role: { name: "default", nicknameCandidates: ["Audit"] },
    selectedModel: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "max", forkMessages: [],
  }]);
  t.after(async () => {
    try { for (const c of controls) await c.shutdown(); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  async function followup(c = control, target = record) {
    const dispatcher: any = createCollaborationTools(c).find(tool => tool.name === "agent_action");
    return dispatcher.execute("audit-only", {
      action: "followup_task",
      arguments: { target: target.path, message: FOLLOWUP },
    }, undefined, undefined, ctx);
  }
  return { control, record, ctx, states, requests, notices, makeControl, followup };
}

test("REGRESSION: a failed initial load must not lose the original task on followup", async t => {
  const f = fixture(t, true);
  assert.ok(f.record.queuedMessage.includes(ORIGINAL));
  await f.control.scheduleQueued();
  assert.equal(f.record.status, "errored");
  assert.equal(f.record.statusMessage, LOAD_ERROR);
  assert.equal(f.requests.length, 0);
  assert.equal(f.states[0].data.agents[0].queuedMessage.includes(ORIGINAL), true);
  assert.ok(f.record.queuedMessage.includes(ORIGINAL));
  await f.followup();
  assert.equal(f.record.status, "running");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].incoming.split(ORIGINAL).length - 1, 1);
  assert.ok(f.requests[0].incoming.includes(FOLLOWUP));
  assert.ok(f.requests[0].incoming.includes(ORIGINAL), "BUG: retry delivered only the new message; original assignment was discarded");
});

test("REGRESSION: restoring errored state must retain the unconsumed task before retry", async t => {
  const f = fixture(t, true);
  await f.control.scheduleQueued();
  await f.control.shutdown();
  const restored = f.makeControl();
  restored.restoreState(f.ctx);
  const record = restored.agentsByPath.get(f.record.path);
  assert.equal(record.id, f.record.id);
  assert.equal(record.sessionFile, f.record.sessionFile);
  await f.followup(restored, record);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].incoming.includes(FOLLOWUP));
  assert.ok(f.requests[0].incoming.includes(ORIGINAL), "BUG: latest persisted state also lost the original task");
});

for (const unload of [false, true]) {
  test("CONTROL: successful launch -> interrupt -> " + (unload ? "unload -> " : "") + "followup retains existing history", async t => {
    const f = fixture(t, false);
    await f.control.scheduleQueued();
    assert.ok(f.requests[0].incoming.includes(ORIGINAL));
    await f.control.interrupt(f.ctx, f.record.path);
    assert.equal(f.record.status, "interrupted");
    if (unload) f.control.unload(f.record);
    await f.followup();
    assert.equal(f.requests.length, 2);
    const current = f.requests[1];
    assert.equal(current.id, f.record.id);
    assert.equal(current.sessionFile, f.record.sessionFile);
    assert.ok(JSON.stringify(current.context).includes(ORIGINAL), "Existing session history must remain available");
    assert.ok(current.incoming.includes(FOLLOWUP));
  });
}

test("queued supplementary mail survives initialization failure and is consumed once", async t => {
  const f = fixture(t, true);
  const mail = "SUPPLEMENTAL_READONLY_BOUNDARY";
  await f.control.message(f.ctx, { target: f.record.path, message: mail, triggerTurn: false });
  await f.control.scheduleQueued();
  assert.equal(f.record.status, "errored");
  assert.ok(f.record.queuedMessage.includes(ORIGINAL));
  assert.ok(f.record.queuedMail[0].includes(mail));
  await f.followup();
  const input = f.requests[0].incoming;
  assert.equal(input.split(mail).length - 1, 1);
  assert.equal(input.split(ORIGINAL).length - 1, 1);
  assert.equal(input.split(FOLLOWUP).length - 1, 1);
  assert.equal(f.record.queuedMessage, undefined);
  assert.equal(f.record.queuedMail, undefined);
});
