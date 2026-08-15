import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const EXTENSION_ID = "codex-agents";
export const STATE_ENTRY_TYPE = "codex-agents-state";
export const CHILD_META_ENTRY_TYPE = "codex-agents-child-meta";
export const FORK_CONTEXT_ENTRY_TYPE = "codex-agents-fork-context";
export const ROOT_PATH = "/root";
export const COLLABORATION_TOOL_NAMES = [
	"spawn_agent",
	"send_message",
	"followup_task",
	"wait_agent",
	"interrupt_agent",
	"list_agents",
] as const;

export type CollaborationToolName = (typeof COLLABORATION_TOOL_NAMES)[number];
export type AgentLifecycleStatus =
	| "pending_init"
	| "running"
	| "interrupted"
	| "completed"
	| "errored"
	| "shutdown";

export interface PersistedAgent {
	id: string;
	path: string;
	parentPath: string;
	parentId: string;
	taskName: string;
	nickname?: string;
	role?: string;
	modelProvider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	status: AgentLifecycleStatus;
	statusMessage?: string;
	finalAnswer?: string;
	resultFile?: string;
	sessionFile?: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number;
}

export interface PersistedTreeState {
	version: 1;
	rootSessionId: string;
	agents: PersistedAgent[];
}

export interface AgentRecord extends PersistedAgent {
	session?: AgentSession;
	unsubscribe?: () => void;
	loaded: boolean;
	holdsExecutionSlot: boolean;
	launchGeneration: number;
	lastCompletionTimestamp?: number;
}

export interface RootBinding {
	ctx: ExtensionContext;
	sessionId: string;
	cwd: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	systemPrompt: string;
}

export interface AgentView {
	id: string;
	path: string;
	parentPath?: string;
	nickname?: string;
	role?: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	status: AgentLifecycleStatus;
	statusMessage?: string;
	loaded: boolean;
	resultFile?: string;
	finalAnswer?: string;
}

export interface CollaborationDetails {
	tool: CollaborationToolName;
	sender: string;
	targets: AgentView[];
	message?: string;
	timedOut?: boolean;
	roles?: AgentRoleView[];
	enabledTools?: string[];
}

export interface ForkContextPayload {
	messages: AgentMessage[];
}

export interface ChildMetaPayload {
	path: string;
	parentPath: string;
	role?: string;
}

export interface AgentRoleView {
	name: string;
	description: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	source: "builtin" | "user" | "project";
}

export interface AgentRole {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	nicknameCandidates?: string[];
	source: "builtin" | "user" | "project";
}
