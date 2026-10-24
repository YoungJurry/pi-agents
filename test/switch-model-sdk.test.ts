import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentControl } from "../control.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

const usage = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function fixture(t: TestContext, customTools: any[] = []) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-switch-sdk-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		authPath: path.join(directory, "auth.json"), modelsPath: null,
		modelsStorePath: path.join(directory, "models-cache.json"), refreshOnCreate: false,
	});
	runtime.registerProvider("switch-test", {
		baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only",
		models: ["old", "new"].map((id) => ({
			id, name: id, reasoning: true, input: ["text"],
			cost: usage.cost, contextWindow: 100_000, maxTokens: 1000,
		})),
	});
	const oldModel = runtime.getModel("switch-test", "old")!;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, modelRuntime: runtime, model: oldModel,
		thinkingLevel: "high", sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
		settingsManager, resourceLoader: loader, noTools: "builtin", customTools,
	});
	const entries: any[] = [];
	const control: any = new AgentControl({
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage() {},
	} as any, path.join(directory, "extension.ts"));
	control.agentResultDirectory = path.join(directory, "results");
	const ctx = { cwd: directory, getSystemPrompt: () => "", isProjectTrusted: () => false, sessionManager: { getSessionId: () => "root-session" } };
	control.root = { ctx, cwd: directory, sessionId: "root-session", systemPrompt: "", model: oldModel };
	control.pathBySessionId.set("root-session", "/root");
	control.modelRuntime = runtime;
	const record: any = {
		id: session.sessionId, path: "/root/worker", parentPath: "/root", parentId: "root-session",
		taskName: "worker", role: "default", modelProvider: "switch-test", modelId: "old", thinkingLevel: "high",
		status: "completed", createdAt: 1, updatedAt: 1, lastUsedAt: 1, lastAssignedAt: 1,
		loaded: true, session, sessionFile: session.sessionFile, holdsExecutionSlot: false, launchGeneration: 0,
	};
	control.agentsByPath.set(record.path, record);
	control.pathBySessionId.set(record.id, record.path);
	control.subscribe(record);
	t.after(() => control.shutdown());
	const settled = deferred();
	session.subscribe((event) => { if (event.type === "agent_settled") settled.resolve(); });
	return { control, ctx, record, session, runtime, entries, settled, settingsManager, loader };
}

for (const phase of ["response", "tool"]) {
	test(`native SDK switches at the next request during an active ${phase}`, { timeout: 10_000 }, async (t) => {
		const responseGate = deferred();
		const toolGate = deferred();
		const firstRequest = deferred();
		const toolStarted = deferred();
		t.after(() => { responseGate.resolve(); toolGate.resolve(); });
		const f = await fixture(t, [{
			name: "probe", label: "Probe", description: "Test boundary", parameters: Type.Object({}),
			async execute() {
				toolStarted.resolve();
				await toolGate.promise;
				return { content: [{ type: "text", text: "tool result preserved" }], details: undefined };
			},
		}]);
		const requested: string[] = [];
		const contexts: any[] = [];
		let currentSignal: AbortSignal | undefined;
		f.session.agent.streamFunction = (model, context, options) => {
			requested.push(model.id);
			contexts.push(structuredClone(context));
			const stream = createAssistantMessageEventStream();
			const first = requested.length === 1;
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
				content: first ? [{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }] : [{ type: "text", text: "finished" }],
				stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: { ...message, content: [] } });
			if (first) {
				currentSignal = options?.signal;
				firstRequest.resolve();
				void responseGate.promise.then(() => { stream.push({ type: "done", reason: "toolUse", message }); stream.end(); });
			} else {
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			}
			return stream;
		};
		const originalId = f.session.sessionId;
		const originalFile = f.session.sessionFile;
		f.control.launch(f.record, "Remember the original task context.");
		await firstRequest.promise;
		if (phase === "tool") { responseGate.resolve(); await toolStarted.promise; }
		const changed = await f.control.switchModel(f.ctx, "worker", "switch-test/new");
		assert.equal(changed.status, "running");
		assert.equal(currentSignal?.aborted, false);
		assert.deepEqual(requested, ["old"]);
		assert.equal(f.session.sessionId, originalId);
		assert.equal(f.session.sessionFile, originalFile);
		responseGate.resolve();
		await toolStarted.promise;
		assert.deepEqual(requested, ["old"]);
		toolGate.resolve();
		await f.settled.promise;
		assert.deepEqual(requested, ["old", "new"]);
		assert.match(JSON.stringify(contexts[1]), /Remember the original task context/);
		assert.match(JSON.stringify(contexts[1]), /tool result preserved/);
		const assistants = f.session.messages.filter((message) => message.role === "assistant");
		assert.deepEqual(assistants.map((message) => message.model), ["old", "new"]);
		assert.equal(f.record.status, "completed");
		assert.equal(f.record.modelId, "new");
	});
}

test("native failed session stays asleep after switching and continues old context on explicit followup", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const requested: string[] = [];
	const contexts: any[] = [];
	f.session.agent.streamFunction = (model, context) => {
		requested.push(model.id);
		contexts.push(structuredClone(context));
		const stream = createAssistantMessageEventStream();
		const failed = requested.length === 1;
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
			content: failed ? [] : [{ type: "text", text: "recovered" }],
			stopReason: failed ? "error" : "stop", errorMessage: failed ? "old provider unavailable" : undefined,
			timestamp: Date.now(),
		};
		if (failed) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		stream.end();
		return stream;
	};
	await f.session.sendCustomMessage({ customType: "test", content: "Original task: keep this context.", display: false }, { triggerTurn: true });
	assert.equal(f.record.status, "errored");
	const id = f.record.id;
	const file = f.record.sessionFile;
	await f.control.switchModel(f.ctx, "worker", "switch-test/new");
	assert.deepEqual(requested, ["old"]);
	assert.equal(f.record.status, "errored");
	assert.equal(f.session.isIdle, true);
	const settled = deferred();
	f.session.subscribe((event) => { if (event.type === "agent_settled") settled.resolve(); });
	await f.control.message(f.ctx, { target: "worker", message: "Continue the original task.", triggerTurn: true });
	await settled.promise;
	assert.deepEqual(requested, ["old", "new"]);
	assert.match(JSON.stringify(contexts[1]), /Original task: keep this context/);
	assert.match(JSON.stringify(contexts[1]), /Continue the original task/);
	assert.equal(f.record.id, id);
	assert.equal(f.record.sessionFile, file);
	assert.equal(f.record.finalAnswer, "recovered");
});

test("lazy native reload uses the switched model and keeps the same persisted history", async (t) => {
	const f = await fixture(t);
	// These stubs isolate resource/settings discovery, not session reconstruction.
	t.mock.method(SettingsManager, "create", () => f.settingsManager);
	f.control.createLoader = async () => f.loader;
	f.session.sessionManager.appendMessage({ role: "user", content: "persisted original context", timestamp: 1 });
	f.session.sessionManager.appendMessage({
		role: "assistant", content: [{ type: "text", text: "previous answer" }],
		api: "openai-completions", provider: "switch-test", model: "old", usage, stopReason: "stop", timestamp: 2,
	});
	const id = f.record.id;
	const file = f.record.sessionFile;
	f.control.unload(f.record);
	await f.control.switchModel(f.ctx, "worker", "switch-test/new", "low");
	assert.equal(f.record.loaded, false);
	const provider = f.runtime.getRegisteredProviderConfig("switch-test")!;
	f.runtime.registerProvider("switch-test", { ...provider, models: provider.models!.filter((model) => model.id !== "old") });
	assert.equal(f.runtime.getModel("switch-test", "old"), undefined);
	await f.control.ensureLoaded(f.record);
	assert.equal(f.record.session.model.id, "new");
	assert.equal(f.record.session.thinkingLevel, "low");
	assert.equal(f.record.id, id);
	assert.equal(f.record.sessionFile, file);
	assert.match(JSON.stringify(f.record.session.messages), /persisted original context/);
	assert.match(JSON.stringify(f.record.session.messages), /previous answer/);
	f.control.unload(f.record);
	f.record.modelId = "removed";
	await assert.rejects(f.control.ensureLoaded(f.record), /model switch-test\/removed is unavailable/);
	assert.equal(f.record.loaded, false);
});
