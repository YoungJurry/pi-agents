import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentControl } from "./control.ts";
import type {
	AgentToolCatalogEntry,
	AgentView,
	CollaborationDetails,
	CollaborationToolName,
} from "./types.ts";

const ThinkingLevelSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const AgentListViewSchema = StringEnum(["roles", "tools", "status", "results"] as const);
const SpawnAgentItemSchema = Type.Object({
	message: Type.String({ description: "Task to assign to the child agent" }),
	task_name: Type.String({ description: "Unique lowercase name using letters, digits, and underscores" }),
	agent_type: Type.Optional(Type.String({ description: "Optional role name returned by list_agents(view=\"roles\"); omit for general-purpose work" })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
	reasoning_effort: Type.Optional(ThinkingLevelSchema),
	fork_turns: Type.Optional(Type.String({ description: "none, all, or a positive integer string; defaults to all" })),
});

function details(tool: CollaborationToolName, sender: string, targets: AgentView[], message?: string, timedOut?: boolean): CollaborationDetails {
	return { tool, sender, targets, message, timedOut };
}

function result<T extends CollaborationDetails>(text: string, value: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details: value };
}

function compactStatus(agent: AgentView): string {
	const residency = agent.loaded ? "loaded" : "unloaded";
	const nickname = agent.nickname ? ` (${agent.nickname})` : "";
	const waiting = agent.status === "queued" ? `, waiting at queue position ${agent.queuePosition ?? "?"}` : "";
	return `${agent.path}${nickname}: ${agent.status}${waiting}, ${residency}`;
}

function catalogParameters(entry: AgentToolCatalogEntry): string {
	const schema = entry.parameters as { properties?: Record<string, unknown>; required?: string[] };
	const required = new Set(schema.required ?? []);
	return Object.keys(schema.properties ?? {}).map((name) => required.has(name) ? `${name}*` : name).join(", ");
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
	if (data.roles?.length) {
		lines.push(`  ${theme.fg("muted", "Roles:")} ${data.roles.map((role) => role.name).join(", ")}`);
		if (options.expanded) {
			for (const role of data.roles) {
				const configuration = [
					role.source,
					role.model ? `model: ${role.model}` : undefined,
					role.thinkingLevel ? `thinking: ${role.thinkingLevel}` : undefined,
					`tools: ${role.tools?.join(", ") || "default set"}`,
				].filter(Boolean).join(" · ");
				lines.push(`    ${theme.fg("accent", role.name)} — ${role.description}`);
				lines.push(`      ${theme.fg("dim", configuration)}`);
			}
		}
	}
	if (data.toolCatalog?.length) {
		lines.push(`  ${theme.fg("muted", "Tools:")} ${data.toolCatalog.map((tool) => tool.name).join(", ")}`);
		if (options.expanded) {
			for (const tool of data.toolCatalog) {
				lines.push(`    ${theme.fg("accent", tool.name)} — ${tool.description}`);
				lines.push(`      ${theme.fg("dim", catalogParameters(tool) || "no arguments")}`);
			}
		}
	}
	if (options.expanded && data.message) lines.push("", theme.fg("dim", data.message));
	return new Text(lines.join("\n"), 0, 0);
}

export function createCollaborationTools(control: AgentControl): ToolDefinition[] {
	const spawnAgents = defineTool({
		name: "spawn_agents",
		label: "Spawn Agents",
		description: "Create one or more independent child agents in one call; available execution slots start immediately and overflow waits in a visible persistent queue.",
		parameters: Type.Object({
			agents: Type.Array(SpawnAgentItemSchema, { minItems: 1, description: "One or more independent child tasks" }),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			onUpdate?.(result(`Preparing ${params.agents.length} child task${params.agents.length === 1 ? "" : "s"}…`, details("spawn_agents", sender, [])));
			const agents = await control.spawnMany(ctx, params.agents.map((agent) => ({
				message: agent.message,
				taskName: agent.task_name,
				agentType: agent.agent_type,
				model: agent.model,
				thinkingLevel: agent.reasoning_effort,
				forkTurns: agent.fork_turns,
			})));
			const capacity = control.getCounts();
			return result(
				JSON.stringify({
					agents: agents.map((agent) => ({
						path: agent.path,
						nickname: agent.nickname,
						status: agent.status,
						queue_position: agent.queuePosition,
					})),
					capacity,
				}),
				details("spawn_agents", sender, agents, `${agents.length} tasks accepted`),
			);
		},
		renderCall(args, theme) {
			return renderCallHeader("spawn_agents", `${args.agents.length} · ${args.agents.map((agent) => agent.task_name).join(", ")}`, theme);
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
		description: "Wait for agent activity and receive queued completion notices in the result; use this instead of polling.",
		parameters: Type.Object({
			timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			onUpdate?.(result("Waiting for mailbox activity…", details("wait_agent", sender, [])));
			const outcome = await control.waitForMailbox(ctx, params.timeout_ms, signal);
			if (outcome.aborted) throw new Error("wait_agent was aborted");
			const notices = control.drainPendingMail(sender);
			const agents = control.list(ctx);
			const text = notices.length > 0
				? `Mailbox activity received:\n\n${notices.join("\n\n")}`
				: outcome.timedOut
					? "Wait timed out."
					: "Mailbox activity received.";
			return result(text, details("wait_agent", sender, agents, text, outcome.timedOut));
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

	const directTools = [spawnAgents, sendMessage, followupTask, waitAgent, interruptAgent];
	const toolCatalog: AgentToolCatalogEntry[] = directTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	const directToolsByName = new Map(directTools.map((tool) => [tool.name, tool]));

	const agentAction = defineTool({
		name: "agent_action",
		label: "Agent Action",
		description: "Execute a sub-agent action returned by list_agents(view=\"tools\").",
		parameters: Type.Object({
			action: Type.String({ description: "Action name from the tool catalog" }),
			arguments: Type.Record(Type.String(), Type.Unknown(), { description: "Arguments matching the selected action schema" }),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			const actionTool = directToolsByName.get(params.action);
			if (!actionTool) throw new Error(`Unknown agent action '${params.action}'. Query list_agents(view="tools") for available actions.`);
			if (!Value.Check(actionTool.parameters, params.arguments)) {
				const first = Value.Errors(actionTool.parameters, params.arguments)[0];
				const problem = first ? `${first.instancePath || "/"}: ${first.message}` : "arguments do not match the action schema";
				throw new Error(`Invalid arguments for ${params.action}: ${problem}`);
			}
			return actionTool.execute(id, params.arguments, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return renderCallHeader("agent_action", args.action, theme);
		},
		renderResult: renderCollaborationResult,
	});

	const listAgents = defineTool({
		name: "list_agents",
		label: "List Agents",
		description: "Inspect sub-agent roles, action tools, status, or stored results.",
		parameters: Type.Object({
			view: AgentListViewSchema,
			path_prefix: Type.Optional(Type.String({ description: "Optional absolute path or caller-relative subtree prefix for status and results" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const sender = control.callerPath(ctx);
			if (params.view === "roles") {
				const roles = control.listRoles(ctx);
				return result(JSON.stringify({ roles }), {
					...details("list_agents", sender, []),
					roles,
				});
			}
			if (params.view === "tools") {
				return result(
					JSON.stringify({
						tools: toolCatalog,
						invoke_with: {
							tool: "agent_action",
							arguments: { action: "<tool name>", arguments: "<matching action arguments>" },
						},
					}),
					{
						...details("list_agents", sender, []),
						toolCatalog,
					},
				);
			}
			const agents = control.list(ctx, params.path_prefix, params.view === "results");
			const payload = params.view === "status" ? { agents, capacity: control.getCounts() } : { agents };
			return result(JSON.stringify(payload), details("list_agents", sender, agents));
		},
		renderCall(args, theme) {
			const scope = args.path_prefix ? `${args.view} · ${args.path_prefix}` : args.view;
			return renderCallHeader("list_agents", scope, theme);
		},
		renderResult: renderCollaborationResult,
	});

	return [...directTools, listAgents, agentAction];
}
