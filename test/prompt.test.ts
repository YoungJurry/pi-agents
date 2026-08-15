import assert from "node:assert/strict";
import test from "node:test";
import { rootAgentInstructions } from "../context.ts";

test("root guidance contains only capability and trigger criteria", () => {
	assert.equal(
		rootAgentInstructions(),
		'<multi_agent_role>You can use sub-agents when parallel work would materially improve speed or quality.</multi_agent_role>',
	);
	assert.doesNotMatch(rootAgentInstructions(), /bounded|independently|local work/i);
});
