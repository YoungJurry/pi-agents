import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	archiveUnownedLegacyFiles,
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

test("legacy flat files are archived only when no main session references them", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-archive-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const storage = path.join(directory, "pi-agents");
		const sessions = path.join(storage, "sessions");
		const results = path.join(storage, "results");
		const mainSessions = path.join(directory, "sessions", "--project--");
		fs.mkdirSync(sessions, { recursive: true });
		fs.mkdirSync(results, { recursive: true });
		fs.mkdirSync(mainSessions, { recursive: true });
		const referencedId = "11111111-1111-7111-8111-111111111111";
		const unownedId = "22222222-2222-7222-8222-222222222222";
		for (const id of [referencedId, unownedId]) {
			fs.writeFileSync(
				path.join(sessions, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" })}\n`,
				"utf8",
			);
			fs.writeFileSync(path.join(results, `${id}.md`), "result", "utf8");
		}
		fs.writeFileSync(path.join(sessions, "unidentifiable.jsonl"), "not a session\n", "utf8");
		fs.writeFileSync(
			path.join(mainSessions, "main.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "root", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" })}\n${JSON.stringify({ type: "custom", customType: "codex-agents-state", data: { agents: [{ id: referencedId }] } })}\n`,
			"utf8",
		);

		const report = await archiveUnownedLegacyFiles();
		assert.equal(report.error, undefined);
		assert.equal(report.archivedFiles, 2);
		assert.equal(report.retainedFiles, 3);
		assert.equal(report.scannedMainSessions, 1);
		assert.ok(report.archiveDirectory);
		assert.equal(fs.existsSync(path.join(sessions, `2026-01-01T00-00-00-000Z_${referencedId}.jsonl`)), true);
		assert.equal(fs.existsSync(path.join(results, `${referencedId}.md`)), true);
		assert.equal(fs.existsSync(path.join(sessions, "unidentifiable.jsonl")), true);
		assert.equal(fs.existsSync(path.join(sessions, `2026-01-01T00-00-00-000Z_${unownedId}.jsonl`)), false);
		assert.equal(fs.existsSync(path.join(results, `${unownedId}.md`)), false);
		assert.equal(fs.readdirSync(path.join(report.archiveDirectory!, "sessions")).length, 1);
		assert.equal(fs.readdirSync(path.join(report.archiveDirectory!, "results")).length, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
