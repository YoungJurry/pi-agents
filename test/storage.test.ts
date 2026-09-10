import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { getAgentSettingsPath, getAgentStorageDirectory } from "../storage.ts";

test("storage helpers use only the current pi-agents paths", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-storage-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		assert.equal(getAgentStorageDirectory(), path.join(directory, "pi-agents"));
		assert.equal(getAgentSettingsPath(), path.join(directory, "pi-agents", "settings.json"));
		assert.deepEqual(fs.readdirSync(directory), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
