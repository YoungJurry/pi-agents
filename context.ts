import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { EXTENSION_ID } from "./types.ts";

export type ForkMode = "none" | "all" | number;

const SHARED_GUIDANCE = `All agents share the same working directory and filesystem. Edits made by one agent are immediately visible to every other agent. Coordinate ownership of files and avoid overwriting another agent's work.`;

export function rootAgentInstructions(): string {
	return `<multi_agent_role>You can delegate independent work to sub-agents. Call list_agents(include_roles=true) before using spawn_agent for the first time. Completion notices omit results; retrieve full results with list_agents(include_results=true).</multi_agent_role>`;
}

export function childAgentInstructions(path: string, parentPath: string, rolePrompt?: string): string {
	const role = rolePrompt?.trim() ? `\n\n<agent_role>\n${rolePrompt.trim()}\n</agent_role>` : "";
	return `<multi_agent_role>\nYou are ${path}, a sub-agent in a collaborative team. Your direct parent is ${parentPath}. Complete the assigned task independently. You can use the collaboration tools and may spawn child agents. Your full final response is stored as the task result; your parent receives only a brief completion notification. Do not repeatedly poll or send the same result manually.\n\n${SHARED_GUIDANCE}\n</multi_agent_role>${role}`;
}

export function formatTeamMessage(options: {
	type: "NEW_TASK" | "MESSAGE" | "AGENT_STATUS";
	taskName: string;
	sender: string;
	payload: string;
}): string {
	if (options.type === "AGENT_STATUS") return options.payload;
	return `Message Type: ${options.type}\nTask name: ${options.taskName}\nSender: ${options.sender}\nPayload:\n${options.payload}`;
}

export function parseForkMode(value: string | undefined): ForkMode {
	const normalized = value?.trim().toLowerCase() || "all";
	if (normalized === "none") return "none";
	if (normalized === "all") return "all";
	if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
		throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
	}
	return Number(normalized);
}

function assistantTextOnly(message: AssistantMessage): AssistantMessage | undefined {
	if (message.stopReason !== "stop") return undefined;
	const content = message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => ({ ...part }));
	if (content.length === 0) return undefined;
	return { ...message, content };
}

function isTaskBoundary(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	if (message.role !== "custom") return false;
	if (message.customType !== EXTENSION_ID) return false;
	const text = typeof message.content === "string"
		? message.content
		: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	return text.startsWith("Message Type: NEW_TASK\n");
}

function cloneMessage(message: AgentMessage): AgentMessage {
	return structuredClone(message);
}

/**
 * Build the semantic history inherited by a child. Tool calls/results, thinking,
 * bash transcripts, and prior inter-agent mail are intentionally removed.
 */
export function sanitizeForkMessages(messages: readonly AgentMessage[], mode: ForkMode): AgentMessage[] {
	if (mode === "none") return [];
	let selected = [...messages];
	if (typeof mode === "number") {
		let boundaries = 0;
		let start = 0;
		for (let index = selected.length - 1; index >= 0; index--) {
			if (!isTaskBoundary(selected[index]!)) continue;
			boundaries++;
			if (boundaries === mode) {
				start = index;
				break;
			}
		}
		selected = selected.slice(start);
	}

	const output: AgentMessage[] = [];
	for (const message of selected) {
		switch (message.role) {
			case "user":
				output.push(cloneMessage(message));
				break;
			case "assistant": {
				const cleaned = assistantTextOnly(message);
				if (cleaned) output.push(cloneMessage(cleaned));
				break;
			}
			case "branchSummary":
			case "compactionSummary":
				output.push(cloneMessage(message));
				break;
			case "custom":
				if (message.customType !== EXTENSION_ID) output.push(cloneMessage(message));
				break;
			default:
				break;
		}
	}
	return output;
}

export function lastAssistantAnswer(messages: readonly AgentMessage[]): { text: string; timestamp?: number; error?: string; aborted: boolean } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return {
			text,
			timestamp: message.timestamp,
			error: message.stopReason === "error" ? message.errorMessage || "agent error" : undefined,
			aborted: message.stopReason === "aborted",
		};
	}
	return { text: "", aborted: false };
}
