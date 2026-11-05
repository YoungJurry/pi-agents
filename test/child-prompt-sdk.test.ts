// Exercise the real plugin loader and SDK prompt builder without starting a model turn.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentControl } from "../control.ts";
import { childAgentInstructions, rootAgentInstructions } from "../context.ts";

const APPEND = "PROJECT_APPEND_INSTRUCTION";
const PROJECT = "PROJECT_SCOPE_RESTRICTION";
const ROLE = "CHILD_ROLE_ONLY";
const CUSTOM = "USER_CONFIGURED_BASE_PROMPT";
const instructions = childAgentInstructions("/root/worker", "/root", ROLE);

async function fixture(t: TestContext, options: { customBase?: string; instructions?: string } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-child-prompt-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const cwd = path.join(directory, "workspace");
	const agentDir = path.join(directory, "agent");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), APPEND);
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), PROJECT);
	if (options.customBase !== undefined) {
		fs.writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), options.customBase);
	}
	const settingsManager = SettingsManager.inMemory({});
	const control: any = new AgentControl({} as any, path.join(directory, "extension.ts"));
	// Parent-only identity must not be copied wholesale into the child prompt.
	control.root = { systemPrompt: "PARENT_PRIVATE_PROMPT\n" + rootAgentInstructions() };
	let loader: DefaultResourceLoader;
	// createLoader uses getAgentDir(). Point discovery at an empty, isolated directory
	// so this test never loads installed user extensions, settings, or credentials.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		loader = await control.createLoader(cwd, settingsManager, options.instructions ?? instructions);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	const runtime = await ModelRuntime.create({
		authPath: path.join(directory, "auth.json"), modelsPath: null,
		modelsStorePath: path.join(directory, "models.json"), refreshOnCreate: false,
	});
	runtime.registerProvider("prompt-test", {
		baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only",
		models: [{
			id: "dummy", name: "dummy", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000, maxTokens: 100,
		}],
	});
	const { session } = await createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader: loader,
		modelRuntime: runtime, model: runtime.getModel("prompt-test", "dummy")!,
		sessionManager: SessionManager.inMemory(cwd),
	});
	// This fixture reads systemPrompt only. Any accidental model request must fail locally.
	session.agent.streamFunction = () => { throw new Error("Prompt tests must not call a model"); };
	t.after(() => session.dispose());
	return { loader, session };
}

function assertChildInstructions(prompt: string) {
	for (const text of [APPEND, PROJECT, ROLE, "You are /root/worker", "Your direct parent is /root."]) {
		assert.equal(prompt.split(text).length - 1, 1, `${text} must appear exactly once`);
	}
	assert.doesNotMatch(prompt, /PARENT_PRIVATE_PROMPT/);
	assert.ok(!prompt.includes(rootAgentInstructions()));
}

test("child prompt retains Pi defaults and appends identity, role, and project instructions", async t => {
	const { loader, session } = await fixture(t);
	assert.equal(loader.getSystemPrompt(), undefined, "child guidance must not replace the default base");
	assert.deepEqual(loader.getAppendSystemPrompt(), [APPEND, instructions]);
	const prompt = session.systemPrompt;
	assert.match(prompt, /You are a coding assistant running inside pi/);
	assert.match(prompt, /<rules>/);
	assert.match(prompt, /Be concise in your responses/);
	assert.match(prompt, /<docs>/);
	assertChildInstructions(prompt);
});

test("child prompt respects a configured SYSTEM.md instead of replacing or expanding its base", async t => {
	const { loader, session } = await fixture(t, { customBase: CUSTOM });
	assert.equal(loader.getSystemPrompt(), CUSTOM);
	assert.deepEqual(loader.getAppendSystemPrompt(), [APPEND, instructions]);
	assert.ok(session.systemPrompt.startsWith(CUSTOM));
	assert.doesNotMatch(session.systemPrompt, /You are a coding assistant running inside pi/);
	assertChildInstructions(session.systemPrompt);
});

test("resource reload does not duplicate child guidance or existing append instructions", async t => {
	const { loader } = await fixture(t);
	await loader.reload();
	await loader.reload();
	assert.equal(loader.getSystemPrompt(), undefined);
	assert.deepEqual(loader.getAppendSystemPrompt(), [APPEND, instructions]);
});

for (const empty of ["", " \n\t"]) {
	test(`empty child instructions leave normal prompt discovery unchanged (${JSON.stringify(empty)})`, async t => {
		const { loader, session } = await fixture(t, { instructions: empty });
		assert.equal(loader.getSystemPrompt(), undefined);
		assert.deepEqual(loader.getAppendSystemPrompt(), [APPEND]);
		assert.match(session.systemPrompt, /<rules>/);
		assert.ok(session.systemPrompt.includes(PROJECT));
		assert.doesNotMatch(session.systemPrompt, /<multi_agent_role>|CHILD_ROLE_ONLY/);
	});
}
