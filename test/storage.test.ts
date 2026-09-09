import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	getAgentSettingsPath,
	getAgentStorageDirectory,
	migrateLegacyAgentStorage,
	resolveMigratedStoragePath,
} from "../storage.ts";

test("legacy codex-agents storage migrates without changing persisted references", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-storage-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const oldRoot = path.join(directory, "codex-agents");
		const oldSession = path.join(oldRoot, "roots", "root-id", "sessions", "child.jsonl");
		fs.mkdirSync(path.dirname(oldSession), { recursive: true });
		fs.writeFileSync(oldSession, "session", "utf8");
		fs.writeFileSync(path.join(oldRoot, "agents-setting.json"), "{}\n", "utf8");

		const report = migrateLegacyAgentStorage();
		const newSession = path.join(getAgentStorageDirectory(), "roots", "root-id", "sessions", "child.jsonl");
		assert.ok(report.movedEntries > 0);
		assert.equal(fs.existsSync(oldRoot), false);
		assert.equal(fs.readFileSync(newSession, "utf8"), "session");
		assert.equal(fs.existsSync(getAgentSettingsPath()), true);
		assert.equal(resolveMigratedStoragePath(oldSession), newSession);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("persisted legacy paths win when a migration conflict leaves both files", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-conflict-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const legacy = path.join(directory, "codex-agents", "roots", "root", "sessions", "child.jsonl");
		const current = path.join(directory, "pi-agents", "roots", "root", "sessions", "child.jsonl");
		fs.mkdirSync(path.dirname(legacy), { recursive: true });
		fs.mkdirSync(path.dirname(current), { recursive: true });
		fs.writeFileSync(legacy, "legacy", "utf8");
		fs.writeFileSync(current, "current", "utf8");
		assert.equal(resolveMigratedStoragePath(legacy), legacy);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
