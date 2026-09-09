import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentControl } from "../control.ts";
import {
	CHILD_META_ENTRY_TYPE,
	FORK_CONTEXT_ENTRY_TYPE,
	ROOT_PATH,
	STATE_ENTRY_TYPE,
	type PersistedAgent,
	type PersistedTreeState,
} from "../types.ts";

function queuedRecord(index: number): any {
	return {
		id: `agent-${index}`,
		path: `${ROOT_PATH}/task_${index}`,
		parentPath: ROOT_PATH,
		parentId: "root-session",
		taskName: `task_${index}`,
		modelProvider: "test",
		modelId: "model",
		status: "queued",
		statusMessage: "waiting for an execution slot",
		createdAt: index,
		updatedAt: index,
		lastUsedAt: index,
		loaded: false,
		holdsExecutionSlot: false,
		launchGeneration: 0,
		queuedMessage: `task ${index}`,
	};
}

function createControl(limit = 2): { control: AgentControl; ctx: any } {
	const control = new AgentControl({ appendEntry: () => undefined } as any, "/tmp/pi-agents/index.ts", limit, limit);
	const ctx = {
		sessionManager: { getSessionId: () => "root-session" },
		cwd: "/tmp",
		model: undefined,
		thinkingLevel: undefined,
		getSystemPrompt: () => "",
	};
	(control as any).root = { ctx, sessionId: "root-session", cwd: "/tmp", systemPrompt: "" };
	(control as any).pathBySessionId.set("root-session", ROOT_PATH);
	return { control, ctx };
}

test("queued batch sessions durably preserve identity, metadata, and fork context", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-queue-session-"));
	try {
		const { control, ctx } = createControl(1);
		(control as any).childSessionDirectory = path.join(directory, "sessions");
		const forkMessage = { role: "user", content: "parent context", timestamp: 1 };
		const records = (control as any).materializeQueuedBatch(ctx, [{
			request: { taskName: "research", message: "Investigate" },
			childPath: "/root/research",
			callerPath: ROOT_PATH,
			role: { name: "default", nicknameCandidates: ["Ada"] },
			selectedModel: { provider: "test", id: "model" },
			thinkingLevel: "high",
			forkMessages: [forkMessage],
		}]);
		const record = records[0];
		assert.ok(record?.sessionFile);
		assert.equal(fs.existsSync(record.sessionFile), true);
		const reopened = SessionManager.open(record.sessionFile);
		assert.equal(reopened.getSessionId(), record.id);
		const childMeta = reopened.getEntries().find((entry) => entry.type === "custom" && entry.customType === CHILD_META_ENTRY_TYPE);
		assert.deepEqual((childMeta as any)?.data, {
			path: "/root/research",
			parentPath: ROOT_PATH,
			rootSessionId: "root-session",
			role: "default",
		});
		const forkContext = reopened.getEntries().find((entry) => entry.type === "custom" && entry.customType === FORK_CONTEXT_ENTRY_TYPE);
		assert.deepEqual((forkContext as any)?.data?.messages, [forkMessage]);
		reopened.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ready" }],
			api: "test",
			provider: "test",
			model: "model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		});
		const persistedLines = fs.readFileSync(record.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(persistedLines.filter((entry) => entry.type === "session").length, 1);
		assert.equal(persistedLines.some((entry) => entry.type === "custom" && entry.customType === FORK_CONTEXT_ENTRY_TYPE), true);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("queued agents start only when execution slots are available", async () => {
	const { control } = createControl(2);
	const records = [1, 2, 3, 4].map(queuedRecord);
	for (const record of records) (control as any).agentsByPath.set(record.path, record);
	const launched: string[] = [];
	(control as any).ensureLoaded = async (record: any) => {
		record.session = { isIdle: true, dispose: () => undefined };
		record.loaded = true;
	};
	(control as any).launch = (record: any, content: string) => {
		record.status = "running";
		record.statusMessage = undefined;
		launched.push(`${record.path}:${content}`);
	};

	await (control as any).scheduleQueued();
	assert.deepEqual(records.map((record) => record.status), ["running", "running", "queued", "queued"]);
	assert.equal(control.getCounts().running, 2);
	assert.equal(control.getCounts().queued, 2);
	assert.equal(control.view(records[2]).queuePosition, 1);
	assert.equal(control.view(records[3]).queuePosition, 2);

	records[0].status = "completed";
	records[0].holdsExecutionSlot = false;
	(control as any).activeExecutionSlots--;
	await (control as any).scheduleQueued();
	assert.deepEqual(records.map((record) => record.status), ["completed", "running", "running", "queued"]);
	assert.equal(control.view(records[3]).queuePosition, 1);
	assert.deepEqual(launched.map((item) => item.split(":")[0]), ["/root/task_1", "/root/task_2", "/root/task_3"]);
});

test("temporary resident saturation keeps work queued instead of failing it", async () => {
	const { control } = createControl(2);
	const running = {
		...queuedRecord(1),
		status: "running",
		loaded: true,
		holdsExecutionSlot: true,
		session: { isIdle: false, dispose: () => undefined },
	};
	const settling = {
		...queuedRecord(2),
		status: "completed",
		loaded: true,
		holdsExecutionSlot: false,
		session: { isIdle: false, dispose: () => undefined },
	};
	const waiting = queuedRecord(3);
	for (const record of [running, settling, waiting]) (control as any).agentsByPath.set(record.path, record);
	(control as any).activeExecutionSlots = 1;
	(control as any).ensureLoaded = async (record: any) => {
		record.session = {};
		record.loaded = true;
	};
	(control as any).launch = (record: any) => {
		record.status = "running";
		record.statusMessage = undefined;
	};

	await (control as any).scheduleQueued();
	assert.equal(waiting.status, "queued");
	assert.equal(waiting.statusMessage, "waiting for an execution slot");
	assert.equal(waiting.finalAnswer, undefined);
	assert.equal((control as any).activeExecutionSlots, 1);

	settling.session.isIdle = true;
	await (control as any).scheduleQueued();
	assert.equal(settling.loaded, false);
	assert.equal(waiting.status, "running");
	assert.equal((control as any).activeExecutionSlots, 2);
});

test("settled sessions release slots before queued work starts", async () => {
	const { control } = createControl(1);
	let emit: ((event: any) => void) | undefined;
	const settling = {
		...queuedRecord(1),
		status: "completed",
		loaded: true,
		holdsExecutionSlot: true,
		session: {
			isIdle: false,
			dispose: () => undefined,
			subscribe: (listener: (event: any) => void) => {
				emit = listener;
				return () => undefined;
			},
		},
	};
	const waiting = queuedRecord(2);
	for (const record of [settling, waiting]) (control as any).agentsByPath.set(record.path, record);
	(control as any).activeExecutionSlots = 1;
	(control as any).ensureLoaded = async (record: any) => {
		record.session = {};
		record.loaded = true;
	};
	(control as any).launch = (record: any) => {
		record.status = "running";
		record.statusMessage = undefined;
	};
	(control as any).subscribe(settling);

	await (control as any).scheduleQueued();
	assert.equal(waiting.status, "queued");
	settling.session.isIdle = true;
	emit?.({ type: "agent_settled" });
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(settling.loaded, false);
	assert.equal(waiting.status, "running");
	assert.equal((control as any).activeExecutionSlots, 1);
});

test("scheduler reruns when a wake-up arrives during a blocked pass", async () => {
	const { control } = createControl(1);
	const waiting = queuedRecord(1);
	(control as any).agentsByPath.set(waiting.path, waiting);
	let attempts = 0;
	(control as any).startQueued = async (record: any) => {
		attempts++;
		if (attempts === 1) {
			queueMicrotask(() => void (control as any).scheduleQueued());
			return false;
		}
		record.status = "running";
		(control as any).activeExecutionSlots = 1;
		return true;
	};

	await (control as any).scheduleQueued();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(attempts, 2);
	assert.equal(waiting.status, "running");
});

test("follow-up task refreshes assignment recency for reused agents", async () => {
	const { control, ctx } = createControl(1);
	const record = { ...queuedRecord(1), status: "completed", queuedMessage: undefined, lastAssignedAt: 1 };
	(control as any).agentsByPath.set(record.path, record);
	(control as any).pathBySessionId.set(record.id, record.path);
	(control as any).deliver = async () => undefined;
	const view = await control.message(ctx, { target: record.path, message: "Reuse this agent", triggerTurn: true });
	assert.ok((view.lastAssignedAt ?? 0) > 1);
	assert.equal(record.lastAssignedAt, view.lastAssignedAt);
});

test("interrupting a queued agent cancels it without loading a session", async () => {
	const { control, ctx } = createControl(1);
	const record = queuedRecord(1);
	(control as any).agentsByPath.set(record.path, record);
	(control as any).pathBySessionId.set(record.id, record.path);
	const view = await control.interrupt(ctx, record.path);
	assert.equal(view.status, "interrupted");
	assert.match(view.statusMessage ?? "", /cancelled while waiting/);
	assert.equal(record.loaded, false);
	assert.equal(record.queuedMessage, undefined);
});

test("queued work remains queued when persisted state is restored", () => {
	const { control } = createControl(1);
	const persisted: PersistedAgent = queuedRecord(1);
	const state: PersistedTreeState = {
		version: 1,
		rootSessionId: "root-session",
		agents: [persisted],
	};
	const ctx = {
		sessionManager: {
			getSessionId: () => "root-session",
			getBranch: () => [{ type: "custom", customType: STATE_ENTRY_TYPE, data: state }],
		},
	};
	(control as any).restoreState(ctx);
	const restored = (control as any).agentsByPath.get(persisted.path);
	assert.equal(restored.status, "queued");
	assert.equal(restored.statusMessage, "waiting for an execution slot");
	assert.equal(restored.queuedMessage, persisted.queuedMessage);
	assert.equal(restored.holdsExecutionSlot, false);
});
