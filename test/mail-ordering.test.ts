import assert from "node:assert/strict";
import test from "node:test";
import { AgentControl } from "../control.ts";
import { ROOT_PATH } from "../types.ts";

type SentMessage = {
	message: { content: string };
	options: { triggerTurn?: boolean; deliverAs?: string };
};

function createControl(sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => void) {
	const pi = {
		sendMessage,
	} as any;
	return new AgentControl(pi, "/tmp/codex-agents/index.ts");
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("mail arriving during a turn is not inserted immediately", async () => {
	const sent: SentMessage[] = [];
	const control = createControl((message, options) => sent.push({ message, options }));
	control.noteTurnStart(ROOT_PATH);

	await (control as any).deliver("/root/child", ROOT_PATH, "done", false, "AGENT_STATUS");
	assert.equal(sent.length, 0);

	control.noteTurnEnd(ROOT_PATH, "stop");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.content, "done");
	assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
});

test("aborted turns defer queued mail without waking the agent", async () => {
	const sent: SentMessage[] = [];
	const control = createControl((message, options) => sent.push({ message, options }));
	control.noteTurnStart(ROOT_PATH);

	await (control as any).deliver("/root/child", ROOT_PATH, "done", false, "AGENT_STATUS");
	control.noteTurnEnd(ROOT_PATH, "aborted");

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.options, { triggerTurn: false, deliverAs: "nextTurn" });
});

test("aborted child mail waits for and joins the next explicit task", async () => {
	const deliveries: Array<{ message: { content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }> = [];
	const control = createControl(() => {});
	const childPath = "/root/child";
	const record = {
		path: childPath,
		parentPath: ROOT_PATH,
		session: {
			isIdle: false,
			async sendCustomMessage(message: { content: string }, options: { triggerTurn?: boolean; deliverAs?: string }) {
				deliveries.push({ message, options });
			},
		},
		lastUsedAt: 0,
		holdsExecutionSlot: false,
		launchGeneration: 0,
		status: "interrupted",
	};
	(control as any).agentsByPath.set(childPath, record);
	control.noteTurnStart(childPath);
	(control as any).pendingMail.set(childPath, ["deferred"]);

	control.noteTurnEnd(childPath, "aborted");
	await settle();
	assert.equal(deliveries.length, 0);
	assert.deepEqual(control.drainPendingMail(childPath), ["deferred"]);

	(control as any).pendingMail.set(childPath, ["deferred"]);
	(control as any).launch(record, "follow-up");
	await settle();
	assert.equal(deliveries[0]!.message.content, "deferred\n\nfollow-up");
	assert.deepEqual(deliveries[0]!.options, { triggerTurn: true, deliverAs: "steer" });
});

test("failed flush returns mail to the pending queue", async () => {
	const control = createControl(() => {
		throw new Error("runtime is shutting down");
	});
	control.noteTurnStart(ROOT_PATH);

	await (control as any).deliver("/root/child", ROOT_PATH, "recoverable", false, "AGENT_STATUS");
	control.noteTurnEnd(ROOT_PATH, "stop");
	await settle();

	assert.deepEqual(control.drainPendingMail(ROOT_PATH), ["recoverable"]);
});
