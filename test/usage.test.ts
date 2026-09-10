import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentControl } from "../control.ts";
import { ROOT_PATH } from "../types.ts";
import { formatAgentUsage } from "../viewer.ts";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(messageUsage: ReturnType<typeof usage>, timestamp: number, responseModel?: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "done" }],
		api: "test",
		provider: "test",
		model: "model",
		responseModel,
		usage: messageUsage,
		stopReason: "stop" as const,
		timestamp,
	};
}

test("agent usage keeps main and sub-agent cache statistics separate", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-usage-"));
	try {
		const rootSession = SessionManager.inMemory("/tmp/project");
		rootSession.appendMessage(assistant(usage(10, 2, 5, 1, 0.1), 1));
		const childSession = SessionManager.create("/tmp/project", directory);
		childSession.appendMessage(assistant(usage(20, 3, 10, 0, 0.2), 2, "resolved-model"));
		childSession.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "nested_llm",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			usage: usage(4, 1, 0, 0, 0.05),
			timestamp: 3,
		});
		const childSession2 = SessionManager.create("/tmp/project", directory);
		childSession2.appendMessage(assistant(usage(1, 1, 0, 0, 0.01), 4, "resolved-model"));

		const control = new AgentControl({} as any, "/tmp/pi-agents/index.ts");
		const ctx = {
			sessionManager: rootSession,
			cwd: "/tmp/project",
			model: undefined,
			thinkingLevel: undefined,
			getSystemPrompt: () => "",
		} as any;
		(control as any).root = { ctx, sessionId: rootSession.getSessionId(), cwd: ctx.cwd, systemPrompt: "" };
		(control as any).pathBySessionId.set(rootSession.getSessionId(), ROOT_PATH);
		(control as any).agentsByPath.set("/root/worker", {
			id: childSession.getSessionId(),
			path: "/root/worker",
			parentPath: ROOT_PATH,
			parentId: rootSession.getSessionId(),
			taskName: "worker",
			modelProvider: "test",
			modelId: "model",
			status: "completed",
			sessionFile: childSession.getSessionFile(),
			createdAt: 1,
			updatedAt: 3,
			lastUsedAt: 3,
			loaded: false,
			holdsExecutionSlot: false,
			launchGeneration: 0,
		});
		(control as any).agentsByPath.set("/root/worker_2", {
			id: childSession2.getSessionId(),
			path: "/root/worker_2",
			parentPath: ROOT_PATH,
			parentId: rootSession.getSessionId(),
			taskName: "worker_2",
			modelProvider: "test",
			modelId: "model",
			status: "completed",
			sessionFile: childSession2.getSessionFile(),
			createdAt: 2,
			updatedAt: 4,
			lastUsedAt: 4,
			loaded: false,
			holdsExecutionSlot: false,
			launchGeneration: 0,
		});

		const report = control.getUsage(ctx);
		assert.deepEqual(report.main, { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, total: 18, cost: 0.1 });
		assert.deepEqual(report.subagents, { input: 25, output: 5, cacheRead: 10, cacheWrite: 0, total: 40, cost: 0.26 });
		assert.deepEqual(report.combined, { input: 35, output: 7, cacheRead: 15, cacheWrite: 1, total: 58, cost: 0.36 });
		assert.deepEqual(report.mainBreakdown, [{
			key: "test/model",
			usage: report.main,
			sessionCount: 1,
			operations: 1,
		}]);
		assert.deepEqual(report.subagentBreakdown, [
			{
				key: "test/resolved-model",
				usage: { input: 21, output: 4, cacheRead: 10, cacheWrite: 0, total: 35, cost: 0.21 },
				sessionCount: 2,
				operations: 2,
			},
			{
				key: "Tools/summaries",
				usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0.05 },
				sessionCount: 1,
				operations: 1,
			},
		]);
		assert.equal(report.unreadableSubagents, 0);
		const formatted = formatAgentUsage(report);
		assert.match(formatted, /Combined: 58 tokens/);
		assert.match(formatted, /Main agent: 18 tokens.*31\.3%/);
		assert.match(formatted, /Sub-agent models[\s\S]*test\/resolved-model[\s\S]*Usage: 35 tokens[\s\S]*2 agents[\s\S]*2 usage records/);
		assert.match(formatted, /Tools\/summaries/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
