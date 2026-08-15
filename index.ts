import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { AgentControl } from "./control.ts";
import { createCollaborationTools } from "./tools.ts";
import { EXTENSION_ID, ROOT_PATH, type AgentLifecycleStatus, type AgentView } from "./types.ts";

const SELF_PATH = fileURLToPath(import.meta.url);
const WIDGET_KEY = "codex-agents-tree";
const STATUS_KEY = "codex-agents";
const PROMPT_MARKER = "<multi_agent_role>";

function statusIcon(status: AgentLifecycleStatus): string {
	switch (status) {
		case "running": return "●";
		case "completed": return "✓";
		case "errored": return "✗";
		case "interrupted": return "■";
		case "pending_init": return "○";
		case "shutdown": return "×";
	}
}

function statusColor(status: AgentLifecycleStatus): "success" | "error" | "warning" | "muted" | "dim" {
	switch (status) {
		case "running": return "warning";
		case "completed": return "success";
		case "errored": return "error";
		case "interrupted": return "muted";
		case "pending_init": return "dim";
		case "shutdown": return "muted";
	}
}

function treeLine(agent: AgentView, theme: Theme): string {
	const depth = Math.max(0, agent.path.split("/").filter(Boolean).length - 1);
	const indent = "  ".repeat(depth);
	const branch = depth > 0 ? "└─ " : "";
	const name = agent.path === ROOT_PATH ? ROOT_PATH : agent.path.split("/").at(-1) || agent.path;
	const icon = theme.fg(statusColor(agent.status), statusIcon(agent.status));
	const residency = agent.path === ROOT_PATH || agent.loaded ? "" : theme.fg("dim", " [unloaded]");
	const nickname = agent.nickname ? theme.fg("muted", ` (${agent.nickname})`) : "";
	return `${indent}${branch}${icon} ${theme.fg("accent", name)}${nickname}${residency}`;
}

class AgentTreeWidget {
	constructor(
		private readonly control: AgentControl,
		private readonly getContext: () => ExtensionContext | undefined,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const ctx = this.getContext();
		if (!ctx) return [];
		let agents: AgentView[];
		try {
			agents = this.control.list(ctx);
		} catch {
			return [];
		}
		const activeAgents = agents.filter((agent) => agent.path !== ROOT_PATH && (agent.status === "running" || agent.status === "pending_init"));
		if (activeAgents.length === 0) return [];
		const counts = this.control.getCounts();
		const lines = [
			this.theme.fg("muted", `Agents active: ${activeAgents.length} · limit: ${counts.slots}`),
			...activeAgents.slice(0, 8).map((agent) => treeLine(agent, this.theme)),
		];
		if (activeAgents.length > 8) lines.push(this.theme.fg("dim", `  … ${activeAgents.length - 8} more; use /agents`));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
}

function renderAgentList(agents: AgentView[], theme: Theme, width: number): string[] {
	const lines = [theme.fg("accent", theme.bold("Codex-style agent tree")), ""];
	for (const agent of agents) {
		lines.push(treeLine(agent, theme));
		lines.push(truncateToWidth(`   ${theme.fg("dim", `${agent.status} · ${agent.model}${agent.role ? ` · ${agent.role}` : ""}`)}`, width));
		if (agent.statusMessage) lines.push(truncateToWidth(`   ${theme.fg("error", agent.statusMessage)}`, width));
	}
	lines.push("", theme.fg("dim", "Escape or Enter to close"));
	return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export default function codexAgentsExtension(pi: ExtensionAPI): void {
	const control = new AgentControl(pi, path.resolve(SELF_PATH));
	const tools = createCollaborationTools(control);
	control.setTools(tools);
	for (const tool of tools) pi.registerTool(tool);

	let activeContext: ExtensionContext | undefined;
	let widgetTui: { requestRender(): void } | undefined;

	const updateUi = () => {
		const ctx = activeContext;
		if (!ctx) return;
		let activeAgentCount = 0;
		try {
			activeAgentCount = control.list(ctx).filter((agent) => agent.path !== ROOT_PATH && (agent.status === "running" || agent.status === "pending_init")).length;
		} catch {
			// Root context can be transiently unavailable during reload/shutdown.
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			activeAgentCount > 0 ? ctx.ui.theme.fg("warning", `agents ${activeAgentCount} active`) : undefined,
		);
		widgetTui?.requestRender();
	};
	control.onChange(updateUi);

	pi.on("session_start", (event, ctx) => {
		activeContext = ctx;
		control.bindRoot(ctx);
		const resumedExistingSession = event.reason === "resume"
			|| (event.reason === "startup" && ctx.sessionManager.getEntries().some((entry) => entry.type === "message"));
		if (resumedExistingSession) {
			const removed = control.cleanupOrphanStorage(ctx.sessionManager.getSessionId());
			if (removed > 0) ctx.ui.notify(`Cleaned ${removed} orphaned agent storage ${removed === 1 ? "group" : "groups"}.`, "info");
		}
		control.configureInitialRootTools();
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				widgetTui = tui;
				return new AgentTreeWidget(control, () => activeContext, theme);
			}, { placement: "belowEditor" });
		}
		updateUi();
	});

	pi.on("before_agent_start", (event, ctx) => {
		activeContext = ctx;
		control.refreshRootContext(ctx);
		if (event.systemPrompt.includes(PROMPT_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${control.getRootInstructions()}` };
	});

	pi.on("agent_start", (_event, ctx) => {
		activeContext = ctx;
		control.setRootStatus("running");
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		control.setRootStatus("completed");
	});

	pi.on("turn_start", (_event, ctx) => {
		activeContext = ctx;
		control.markMailboxConsumed(ROOT_PATH);
	});

	pi.on("model_select", (_event, ctx) => {
		activeContext = ctx;
		control.refreshRootContext(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeContext = ctx;
		await control.shutdown();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		activeContext = undefined;
		widgetTui = undefined;
	});

	pi.registerMessageRenderer(EXTENSION_ID, (message, _options, theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const messageDetails = message.details as { type?: string } | undefined;
		if (messageDetails?.type === "AGENT_STATUS") {
			return new Text(theme.fg("customMessageText", content), 1, 0);
		}
		const [typeLine = "Agent message", taskLine = "", senderLine = "", ...payload] = content.split("\n");
		const title = typeLine.replace("Message Type: ", "");
		const task = taskLine.replace("Task name: ", "");
		const sender = senderLine.replace("Sender: ", "");
		const body = payload[0] === "Payload:" ? payload.slice(1).join("\n") : payload.join("\n");
		const header = `${theme.fg("customMessageLabel", theme.bold(title))} ${theme.fg("accent", task)} ${theme.fg("muted", `from ${sender}`)}`;
		return new Text(`${header}\n${theme.fg("customMessageText", body)}`, 1, 0);
	});

	pi.registerCommand("agents", {
		description: "Show the Codex-style agent tree and lifecycle status",
		handler: async (_args, ctx) => {
			activeContext = ctx;
			const agents = control.list(ctx);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(agents.map((agent) => `${agent.path}: ${agent.status}`).join("\n"), "info");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => ({
				render: (width) => renderAgentList(agents, theme, width),
				handleInput: (data) => {
					if (data === "\u001b" || data === "\r" || data === "\n") done();
					tui.requestRender();
				},
				invalidate() {},
			}), { overlay: true, overlayOptions: { anchor: "right-center", width: "55%", maxHeight: "80%", margin: 1 } });
		},
	});
}
