import assert from "node:assert/strict";
import test from "node:test";
import { childAgentInstructions } from "../context.ts";

test("child guidance trims an optional role and omits blank roles", () => {
	const base = childAgentInstructions("/root/worker", "/root");
	assert.equal(childAgentInstructions("/root/worker", "/root", "  \n  "), base);
	assert.equal(
		childAgentInstructions("/root/worker", "/root", "  Review only the assigned files.\n  "),
		`${base}\n\n<agent_role>\nReview only the assigned files.\n</agent_role>`,
	);
});
