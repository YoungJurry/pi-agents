import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import piAgentsExtension from "../index.ts";
import { USAGE_ENTRY_TYPE } from "../types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

test("agent-usage appends an inline TUI-only entry instead of opening an overlay", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-usage-command-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const commands = new Map<string, any>();
		const entryRenderers = new Map<string, any>();
		const appended: Array<{ customType: string; data: unknown }> = [];
		let customUiCalls = 0;
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => any) => {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			registerTool: () => undefined,
			registerMessageRenderer: () => undefined,
			registerEntryRenderer: (name: string, renderer: unknown) => entryRenderers.set(name, renderer),
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		} as any;
		piAgentsExtension(pi);

		const sessionManager = SessionManager.inMemory("/tmp/project");
		const ctx = {
			sessionManager,
			cwd: "/tmp/project",
			model: undefined,
			thinkingLevel: undefined,
			getSystemPrompt: () => "",
			isProjectTrusted: () => true,
			hasUI: true,
			mode: "tui",
			ui: {
				theme,
				setStatus: () => undefined,
				setWidget: () => undefined,
				notify: () => undefined,
				custom: async () => { customUiCalls++; },
			},
		};
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		await commands.get("agent-usage").handler("", ctx);

		assert.equal(customUiCalls, 0);
		const usageEntry = appended.find((entry) => entry.customType === USAGE_ENTRY_TYPE);
		assert.ok(usageEntry);
		const renderer = entryRenderers.get(USAGE_ENTRY_TYPE);
		assert.ok(renderer);
		const component = renderer({ data: usageEntry.data }, { expanded: false }, theme);
		assert.match(component.render(120).join("\n"), /Agent Usage/);
		assert.match(component.render(120).join("\n"), /Sub-agent models/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
