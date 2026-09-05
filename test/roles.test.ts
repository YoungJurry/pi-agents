import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverRoles, formatAssignedSkills } from "../roles.ts";

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
	try {
		const role = discoverRoles(directory, true).find((candidate) => candidate.name === "researcher");
		assert.deepEqual(role?.skills, ["agent-browser", "document"]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("assigned skills inject complete SKILL.md instructions", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-skill-"));
	const filePath = path.join(directory, "SKILL.md");
	fs.writeFileSync(filePath, "---\nname: sample\ndescription: Sample skill\n---\n\nFollow the complete procedure.", "utf8");
	const discovered = [{
		name: "sample",
		description: "Sample skill",
		filePath,
		baseDir: directory,
		disableModelInvocation: false,
		sourceInfo: {},
	}] as any;
	try {
		const prompt = formatAssignedSkills(["sample"], discovered);
		assert.match(prompt, /<agent_skills>/);
		assert.match(prompt, /Follow the complete procedure\./);
		assert.match(prompt, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.throws(() => formatAssignedSkills(["missing"], discovered), /unknown skill.*missing/i);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
