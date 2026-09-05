import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverRoles, selectRoleSkills } from "../roles.ts";

test("Role frontmatter discovers explicitly assigned skills", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-role-"));
	const rolesDirectory = path.join(directory, ".pi", "agents");
	fs.mkdirSync(rolesDirectory, { recursive: true });
	fs.writeFileSync(path.join(rolesDirectory, "researcher.md"), `---
name: researcher
description: Focused researcher
tools: [web_search, fetch]
skills: [agent-browser, document]
---

Research carefully.
`, "utf8");
	fs.writeFileSync(path.join(rolesDirectory, "inherited.md"), `---
name: inherited
description: Inherit all Skills
---
`, "utf8");
	fs.writeFileSync(path.join(rolesDirectory, "none.md"), `---
name: none
description: Disable all Skills
skills: []
---
`, "utf8");
	try {
		const roles = discoverRoles(directory, true);
		assert.deepEqual(roles.find((candidate) => candidate.name === "researcher")?.skills, ["agent-browser", "document"]);
		assert.equal(roles.find((candidate) => candidate.name === "inherited")?.skills, undefined);
		assert.deepEqual(roles.find((candidate) => candidate.name === "none")?.skills, []);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("explicit Role skills filter the progressively disclosed catalog", () => {
	const discovered = ["sample", "other"].map((name) => ({
		name,
		description: `${name} skill`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		disableModelInvocation: false,
		sourceInfo: {},
	})) as any;
	assert.deepEqual(selectRoleSkills(["sample"], discovered).map((skill) => skill.name), ["sample"]);
	assert.deepEqual(selectRoleSkills([], discovered), []);
	assert.throws(() => selectRoleSkills(["missing"], discovered), /unknown skill.*missing/i);
});
