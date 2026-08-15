import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadAgentSettings, selectAgentModel } from "../settings.ts";

function withTempFile(contents?: string): { directory: string; file: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agents-settings-"));
	const file = path.join(directory, "agents-setting.json");
	if (contents !== undefined) fs.writeFileSync(file, contents, "utf8");
	return { directory, file };
}

test("missing settings inherit the parent model", () => {
	const { directory, file } = withTempFile();
	try {
		assert.deepEqual(loadAgentSettings(file), {});
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("defaultModel is loaded and trimmed", () => {
	const { directory, file } = withTempFile('{"defaultModel":"  provider/model  "}');
	try {
		assert.deepEqual(loadAgentSettings(file), { defaultModel: "provider/model" });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("model precedence prefers spawn, then role, then global settings", () => {
	assert.equal(selectAgentModel("spawn/model", "role/model", "global/model"), "spawn/model");
	assert.equal(selectAgentModel(undefined, "role/model", "global/model"), "role/model");
	assert.equal(selectAgentModel(undefined, undefined, "global/model"), "global/model");
	assert.equal(selectAgentModel(undefined, "  ", undefined), undefined);
});

test("malformed and empty settings fail with their path", () => {
	for (const contents of ["{", '{"defaultModel":"  "}', "[]"]) {
		const { directory, file } = withTempFile(contents);
		try {
			assert.throws(() => loadAgentSettings(file), (error: unknown) => {
				assert.match(String(error), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
				return true;
			});
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}
});
