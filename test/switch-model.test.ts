import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AgentControl } from "../control.ts";
import { createCollaborationTools } from "../tools.ts";
import { DIRECT_AGENT_TOOL_NAMES } from "../types.ts";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(t: TestContext) {
	const entries: any[] = [];
	const control: any = new AgentControl({
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage() {},
	} as any, "/tmp/pi-agents/index.ts", 1, 1);
	const ctx = { cwd: "/tmp", getSystemPrompt: () => "", sessionManager: { getSessionId: () => "root-session" } };
	control.root = { ctx, cwd: "/tmp", sessionId: "root-session", systemPrompt: "" };
	control.pathBySessionId.set("root-session", "/root");
	const models = [
		{ provider: "test", id: "old", reasoning: true },
		{ provider: "test", id: "new", reasoning: true },
		{ provider: "other", id: "plain", reasoning: false },
	];
	const runtime: any = {
		getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getModels: () => models,
		checkAuth: async () => ({}),
	};
	control.modelRuntime = runtime;
	const record: any = {
		id: "01234567-89ab-cdef-0123-456789abcdef", path: "/root/worker",
		parentPath: "/root", parentId: "root-session", taskName: "worker", nickname: "Ada",
		role: "default", modelProvider: "test", modelId: "old", thinkingLevel: "high",
		status: "errored", statusMessage: "old provider failed", finalAnswer: "stored result",
		resultFile: "/tmp/stored-result.md", sessionFile: "/tmp/stored-session.jsonl",
		createdAt: 1, updatedAt: 1, lastUsedAt: 1, lastAssignedAt: 1,
		loaded: false, holdsExecutionSlot: false, launchGeneration: 7,
	};
	control.agentsByPath.set(record.path, record);
	control.pathBySessionId.set(record.id, record.path);
	function load() {
		const session: any = {
			model: models[0], thinkingLevel: "high", isIdle: true, isStreaming: false,
			messages: [{ role: "user", content: "original context" }],
			calls: [] as any[], disposed: false,
			async setModel(model: any) {
				if (!(await runtime.checkAuth(model.provider))) throw new Error("No API key");
				this.model = model;
			},
			setThinkingLevel(level: string) { this.thinkingLevel = level; },
			dispose() { this.disposed = true; },
		};
		record.session = session;
		record.loaded = true;
		return session;
	}
	t.after(() => control.shutdown());
	return { control, ctx, record, entries, runtime, models, load };
}

test("unloaded model changes preserve identity, history references, results and lifecycle without loading", async (t) => {
	const f = fixture(t);
	f.control.loadSession = async () => { assert.fail("model selection must not load a session"); };
	const before = structuredClone(f.record);
	const result = await f.control.switchModel(f.ctx, "worker", "test/new");
	assert.equal(result.model, "test/new");
	assert.equal(result.thinkingLevel, "high");
	assert.equal(result.status, "errored");
	assert.equal(result.loaded, false);
	assert.deepEqual(f.record, { ...before, modelId: "new", updatedAt: f.record.updatedAt, sessionOperationTail: undefined });
	assert.equal(f.control.activeExecutionSlots, 0);
	const saved = f.entries.at(-1).data.agents[0];
	assert.equal(saved.modelId, "new");
	assert.equal(saved.thinkingLevel, "high");
	assert.equal(saved.sessionFile, before.sessionFile);

	const restored: any = new AgentControl({} as any, "/tmp/pi-agents/index.ts");
	t.after(() => restored.shutdown());
	restored.restoreState({ sessionManager: { getSessionId: () => "root-session", getBranch: () => f.entries } });
	assert.equal(restored.agentsByPath.get(f.record.path).modelId, "new");
	assert.equal(restored.agentsByPath.get(f.record.path).id, before.id);
	assert.equal(restored.agentsByPath.get(f.record.path).loaded, false);
});

test("loaded model changes use native selection without abort, restart or history replacement", async (t) => {
	const f = fixture(t);
	const session = f.load();
	session.isIdle = false;
	session.isStreaming = true;
	f.record.status = "running";
	f.record.holdsExecutionSlot = true;
	f.control.activeExecutionSlots = 1;
	const messages = session.messages;
	const result = await f.control.switchModel(f.ctx, f.record.id, "test/new", "low");
	assert.equal(f.record.session, session);
	assert.equal(session.messages, messages);
	assert.equal(session.model, f.models[1]);
	assert.equal(session.thinkingLevel, "low");
	assert.equal(session.isStreaming, true);
	assert.equal(result.status, "running");
	assert.equal(f.control.activeExecutionSlots, 1);
	assert.equal(f.record.launchGeneration, 7);
	// Fake sessions need no abort during fixture shutdown.
	session.isStreaming = false;
});

for (const status of ["completed", "interrupted", "errored"]) {
	test(`switching a loaded ${status} agent does not wake it`, async (t) => {
		const f = fixture(t);
		const session = f.load();
		f.record.status = status;
		assert.equal((await f.control.switchModel(f.ctx, "worker", "test/new")).status, status);
		assert.equal(session.isIdle, true);
		assert.equal(f.control.activeExecutionSlots, 0);
		assert.equal(f.record.lastAssignedAt, 1);
	});
}

test("queued model changes preserve FIFO position, mailbox and assignment", async (t) => {
	const f = fixture(t);
	Object.assign(f.record, { status: "queued", queuedAt: 100, queuedMessage: "original task", queuedMail: ["mail"] });
	await f.control.switchModel(f.ctx, "worker", "other/plain", "max");
	assert.equal(f.record.status, "queued");
	assert.equal(f.record.queuedAt, 100);
	assert.equal(f.control.view(f.record).queuePosition, 1);
	assert.equal(f.record.queuedMessage, "original task");
	assert.deepEqual(f.record.queuedMail, ["mail"]);
	assert.equal(f.record.thinkingLevel, "off");
	assert.equal(f.record.loaded, false);
});

test("model lookup and authentication failures leave the selection unchanged", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.control.switchModel(f.ctx, "worker", "missing/model"), /not found/);
	await assert.rejects(f.control.switchModel(f.ctx, "worker", "  "), /no sub-agent model/);
	f.runtime.checkAuth = async () => undefined;
	await assert.rejects(f.control.switchModel(f.ctx, "worker", "test/new"), /No API key/);
	assert.equal(f.record.modelId, "old");
	assert.equal(f.record.thinkingLevel, "high");
	assert.equal(f.entries.length, 0);
	f.load();
	await assert.rejects(f.control.switchModel(f.ctx, "worker", "test/new"), /No API key/);
	assert.equal(f.record.session.model.id, "old");
	assert.equal(f.record.modelId, "old");
	assert.equal(f.entries.length, 0);
});

test("root, self and unknown targets are rejected", async (t) => {
	const f = fixture(t);
	await assert.rejects(f.control.switchModel(f.ctx, "/root", "test/new"), /root is not a spawned agent/);
	await assert.rejects(f.control.switchModel(f.ctx, "unknown", "test/new"), /not found/);
	const childCtx = { sessionManager: { getSessionId: () => f.record.id } };
	await assert.rejects(f.control.switchModel(childCtx, f.record.path, "test/new"), /own model/);
	assert.equal(f.entries.length, 0);
});

test("concurrent switches serialize and recover after a rejected selection", async (t) => {
	const f = fixture(t);
	const gate = deferred();
	const started = deferred();
	let checks = 0;
	f.runtime.checkAuth = async () => {
		if (++checks === 1) { started.resolve(); await gate.promise; return undefined; }
		return {};
	};
	const first = f.control.switchModel(f.ctx, "worker", "test/new");
	const rejected = assert.rejects(first, /No API key/);
	await started.promise;
	const second = f.control.switchModel(f.ctx, "worker", "other/plain");
	assert.equal(checks, 1);
	gate.resolve();
	await rejected;
	await second;
	assert.equal(f.record.modelProvider, "other");
	assert.equal(f.record.modelId, "plain");
	assert.equal(f.record.sessionOperationTail, undefined);
});

test("switching during initialization updates the loaded session before later work", async (t) => {
	const f = fixture(t);
	const gate = deferred();
	const started = deferred();
	f.record.status = "pending_init";
	f.control.loadSession = async () => { started.resolve(); await gate.promise; f.load(); };
	const loading = f.control.ensureLoaded(f.record);
	await started.promise;
	const switching = f.control.switchModel(f.ctx, "worker", "test/new");
	gate.resolve();
	await Promise.all([loading, switching]);
	assert.equal(f.record.session.model.id, "new");
	assert.equal(f.record.modelId, "new");
	assert.equal(f.record.status, "pending_init");
});

test("loading waits for an earlier switch without requiring the old model", async (t) => {
	const f = fixture(t);
	const gate = deferred();
	const started = deferred();
	f.runtime.checkAuth = async () => { started.resolve(); await gate.promise; return {}; };
	const switching = f.control.switchModel(f.ctx, "worker", "test/new");
	await started.promise;
	let loaded = false;
	f.control.loadSession = async (record: any) => { assert.equal(record.modelId, "new"); loaded = true; };
	const loading = f.control.ensureLoaded(f.record);
	await Promise.resolve();
	assert.equal(loaded, false);
	gate.resolve();
	await Promise.all([switching, loading]);
	assert.equal(loaded, true);
});

test("idle residents cannot be evicted during an async switch", async (t) => {
	const f = fixture(t);
	const session = f.load();
	const gate = deferred();
	const started = deferred();
	f.runtime.checkAuth = async () => { started.resolve(); await gate.promise; return {}; };
	const switching = f.control.switchModel(f.ctx, "worker", "test/new");
	await started.promise;
	assert.equal(f.control.tryEvictForResidency("/root/another"), false);
	assert.equal(session.disposed, false);
	gate.resolve();
	await switching;
	assert.equal(f.control.tryEvictForResidency("/root/another"), true);
	assert.equal(session.disposed, true);
});

test("catalog exposes switching through the unchanged compact dispatcher", async (t) => {
	const f = fixture(t);
	const tools: any[] = createCollaborationTools(f.control);
	const action = tools.find((tool) => tool.name === "agent_action");
	const listing = await tools.find((tool) => tool.name === "list_agents")
		.execute("catalog", { view: "tools" }, undefined, undefined, f.ctx);
	assert.ok(listing.details.toolCatalog.some((tool: any) => tool.name === "switch_agent_model"));
	assert.ok(DIRECT_AGENT_TOOL_NAMES.includes("switch_agent_model"));
	const output = await action.execute("switch", {
		action: "switch_agent_model", arguments: { target: "worker", model: "test/new", reasoning_effort: "low" },
	}, undefined, undefined, f.ctx);
	const payload = JSON.parse(output.content[0].text);
	assert.equal(payload.model, "test/new");
	assert.equal(payload.thinking_level, "low");
	assert.equal(payload.wakes_agent, false);
	assert.equal(payload.applies_to, "next_request");
	for (const args of [{ target: "worker" }, { target: "worker", model: "" }, { target: "worker", model: "test/new", reasoning_effort: "invalid" }]) {
		await assert.rejects(action.execute("bad", { action: "switch_agent_model", arguments: args }, undefined, undefined, f.ctx), /Invalid arguments/);
	}
});

test("queued scheduling resumes after a switching resident becomes evictable", async (t) => {
	const f = fixture(t);
	const session = f.load();
	const gate = deferred();
	const started = deferred();
	f.runtime.checkAuth = async () => { started.resolve(); await gate.promise; return {}; };
	const switching = f.control.switchModel(f.ctx, "worker", "test/new");
	await started.promise;
	const waiting = {
		...f.record, id: "waiting-session", path: "/root/waiting", taskName: "waiting",
		status: "queued", queuedAt: 100, queuedMessage: "existing queued task",
		loaded: false, session: undefined, sessionOperationTail: undefined,
	};
	f.control.agentsByPath.set(waiting.path, waiting);
	f.control.loadSession = async (record: any) => {
		await f.control.evictForResidency(record.path);
		record.session = { isIdle: true, dispose() {} };
		record.loaded = true;
	};
	const launched = deferred();
	f.control.launch = (record: any, content: string) => {
		assert.equal(content, "existing queued task");
		record.status = "running";
		launched.resolve();
	};
	await f.control.scheduleQueued();
	assert.equal(waiting.status, "queued");
	assert.equal(session.disposed, false);
	gate.resolve();
	await switching;
	await launched.promise;
	assert.equal(session.disposed, true);
	assert.equal(waiting.status, "running");
	assert.equal(f.control.activeExecutionSlots, 1);
});

test("shutdown waits for accepted switches before disposal and rejects later switches", async (t) => {
	const f = fixture(t);
	const session = f.load();
	const gate = deferred();
	const started = deferred();
	f.runtime.checkAuth = async () => { started.resolve(); await gate.promise; return {}; };
	const switching = f.control.switchModel(f.ctx, "worker", "test/new");
	await started.promise;
	const shutdown = f.control.shutdown();
	assert.equal(session.disposed, false);
	gate.resolve();
	await Promise.all([switching, shutdown]);
	assert.equal(session.disposed, true);
	assert.equal(f.record.modelId, "new");
	assert.equal(f.entries.at(-1).data.agents[0].modelId, "new");
	await assert.rejects(f.control.switchModel(f.ctx, "worker", "other/plain"), /shutting down/);
});

