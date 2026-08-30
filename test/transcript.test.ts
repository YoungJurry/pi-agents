import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentControl } from "../control.ts";
import { EXTENSION_ID, FORK_CONTEXT_ENTRY_TYPE, ROOT_PATH } from "../types.ts";

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-transcript-"));
	const rootSession = SessionManager.inMemory("/tmp/project");
	const childSession = SessionManager.create("/tmp/project", directory);
	const forkMessage = { role: "user" as const, content: "parent context", timestamp: 1 };
	childSession.appendCustomEntry(FORK_CONTEXT_ENTRY_TYPE, { messages: [forkMessage] });
	childSession.appendCustomMessageEntry(EXTENSION_ID, "delegated task", true);
	childSession.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "web_search", arguments: { queries: ["example"] } }],
		api: "test",
		provider: "test",
		model: "test",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	});
	childSession.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "web_search",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 3,
	});

	const control = new AgentControl({} as any, "/tmp/pi-agents/index.ts");
	const childPath = "/root/research";
	const record: any = {
		id: childSession.getSessionId(),
		path: childPath,
		parentPath: ROOT_PATH,
		parentId: rootSession.getSessionId(),
		taskName: "research",
		role: "default",
		modelProvider: "test",
		modelId: "test",
		status: "completed",
		sessionFile: childSession.getSessionFile(),
		createdAt: 1,
		updatedAt: 3,
		lastUsedAt: 3,
		loaded: false,
		holdsExecutionSlot: false,
		launchGeneration: 0,
	};
	const ctx = {
		sessionManager: rootSession,
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: undefined,
		getSystemPrompt: () => "",
	} as any;
	(control as any).root = {
		ctx,
		sessionId: rootSession.getSessionId(),
		cwd: ctx.cwd,
		systemPrompt: "",
	};
	(control as any).pathBySessionId.set(rootSession.getSessionId(), ROOT_PATH);
	(control as any).agentsByPath.set(childPath, record);
	return { directory, control, ctx, childPath, record, forkMessage };
}

test("transcript reads the child active branch without inherited fork context", () => {
	const fixture = createFixture();
	try {
		const transcript = fixture.control.transcript(fixture.ctx, fixture.childPath);
		assert.equal(transcript.agent.path, fixture.childPath);
		assert.equal(transcript.cwd, "/tmp/project");
		assert.equal(transcript.messages.length, 3);
		assert.equal(transcript.messages[0]!.role, "custom");
		assert.equal(transcript.messages[1]!.role, "assistant");
		assert.equal(transcript.messages[2]!.role, "toolResult");
		assert.equal(transcript.messages.some((message) => message.role === "user" && message.content === "parent context"), false);
	} finally {
		fs.rmSync(fixture.directory, { recursive: true, force: true });
	}
});

test("loaded transcript strips the in-memory fork prefix", () => {
	const fixture = createFixture();
	try {
		const persisted = fixture.control.transcript(fixture.ctx, fixture.childPath).messages;
		const webSearchDefinition = {
			name: "web_search",
			label: "Web Search",
			description: "Search",
			parameters: {},
			execute: async () => ({ content: [] }),
			renderResult: () => undefined,
		} as any;
		fixture.record.session = {
			messages: [fixture.forkMessage, ...persisted],
			getToolDefinition: (name: string) => name === "web_search" ? webSearchDefinition : undefined,
		};
		fixture.record.loaded = true;
		const transcript = fixture.control.transcript(fixture.ctx, fixture.childPath);
		assert.deepEqual(transcript.messages, persisted);
		assert.deepEqual(transcript.toolDefinitions, [webSearchDefinition]);

		fixture.record.session = undefined;
		fixture.record.loaded = false;
		const unloadedTranscript = fixture.control.transcript(fixture.ctx, fixture.childPath);
		assert.deepEqual(unloadedTranscript.toolDefinitions, [webSearchDefinition]);
	} finally {
		fs.rmSync(fixture.directory, { recursive: true, force: true });
	}
});
