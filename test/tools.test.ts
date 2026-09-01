import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { createCollaborationTools } from "../tools.ts";

test("one batch spawn action handles both single and multiple tasks", () => {
	const tools = createCollaborationTools({} as any);
	const names = tools.map((tool) => tool.name);
	assert.equal(names.includes("spawn_agent"), false);
	assert.equal(names.filter((name) => name === "spawn_agents").length, 1);
	const spawn = tools.find((tool) => tool.name === "spawn_agents");
	assert.ok(spawn);
	assert.equal(Value.Check(spawn.parameters, { agents: [{ task_name: "one", message: "First" }] }), true);
	assert.equal(Value.Check(spawn.parameters, {
		agents: [
			{ task_name: "one", message: "First" },
			{ task_name: "two", message: "Second", fork_turns: "none" },
		],
	}), true);
	assert.equal(Value.Check(spawn.parameters, { agents: [] }), false);
	assert.equal(Value.Check(spawn.parameters, { task_name: "legacy", message: "Old shape" }), false);
});

test("status view explicitly reports waiting agents and queue capacity", async () => {
	const waiting = {
		id: "queued-1",
		path: "/root/waiting",
		parentPath: "/root",
		model: "test/model",
		thinkingLevel: "high" as const,
		status: "queued" as const,
		statusMessage: "waiting for an execution slot",
		loaded: false,
		queuePosition: 1,
	};
	const control = {
		callerPath: () => "/root",
		list: () => [waiting],
		getCounts: () => ({ running: 3, queued: 1, loaded: 3, total: 4, slots: 3, residentSlots: 3 }),
	} as any;
	const listAgents = createCollaborationTools(control).find((tool) => tool.name === "list_agents");
	assert.ok(listAgents);
	const output = await listAgents.execute("call", { view: "status" }, new AbortController().signal, undefined, {} as any);
	const text = output.content.find((item) => item.type === "text")?.text ?? "";
	assert.match(text, /\"status\":\"queued\"/);
	assert.match(text, /\"queuePosition\":1/);
	assert.match(text, /\"thinkingLevel\":\"high\"/);
	assert.match(text, /\"queued\":1/);
	assert.equal((output.details as any)?.targets[0]?.statusMessage, "waiting for an execution slot");
});
