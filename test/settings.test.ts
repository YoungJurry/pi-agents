import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	DEFAULT_CHILD_THINKING_LEVEL,
	loadAgentSettings,
	resolveAgentLimits,
	selectAgentModel,
	selectAgentThinkingLevel,
} from "../settings.ts";

function withTempFile(contents?: string): { directory: string; file: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agents-settings-"));
	const file = path.join(directory, "agents-setting.json");
	if (contents !== undefined) fs.writeFileSync(file, contents, "utf8");
	return { directory, file };
}

test("missing settings use internal defaults without inheriting a parent", () => {
	const { directory, file } = withTempFile();
	try {
		assert.deepEqual(loadAgentSettings(file), {});
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("defaultModel and defaultThinkingLevel are loaded", () => {
	const { directory, file } = withTempFile('{"defaultModel":"  provider/model  ","defaultThinkingLevel":"high"}');
	try {
		assert.deepEqual(loadAgentSettings(file), { defaultModel: "provider/model", defaultThinkingLevel: "high" });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("concurrency and residency limits are configurable", () => {
	const { directory, file } = withTempFile('{"maxConcurrentSubagents":10,"maxResidentSubagents":12}');
	try {
		const settings = loadAgentSettings(file);
		assert.deepEqual(settings, { maxConcurrentSubagents: 10, maxResidentSubagents: 12 });
		assert.deepEqual(resolveAgentLimits(settings, file), { maxConcurrentSubagents: 10, maxResidentSubagents: 12 });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("resident default expands to fit configured concurrency", () => {
	assert.deepEqual(
		resolveAgentLimits({ maxConcurrentSubagents: 8 }, "/tmp/settings.json"),
		{ maxConcurrentSubagents: 8, maxResidentSubagents: 8 },
	);
});

test("model precedence prefers task, then role, then global settings", () => {
	assert.equal(selectAgentModel("task/model", "role/model", "global/model"), "task/model");
	assert.equal(selectAgentModel(undefined, "role/model", "global/model"), "role/model");
	assert.equal(selectAgentModel(undefined, undefined, "global/model"), "global/model");
	assert.equal(selectAgentModel(undefined, "  ", undefined), undefined);
});

test("thinking precedence and model-only maximum follow selection rules", () => {
	const standardModel = { reasoning: true } as any;
	const extendedModel = {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	} as any;
	assert.equal(selectAgentThinkingLevel(extendedModel, "task/model", undefined, "low", "medium"), "max");
	assert.equal(selectAgentThinkingLevel(extendedModel, "task/model", "high", "low", "medium"), "high");
	assert.equal(selectAgentThinkingLevel(standardModel, undefined, undefined, "low", "medium"), "low");
	assert.equal(selectAgentThinkingLevel(standardModel, undefined, undefined, undefined, "high"), "high");
	assert.equal(selectAgentThinkingLevel(standardModel, undefined, "minimal", "high", "medium"), "minimal");
	assert.equal(selectAgentThinkingLevel(standardModel, undefined, undefined, undefined, undefined), DEFAULT_CHILD_THINKING_LEVEL);
	assert.equal(selectAgentThinkingLevel({ reasoning: false } as any, "task/model", undefined, "high", "high"), "off");
});

test("malformed and invalid settings fail with their path", () => {
	for (const contents of [
		"{",
		'{"defaultModel":"  "}',
		"[]",
		'{"defaultThinkingLevel":"ultra"}',
		'{"maxConcurrentSubagents":0}',
		'{"maxResidentSubagents":1.5}',
	]) {
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

test("resident limit cannot be smaller than concurrency", () => {
	assert.throws(
		() => resolveAgentLimits({ maxConcurrentSubagents: 4, maxResidentSubagents: 3 }, "/tmp/settings.json"),
		/maxResidentSubagents.*greater than or equal/,
	);
});
