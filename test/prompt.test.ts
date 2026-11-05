import assert from "node:assert/strict";
import test from "node:test";
import { childAgentInstructions, rootAgentInstructions } from "../context.ts";

test("root guidance contains only capability and trigger criteria", () => {
	assert.equal(
		rootAgentInstructions(),
		'<multi_agent_role>You can use sub-agents when parallel work would materially improve speed or quality.</multi_agent_role>',
	);
	assert.doesNotMatch(rootAgentInstructions(), /bounded|independently|local work/i);
});

test("child guidance explains teammate discovery and the action dispatcher", () => {
	const prompt = childAgentInstructions("/root/worker", "/root");
	assert.ok(prompt.includes('list_agents(view="status")'));
	assert.ok(prompt.includes('list_agents(view="tools")'));
	assert.match(prompt, /agent_action/);
	assert.match(prompt, /absolute agent paths/);
});

test("child guidance retains independent work, parent identity, and result semantics", () => {
	const prompt = childAgentInstructions("/root/worker", "/root", "Review only the assigned files.");
	assert.match(prompt, /You are \/root\/worker/);
	assert.match(prompt, /Your direct parent is \/root\./);
	assert.match(prompt, /Complete the assigned task independently/);
	assert.match(prompt, /parent receives only a brief completion notification/);
	assert.match(prompt, /Coordinate ownership of files/);
	assert.ok(prompt.endsWith("<agent_role>\nReview only the assigned files.\n</agent_role>"));
	assert.ok(!childAgentInstructions("/root/worker", "/root", "  ").includes("<agent_role>"));
});
