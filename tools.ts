import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentControl } from "./control.ts";
import type { AgentView, CollaborationDetails, CollaborationToolName } from "./types.ts";

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

function details(tool: CollaborationToolName, sender: string, targets: AgentView[], message?: string, timedOut?: boolean): CollaborationDetails {
	return { tool, sender, targets, message, timedOut };
}

function result<T extends CollaborationDetails>(text: string, value: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details: value };
}

function compactStatus(agent: AgentView): string {
	const residency = agent.loaded ? "loaded" : "unloaded";
	const nickname = agent.nickname ? ` (${agent.nickname})` : "";
	return `${agent.path}${nickname}: ${agent.status}, ${residency}`;
}

function renderCallHeader(name: string, summary: string, theme: any): Text {
	return new Text(
		`${theme.fg("toolTitle", theme.bold(`${name} `))}${theme.fg("accent", summary)}`,
		0,
		0,
	);
}

function renderCollaborationResult(
	toolResult: AgentToolResult<CollaborationDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: any,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Waiting for agent activity…"), 0, 0);
	const data = toolResult.details;
	if (!data) {
		const item = toolResult.content[0];
		return new Text(item?.type === "text" ? item.text : "(no output)", 0, 0);
	}
	const icon = data.timedOut ? theme.fg("warning", "◷") : theme.fg("success", "✓");
	const lines = [`${icon} ${theme.fg("toolTitle", data.tool)}`];
	for (const agent of data.targets) lines.push(`  ${theme.fg("accent", compactStatus(agent))}`);
	if (options.expanded && data.message) lines.push("", theme.fg("dim", data.message));
	return new Text(lines.join("\n"), 0, 0);
}

export function createCollaborationTools(control: AgentControl): ToolDefinition[] {
	const spawnAgent = defineTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Delegate independent work to a persistent child agent; returns its path immediately.",
		parameters: Type.Object({
			message: Type.String({ description: "Task to assign to the child agent" }),
			task_name: Type.String({ description: "Unique lowercase name using letters, digits, and underscores" }),
			agent_type: Type.Optional(Type.String({ description: "Optional role name returned by list_agents(include_roles=true); omit for general-purpose work" })),
			model: Type.Optional(Type.String({ description: "Optional provider/model override; unavailable for full-history forks" })),
			reasoning_effort: Type.Optional(ThinkingLevelSchema),
			fork_turns: Type.Optional(Type.String({ description: "none, all, or a positive integer string; defaults to all" })),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			onUpdate?.(result("Creating child AgentSession…", details("spawn_agent", sender, [], params.message)));
			const agent = await control.spawn(ctx, {
				message: params.message,
				taskName: params.task_name,
				agentType: params.agent_type,
				model: params.model,
				thinkingLevel: params.reasoning_effort,
				forkTurns: params.fork_turns,
			});
			return result(
				JSON.stringify({ task_name: agent.path, nickname: agent.nickname, status: agent.status }),
				details("spawn_agent", sender, [agent], params.message),
			);
		},
		renderCall(args, theme) {
			return renderCallHeader("spawn_agent", `${args.task_name} ← ${args.message}`, theme);
		},
		renderResult: renderCollaborationResult,
	});

	const sendMessage = defineTool({
		name: "send_message",
		label: "Send Message",
		description: "Message an agent without waking an idle target.",
		parameters: Type.Object({
			target: Type.String({ description: "Absolute agent path, child-relative name, or agent session ID" }),
			message: Type.String({ description: "Message to deliver" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			const target = await control.message(ctx, { target: params.target, message: params.message, triggerTurn: false });
			return result("", details("send_message", sender, [target], params.message));
		},
		renderCall(args, theme) {
			return renderCallHeader("send_message", `${args.target} ← ${args.message}`, theme);
		},
		renderResult: renderCollaborationResult,
	});

	const followupTask = defineTool({
		name: "followup_task",
		label: "Follow-up Task",
		description: "Assign follow-up work and start the target agent.",
		parameters: Type.Object({
			target: Type.String({ description: "Absolute agent path, child-relative name, or agent session ID" }),
			message: Type.String({ description: "Follow-up task" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			const target = await control.message(ctx, { target: params.target, message: params.message, triggerTurn: true });
			return result("", details("followup_task", sender, [target], params.message));
		},
		renderCall(args, theme) {
			return renderCallHeader("followup_task", `${args.target} ← ${args.message}`, theme);
		},
		renderResult: renderCollaborationResult,
	});

	const waitAgent = defineTool({
		name: "wait_agent",
		label: "Wait Agent",
		description: "Wait for agent activity; use this instead of polling.",
		parameters: Type.Object({
			timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			onUpdate?.(result("Waiting for mailbox activity…", details("wait_agent", sender, [])));
			const outcome = await control.waitForMailbox(ctx, params.timeout_ms, signal);
			if (outcome.aborted) throw new Error("wait_agent was aborted");
			const agents = control.list(ctx);
			return result(
				outcome.timedOut ? "Wait timed out." : "Mailbox activity received; inspect the injected team message.",
				details("wait_agent", sender, agents, undefined, outcome.timedOut),
			);
		},
		renderCall(args, theme) {
			return renderCallHeader("wait_agent", `${args.timeout_ms ?? 30_000}ms`, theme);
		},
		renderResult: renderCollaborationResult,
	});

	const interruptAgent = defineTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description: "Stop a running agent while keeping it available for follow-up.",
		parameters: Type.Object({
			target: Type.String({ description: "Absolute agent path, child-relative name, or agent session ID" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			const target = await control.interrupt(ctx, params.target);
			return result(JSON.stringify({ previous_or_current_status: target.status }), details("interrupt_agent", sender, [target]));
		},
		renderCall(args, theme) {
			return renderCallHeader("interrupt_agent", args.target, theme);
		},
		renderResult: renderCollaborationResult,
	});

	const listAgents = defineTool({
		name: "list_agents",
		label: "List Agents",
		description: "Discover roles, manage agents, and retrieve stored results.",
		parameters: Type.Object({
			path_prefix: Type.Optional(Type.String({ description: "Absolute path or caller-relative subtree prefix" })),
			include_roles: Type.Optional(Type.Boolean({ description: "Discover roles and enable collaboration tools" })),
			include_results: Type.Optional(Type.Boolean({ description: "Include stored final answers; defaults to false" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			const agents = control.list(ctx, params.path_prefix, params.include_results ?? false);
			if (!params.include_roles) {
				return result(JSON.stringify({ agents }), details("list_agents", sender, agents));
			}
			const roles = control.listRoles(ctx);
			const enabledTools = control.enableCollaborationTools(ctx);
			return result(
				JSON.stringify({ agents, roles, enabled_tools: enabledTools }),
				details("list_agents", sender, agents),
			);
		},
		renderCall(args, theme) {
			return renderCallHeader("list_agents", args.path_prefix || "all", theme);
		},
		renderResult: renderCollaborationResult,
	});

	return [spawnAgent, sendMessage, followupTask, waitAgent, interruptAgent, listAgents];
}
