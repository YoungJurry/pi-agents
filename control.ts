import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	childAgentInstructions,
	formatTeamMessage,
	lastAssistantAnswer,
	parseForkMode,
	rootAgentInstructions,
	sanitizeForkMessages,
} from "./context.ts";
import { discoverRoles, resolveRole } from "./roles.ts";
import {
	DEFAULT_CHILD_THINKING_LEVEL,
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	DEFAULT_MAX_RESIDENT_SUBAGENTS,
	loadAgentSettings,
	selectAgentModel,
	selectAgentThinkingLevel,
} from "./settings.ts";
import {
	AGENT_GATEWAY_TOOL_NAMES,
	CHILD_META_ENTRY_TYPE,
	COLLABORATION_TOOL_NAMES,
	DIRECT_AGENT_TOOL_NAMES,
	EXTENSION_ID,
	FORK_CONTEXT_ENTRY_TYPE,
	ROOT_PATH,
	STATE_ENTRY_TYPE,
	type AgentCounts,
	type AgentLifecycleStatus,
	type AgentRecord,
	type AgentRole,
	type AgentRoleView,
	type AgentTranscriptView,
	type AgentView,
	type ForkContextPayload,
	type PersistedAgent,
	type PersistedTreeState,
	type RootBinding,
} from "./types.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;

const DEFAULT_NICKNAMES = [
	"Ada", "Alan", "Grace", "Linus", "Margaret", "Edsger", "Barbara", "Donald",
	"Frances", "Claude", "Hopper", "Turing", "Lovelace", "Shannon", "Knuth", "Dijkstra",
];

export interface SpawnRequest {
	message: string;
	taskName: string;
	agentType?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	forkTurns?: string;
}

interface PreparedSpawn {
	request: SpawnRequest;
	childPath: string;
	callerPath: string;
	role: AgentRole;
	selectedModel: Model<any>;
	thinkingLevel?: ThinkingLevel;
	forkMessages: AgentMessage[];
}

interface MessageRequest {
	target: string;
	message: string;
	triggerTurn: boolean;
}

interface StateWaiter {
	resolve: (value: "mailbox" | "timeout" | "aborted") => void;
	timer: ReturnType<typeof setTimeout>;
	abort?: () => void;
}

interface RootStorageOwner {
	version: 1;
	rootSessionId: string;
	rootSessionFile?: string;
}

function normalizeAgentName(name: string): string {
	const normalized = name.trim();
	if (!normalized) throw new Error("task_name must not be empty");
	if (normalized === "root" || normalized === "." || normalized === "..") {
		throw new Error(`task_name '${normalized}' is reserved`);
	}
	if (!/^[a-z0-9_]+$/.test(normalized)) {
		throw new Error("task_name must use only lowercase letters, digits, and underscores");
	}
	return normalized;
}

function clonePersisted(record: AgentRecord): PersistedAgent {
	return {
		id: record.id,
		path: record.path,
		parentPath: record.parentPath,
		parentId: record.parentId,
		taskName: record.taskName,
		nickname: record.nickname,
		role: record.role,
		modelProvider: record.modelProvider,
		modelId: record.modelId,
		thinkingLevel: record.thinkingLevel,
		status: record.status,
		statusMessage: record.statusMessage,
		resultFile: record.resultFile,
		sessionFile: record.sessionFile,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		lastUsedAt: record.lastUsedAt,
		lastAssignedAt: record.lastAssignedAt,
		queuedMessage: record.queuedMessage,
		queuedMail: record.queuedMail,
	};
}

function isPersistedState(value: unknown): value is PersistedTreeState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<PersistedTreeState>;
	return state.version === 1 && typeof state.rootSessionId === "string" && Array.isArray(state.agents);
}

export class AgentControl {
	private readonly agentsByPath = new Map<string, AgentRecord>();
	private readonly pathBySessionId = new Map<string, string>();
	private readonly mailboxPending = new Map<string, number>();
	private readonly waiters = new Map<string, Set<StateWaiter>>();
	private readonly listeners = new Set<() => void>();
	private readonly usedNicknames = new Set<string>();
	private readonly activeTurns = new Set<string>();
	private readonly pendingMail = new Map<string, string[]>();
	private root?: RootBinding;
	private rootStatus: AgentLifecycleStatus = "completed";
	private rootStatusMessage?: string;
	private tools: ToolDefinition[] = [];
	private readonly transcriptToolDefinitions = new Map<string, ToolDefinition>();
	private transcriptToolDefinitionsReady = false;
	private transcriptToolDefinitionsPromise?: Promise<void>;
	private modelRuntime?: ModelRuntime;
	private modelRuntimePromise?: Promise<ModelRuntime>;
	private activeExecutionSlots = 0;
	private schedulerPromise?: Promise<void>;
	private spawnOperationTail: Promise<void> = Promise.resolve();
	private disposed = false;
	private shuttingDown = false;
	private uiDialogTail: Promise<void> = Promise.resolve();
	private userOverlayDepth = 0;
	private readonly userOverlayWaiters = new Set<() => void>();
	private readonly rootStorageDirectory = path.join(getAgentDir(), "codex-agents", "roots");
	private childSessionDirectory = path.join(getAgentDir(), "codex-agents", "sessions");
	private agentResultDirectory = path.join(getAgentDir(), "codex-agents", "results");

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly selfExtensionPath: string,
		private readonly maxConcurrentSubagents = DEFAULT_MAX_CONCURRENT_SUBAGENTS,
		private readonly maxResidentSubagents = DEFAULT_MAX_RESIDENT_SUBAGENTS,
	) {}

	setTools(tools: ToolDefinition[]): void {
		this.tools = tools;
		for (const tool of tools) this.transcriptToolDefinitions.set(tool.name, tool);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	private enqueueUiDialog<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.uiDialogTail.then(operation, operation);
		this.uiDialogTail = result.then(() => undefined, () => undefined);
		return result;
	}

	beginUserOverlay(): () => void {
		this.userOverlayDepth++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.userOverlayDepth = Math.max(0, this.userOverlayDepth - 1);
			if (this.userOverlayDepth > 0) return;
			for (const resolve of this.userOverlayWaiters) resolve();
			this.userOverlayWaiters.clear();
		};
	}

	private waitForUserOverlayClose(): Promise<void> {
		if (this.userOverlayDepth === 0) return Promise.resolve();
		return new Promise((resolve) => this.userOverlayWaiters.add(resolve));
	}

	private enqueueSpawnOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.spawnOperationTail.then(operation, operation);
		this.spawnOperationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private configureChildTools(session: NonNullable<AgentRecord["session"]>): void {
		const hidden = new Set<string>([...DIRECT_AGENT_TOOL_NAMES, "spawn_agent"]);
		const active = session.getActiveToolNames().filter((name) => !hidden.has(name));
		for (const name of AGENT_GATEWAY_TOOL_NAMES) {
			if (!active.includes(name) && session.getToolDefinition(name)) active.push(name);
		}
		session.setActiveToolsByName(active);
	}

	private attachRootUi(record: AgentRecord, session: NonNullable<AgentRecord["session"]>): void {
		const root = this.root;
		if (!root?.ctx.hasUI) return;
		const rootUi = root.ctx.ui;
		const dialogMethods = new Set<PropertyKey>(["select", "confirm", "input", "editor"]);
		const proxiedUi = new Proxy(rootUi, {
			get: (target, property) => {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				if (dialogMethods.has(property)) {
					return (...args: unknown[]) => this.enqueueUiDialog(async () => {
						await this.waitForUserOverlayClose();
						const taggedArgs = [...args];
						if (typeof taggedArgs[0] === "string") taggedArgs[0] = `[${record.path}] ${taggedArgs[0]}`;
						return value.apply(target, taggedArgs);
					});
				}
				if (property === "custom") {
					return (...args: unknown[]) => this.enqueueUiDialog(async () => {
						await this.waitForUserOverlayClose();
						return value.apply(target, args);
					});
				}
				if (property === "notify") {
					return (message: string, ...args: unknown[]) => value.apply(target, [`[${record.path}] ${message}`, ...args]);
				}
				return value.bind(target);
			},
		}) as ExtensionUIContext;
		session.extensionRunner.setUIContext(proxiedUi, root.ctx.mode);
	}

	private migrateStoredFile(file: string | undefined, directory: string): { path: string | undefined; migrated: boolean } {
		if (!file) return { path: undefined, migrated: false };
		const source = path.resolve(file);
		const destinationDirectory = path.resolve(directory);
		if (path.dirname(source) === destinationDirectory) return { path: source, migrated: false };
		const target = path.join(destinationDirectory, path.basename(source));
		try {
			fs.mkdirSync(destinationDirectory, { recursive: true });
			if (fs.existsSync(source)) {
				if (fs.existsSync(target)) throw new Error(`agent storage migration target already exists: ${target}`);
				fs.renameSync(source, target);
				return { path: target, migrated: true };
			}
			if (fs.existsSync(target)) return { path: target, migrated: true };
		} catch {
			// Keep the original path and fail safely during lazy loading if it becomes unavailable.
		}
		return { path: source, migrated: false };
	}

	private configureRootStorage(ctx: ExtensionContext, sessionId: string): void {
		const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
		const rootDirectory = path.join(this.rootStorageDirectory, safeSessionId);
		this.childSessionDirectory = path.join(rootDirectory, "sessions");
		this.agentResultDirectory = path.join(rootDirectory, "results");
		try {
			fs.mkdirSync(this.childSessionDirectory, { recursive: true });
			fs.mkdirSync(this.agentResultDirectory, { recursive: true });
			const sessionFile = ctx.sessionManager.getSessionFile();
			const owner: RootStorageOwner = {
				version: 1,
				rootSessionId: sessionId,
				rootSessionFile: sessionFile ? path.resolve(sessionFile) : undefined,
			};
			fs.writeFileSync(path.join(rootDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
		} catch {
			// Session operation will surface a concrete error later if storage is unavailable.
		}
	}

	cleanupOrphanStorage(currentSessionId: string): number {
		if (!fs.existsSync(this.rootStorageDirectory)) return 0;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.rootStorageDirectory, { withFileTypes: true });
		} catch {
			return 0;
		}
		let removed = 0;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const directory = path.join(this.rootStorageDirectory, entry.name);
			let owner: RootStorageOwner;
			try {
				owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")) as RootStorageOwner;
			} catch {
				continue;
			}
			if (owner.version !== 1 || typeof owner.rootSessionId !== "string") continue;
			if (owner.rootSessionId === currentSessionId) continue;
			if (owner.rootSessionFile && fs.existsSync(owner.rootSessionFile)) continue;
			try {
				fs.rmSync(directory, { recursive: true, force: true });
				removed++;
			} catch {
				// A failed cleanup must not block resume.
			}
		}
		return removed;
	}

	bindRoot(ctx: ExtensionContext): void {
		this.disposed = false;
		this.shuttingDown = false;
		const sessionId = ctx.sessionManager.getSessionId();
		this.configureRootStorage(ctx, sessionId);
		const changedSession = this.root?.sessionId !== sessionId;
		this.root = {
			ctx,
			sessionId,
			cwd: ctx.cwd,
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel,
			systemPrompt: ctx.getSystemPrompt(),
		};
		this.pathBySessionId.set(sessionId, ROOT_PATH);
		if (changedSession) this.restoreState(ctx);
		this.changed();
		void this.scheduleQueued();
	}

	refreshRootContext(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const knownPath = this.pathBySessionId.get(sessionId);
		// Collaboration tools in child AgentSessions receive their own ExtensionContext.
		// Never mistake that context for a replacement root session.
		if (knownPath && knownPath !== ROOT_PATH) return;
		if (!this.root) {
			this.bindRoot(ctx);
			return;
		}
		if (this.root.sessionId !== sessionId) return;
		this.root.ctx = ctx;
		this.root.cwd = ctx.cwd;
		this.root.model = ctx.model;
		this.root.thinkingLevel = ctx.thinkingLevel;
		this.root.systemPrompt = ctx.getSystemPrompt();
	}

	setRootStatus(status: AgentLifecycleStatus, message?: string): void {
		this.rootStatus = status;
		this.rootStatusMessage = message;
		this.changed();
	}

	markMailboxConsumed(path: string): void {
		this.mailboxPending.set(path, 0);
	}

	noteTurnStart(path: string): void {
		this.activeTurns.add(path);
	}

	noteTurnEnd(path: string, stopReason?: string): void {
		if (!this.activeTurns.delete(path)) return;
		const queued = this.pendingMail.get(path) ?? [];
		if (queued.length === 0) return;
		const deferWithoutWake = stopReason === "aborted" || stopReason === "error";
		if (deferWithoutWake && path !== ROOT_PATH) {
			// Child sessions are resumed through launch(), which carries this mail into
			// the next explicit task without restarting an interrupted agent.
			return;
		}
		this.pendingMail.delete(path);
		const delivery = deferWithoutWake ? "nextTurn" : "steer";
		void this.flushMail(path, queued, delivery).catch(() => {
			const newer = this.pendingMail.get(path) ?? [];
			this.pendingMail.set(path, [...queued, ...newer]);
			this.changed();
		});
	}

	drainPendingMail(path: string): string[] {
		const queued = this.pendingMail.get(path) ?? [];
		this.pendingMail.delete(path);
		return queued;
	}

	private async flushMail(path: string, contents: string[], delivery: "steer" | "nextTurn"): Promise<void> {
		const content = contents.join("\n\n");
		const message = { customType: EXTENSION_ID, content, display: true, details: { type: "AGENT_STATUS" } };
		if (path === ROOT_PATH) {
			this.pi.sendMessage(message, {
				triggerTurn: delivery === "steer",
				deliverAs: delivery,
			});
			return;
		}
		const record = this.agentsByPath.get(path);
		if (!record) throw new Error(`agent ${path} not found while flushing queued mail`);
		if (!record.session) await this.ensureLoaded(record);
		if (delivery === "nextTurn") {
			await record.session!.sendCustomMessage(message, { triggerTurn: false, deliverAs: "nextTurn" });
		} else if (record.session!.isIdle) {
			this.launch(record, content);
		} else {
			await record.session!.sendCustomMessage(message, { triggerTurn: true, deliverAs: "steer" });
		}
		record.lastUsedAt = Date.now();
	}

	configureInitialRootTools(): void {
		const hidden = new Set<string>([...DIRECT_AGENT_TOOL_NAMES, "spawn_agent"]);
		const current = this.pi.getActiveTools();
		const next = current.filter((name) => !hidden.has(name));
		for (const name of AGENT_GATEWAY_TOOL_NAMES) {
			if (!next.includes(name)) next.push(name);
		}
		if (next.length !== current.length || next.some((name, index) => name !== current[index])) {
			this.pi.setActiveTools(next);
		}
	}

	callerPath(ctx: ExtensionContext): string {
		const sessionId = ctx.sessionManager.getSessionId();
		const caller = this.pathBySessionId.get(sessionId);
		if (caller === ROOT_PATH) this.refreshRootContext(ctx);
		if (!caller) throw new Error(`agent session ${sessionId} is not registered in this agent tree`);
		return caller;
	}

	private callerMessages(ctx: ExtensionContext): AgentMessage[] {
		const callerPath = this.callerPath(ctx);
		if (callerPath === ROOT_PATH) {
			return buildSessionContext(
				ctx.sessionManager.getEntries(),
				ctx.sessionManager.getLeafId(),
			).messages;
		}
		const record = this.agentsByPath.get(callerPath);
		if (!record?.session) throw new Error(`agent ${callerPath} is not loaded`);
		return record.session.messages;
	}

	private resolveReference(callerPath: string, reference: string): string {
		const target = reference.trim();
		if (!target) throw new Error("target must not be empty");
		if (target === ROOT_PATH) return ROOT_PATH;
		if (target.startsWith("/")) return target;
		if (/^[0-9a-f-]{16,}$/i.test(target)) {
			const byId = this.pathBySessionId.get(target);
			if (byId) return byId;
		}
		return `${callerPath}/${target}`;
	}

	private requireTarget(callerPath: string, reference: string): { path: string; record?: AgentRecord } {
		const targetPath = this.resolveReference(callerPath, reference);
		if (targetPath === ROOT_PATH) return { path: ROOT_PATH };
		const record = this.agentsByPath.get(targetPath);
		if (!record) throw new Error(`live agent path '${targetPath}' not found`);
		return { path: targetPath, record };
	}

	private reserveExecutionSlot(): void {
		if (this.activeExecutionSlots >= this.maxConcurrentSubagents) {
			throw new Error(`agent concurrency limit reached (${this.maxConcurrentSubagents} subagents)`);
		}
		this.activeExecutionSlots++;
	}

	private releaseExecutionSlot(record: AgentRecord): void {
		if (!record.holdsExecutionSlot) return;
		record.holdsExecutionSlot = false;
		this.activeExecutionSlots = Math.max(0, this.activeExecutionSlots - 1);
	}

	private reserveNickname(candidates?: string[]): string {
		const pool = candidates?.length ? candidates : DEFAULT_NICKNAMES;
		for (const name of pool) {
			if (!this.usedNicknames.has(name)) {
				this.usedNicknames.add(name);
				return name;
			}
		}
		let suffix = 2;
		while (true) {
			for (const name of pool) {
				const candidate = `${name} ${suffix}`;
				if (!this.usedNicknames.has(candidate)) {
					this.usedNicknames.add(candidate);
					return candidate;
				}
			}
			suffix++;
		}
	}

	private async getModelRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
		if (this.modelRuntime) return this.modelRuntime;
		if (this.modelRuntimePromise) return this.modelRuntimePromise;
		const agentDir = getAgentDir();
		this.modelRuntimePromise = ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
		}).then((runtime) => {
			for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
				const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
				if (nativeProvider) runtime.registerNativeProvider(nativeProvider);
				const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
				if (config) runtime.registerProvider(providerId, config);
			}
			this.modelRuntime = runtime;
			return runtime;
		});
		return this.modelRuntimePromise;
	}

	private async resolveModel(ctx: ExtensionContext, requested?: string): Promise<Model<any>> {
		const value = requested?.trim();
		if (!value) {
			throw new Error("no sub-agent model configured; set a task model, Role model, or defaultModel in agents-setting.json");
		}
		const runtime = await this.getModelRuntime(ctx);
		const slash = value.indexOf("/");
		if (slash > 0) {
			const model = runtime.getModel(value.slice(0, slash), value.slice(slash + 1));
			if (model) return model;
		} else {
			const matches = runtime.getModels().filter((model) => model.id === value);
			if (matches.length === 1) return matches[0]!;
			if (matches.length > 1) throw new Error(`model '${value}' is ambiguous; use provider/model`);
		}
		throw new Error(`model '${value}' not found`);
	}

	private captureTranscriptToolDefinitions(loader: DefaultResourceLoader): void {
		for (const extension of loader.getExtensions().extensions) {
			for (const registered of extension.tools.values()) {
				if (!this.transcriptToolDefinitions.has(registered.definition.name)) {
					this.transcriptToolDefinitions.set(registered.definition.name, registered.definition);
				}
			}
		}
		this.transcriptToolDefinitionsReady = true;
	}

	async prepareTranscriptToolDefinitions(ctx: ExtensionContext): Promise<void> {
		if (this.transcriptToolDefinitionsReady) return;
		if (!this.transcriptToolDefinitionsPromise) {
			const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());
			this.transcriptToolDefinitionsPromise = this.createLoader(ctx.cwd, settingsManager, "")
				.then(() => undefined)
				.catch((error) => {
					this.transcriptToolDefinitionsPromise = undefined;
					throw error;
				});
		}
		await this.transcriptToolDefinitionsPromise;
	}

	private async createLoader(cwd: string, settingsManager: SettingsManager, instructions: string): Promise<DefaultResourceLoader> {
		const selfPath = path.resolve(this.selfExtensionPath);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			settingsManager,
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter((extension) => path.resolve(extension.resolvedPath) !== selfPath),
			}),
			systemPromptOverride: (base) => `${base || "You are a coding agent."}\n\n${instructions}`,
		});
		await loader.reload();
		this.captureTranscriptToolDefinitions(loader);
		return loader;
	}

	private async evictForResidency(protectedPath?: string): Promise<void> {
		const allResidents = [...this.agentsByPath.values()].filter((record) => record.loaded);
		if (allResidents.length < this.maxResidentSubagents) return;
		const candidate = allResidents
			.filter((record) => record.path !== protectedPath)
			.filter((record) => record.status !== "running" && !record.holdsExecutionSlot && record.session?.isIdle !== false)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
		if (!candidate) throw new Error(`agent residency limit reached (${this.maxResidentSubagents}); all resident agents are busy`);
		this.unload(candidate);
	}

	private unload(record: AgentRecord): void {
		record.unsubscribe?.();
		record.unsubscribe = undefined;
		record.session?.dispose();
		record.session = undefined;
		record.loaded = false;
		record.updatedAt = Date.now();
		this.changed();
	}

	private childInstructions(record: Pick<AgentRecord, "path" | "parentPath" | "role">, rolePrompt?: string): string {
		return childAgentInstructions(record.path, record.parentPath, rolePrompt);
	}

	private subscribe(record: AgentRecord): void {
		const session = record.session;
		if (!session) return;
		record.unsubscribe?.();
		record.unsubscribe = session.subscribe((event) => {
			record.lastUsedAt = Date.now();
			if (event.type === "agent_start") {
				record.status = "running";
				record.statusMessage = undefined;
				record.updatedAt = Date.now();
			}
			if (event.type === "turn_start") {
				this.activeTurns.add(record.path);
				this.markMailboxConsumed(record.path);
			}
			if (event.type === "turn_end") {
				this.noteTurnEnd(record.path, event.message.role === "assistant" ? event.message.stopReason : undefined);
			}
			if (event.type === "message_update" || event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				record.updatedAt = Date.now();
			}
			if (event.type === "agent_end" && !event.willRetry) {
				this.completeRun(record, event.messages);
				if (this.activeTurns.has(record.path)) {
					const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
					this.noteTurnEnd(record.path, lastAssistant?.role === "assistant" ? lastAssistant.stopReason : undefined);
				}
			}
			this.changed();
		});
	}

	private writeAgentResult(record: AgentRecord): string | undefined {
		if (!record.finalAnswer) return undefined;
		try {
			fs.mkdirSync(this.agentResultDirectory, { recursive: true });
			const resultFile = path.join(this.agentResultDirectory, `${record.id}.md`);
			fs.writeFileSync(resultFile, record.finalAnswer, "utf8");
			record.resultFile = resultFile;
			return resultFile;
		} catch {
			return undefined;
		}
	}

	private completionNotice(record: AgentRecord): string {
		const suffix = record.statusMessage ? `: ${record.statusMessage}` : "";
		return `[agent ${record.status}] ${record.path}${suffix}\nPull: list_agents(view=\"results\", path_prefix=\"${record.path}\")`;
	}

	private completeRun(record: AgentRecord, messages: readonly AgentMessage[]): void {
		const answer = lastAssistantAnswer(messages.length > 0 ? messages : record.session?.messages || []);
		if (answer.timestamp && answer.timestamp === record.lastCompletionTimestamp) return;
		record.lastCompletionTimestamp = answer.timestamp;
		record.updatedAt = Date.now();
		if (answer.aborted) {
			record.status = "interrupted";
			record.statusMessage = "interrupted";
			this.releaseExecutionSlot(record);
			this.persistState();
			this.changed();
			void this.scheduleQueued();
			return;
		}
		if (answer.error) {
			record.status = "errored";
			record.statusMessage = answer.error;
			record.finalAnswer = answer.error;
		} else {
			record.status = "completed";
			record.finalAnswer = answer.text || "(no final answer)";
			record.statusMessage = undefined;
		}
		this.writeAgentResult(record);
		this.releaseExecutionSlot(record);
		this.persistState();
		this.changed();
		void this.scheduleQueued();
		void this.deliver(record.path, record.parentPath, this.completionNotice(record), false, "AGENT_STATUS").catch(() => {});
	}

	private launch(record: AgentRecord, content: string): void {
		const session = record.session;
		if (!session) throw new Error(`agent ${record.path} is not loaded`);
		const carriedMail = this.drainPendingMail(record.path);
		if (carriedMail.length > 0) {
			this.mailboxPending.set(record.path, 0);
			content = `${carriedMail.join("\n\n")}\n\n${content}`;
		}
		if (!record.holdsExecutionSlot) {
			this.reserveExecutionSlot();
			record.holdsExecutionSlot = true;
		}
		record.launchGeneration++;
		record.status = "running";
		record.statusMessage = undefined;
		record.lastUsedAt = Date.now();
		const generation = record.launchGeneration;
		void session.sendCustomMessage(
			{
				customType: EXTENSION_ID,
				content,
				display: true,
				details: { sender: record.parentPath, recipient: record.path },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		).catch((error) => {
			if (generation !== record.launchGeneration) return;
			if (carriedMail.length > 0) {
				const newer = this.pendingMail.get(record.path) ?? [];
				this.pendingMail.set(record.path, [...carriedMail, ...newer]);
			}
			record.status = "errored";
			record.statusMessage = error instanceof Error ? error.message : String(error);
			record.finalAnswer = record.statusMessage;
			record.updatedAt = Date.now();
			this.releaseExecutionSlot(record);
			this.persistState();
			void this.scheduleQueued();
			this.changed();
			void this.deliver(record.path, record.parentPath, this.completionNotice(record), false, "AGENT_STATUS").catch(() => {});
		}).finally(() => {
			if (generation === record.launchGeneration && record.status === "running" && session.isIdle) {
				record.status = "completed";
				this.releaseExecutionSlot(record);
				void this.scheduleQueued();
			}
			this.changed();
		});
	}

	private async prepareSpawnBatch(ctx: ExtensionContext, requests: SpawnRequest[]): Promise<PreparedSpawn[]> {
		if (this.disposed || this.shuttingDown) throw new Error("agent control is shutting down");
		if (requests.length === 0) throw new Error("agents must contain at least one task");
		const callerPath = this.callerPath(ctx);
		const callerMessages = this.callerMessages(ctx);
		const settings = loadAgentSettings();
		const seenPaths = new Set<string>();
		const prepared: PreparedSpawn[] = [];
		for (const request of requests) {
			const taskName = normalizeAgentName(request.taskName);
			const childPath = `${callerPath}/${taskName}`;
			if (seenPaths.has(childPath)) throw new Error(`agent path '${childPath}' is duplicated in this batch`);
			if (this.agentsByPath.has(childPath)) {
				throw new Error(`agent path '${childPath}' already exists`);
			}
			if (!request.message.trim()) throw new Error(`message for '${taskName}' must not be empty`);
			seenPaths.add(childPath);
			const role = resolveRole(ctx.cwd, ctx.isProjectTrusted(), request.agentType);
			const selectedModel = await this.resolveModel(
				ctx,
				selectAgentModel(request.model, role.model, settings.defaultModel),
			);
			prepared.push({
				request: { ...request, taskName },
				childPath,
				callerPath,
				role,
				selectedModel,
				thinkingLevel: selectAgentThinkingLevel(
					selectedModel,
					request.model,
					request.thinkingLevel,
					role.thinkingLevel,
					settings.defaultThinkingLevel,
				),
				forkMessages: sanitizeForkMessages(callerMessages, parseForkMode(request.forkTurns)),
			});
		}
		return prepared;
	}

	private materializeQueuedBatch(ctx: ExtensionContext, prepared: PreparedSpawn[]): AgentRecord[] {
		const records: AgentRecord[] = [];
		const baseTime = Date.now();
		try {
			for (let index = 0; index < prepared.length; index++) {
				const item = prepared[index];
				const sessionManager = SessionManager.create(ctx.cwd, this.childSessionDirectory);
				const now = baseTime;
				const record: AgentRecord = {
					id: sessionManager.getSessionId(),
					path: item.childPath,
					parentPath: item.callerPath,
					parentId: item.callerPath === ROOT_PATH ? this.root!.sessionId : this.agentsByPath.get(item.callerPath)!.id,
					taskName: item.request.taskName,
					nickname: this.reserveNickname(item.role.nicknameCandidates),
					role: item.role.name,
					modelProvider: item.selectedModel.provider,
					modelId: item.selectedModel.id,
					thinkingLevel: item.thinkingLevel,
					status: "queued",
					statusMessage: "waiting for an execution slot",
					createdAt: now,
					updatedAt: now,
					lastUsedAt: now,
					lastAssignedAt: now,
					loaded: false,
					holdsExecutionSlot: false,
					launchGeneration: 0,
					queuedMessage: formatTeamMessage({
						type: "NEW_TASK",
						taskName: item.request.taskName,
						sender: item.callerPath,
						payload: item.request.message,
					}),
				};
				record.sessionFile = sessionManager.getSessionFile();
				records.push(record);
				if (!record.sessionFile) throw new Error(`failed to create persisted session for ${record.path}`);
				sessionManager.appendCustomEntry(CHILD_META_ENTRY_TYPE, {
					path: record.path,
					parentPath: record.parentPath,
					role: record.role,
				});
				sessionManager.appendCustomEntry(FORK_CONTEXT_ENTRY_TYPE, { messages: item.forkMessages });
			}
		} catch (error) {
			for (const record of records) {
				if (record.nickname) this.usedNicknames.delete(record.nickname);
				if (record.sessionFile) {
					try { fs.rmSync(record.sessionFile, { force: true }); } catch { /* best effort */ }
				}
			}
			throw error;
		}
		for (const record of records) {
			this.agentsByPath.set(record.path, record);
			this.pathBySessionId.set(record.id, record.path);
		}
		this.persistState();
		return records;
	}

	private async startQueued(record: AgentRecord): Promise<void> {
		if (record.status !== "queued") return;
		this.reserveExecutionSlot();
		record.holdsExecutionSlot = true;
		record.status = "pending_init";
		record.statusMessage = "initializing";
		record.updatedAt = Date.now();
		this.persistState();
		try {
			await this.ensureLoaded(record);
			if (this.shuttingDown || this.disposed) {
				record.status = "queued";
				record.statusMessage = "waiting for an execution slot";
				this.releaseExecutionSlot(record);
				this.unload(record);
				return;
			}
			const content = [...(record.queuedMail ?? []), record.queuedMessage].filter((item): item is string => Boolean(item)).join("\n\n");
			if ((record.queuedMail?.length ?? 0) > 0) this.mailboxPending.set(record.path, 0);
			record.queuedMessage = undefined;
			record.queuedMail = undefined;
			this.launch(record, content);
			this.persistState();
		} catch (error) {
			record.status = "errored";
			record.statusMessage = error instanceof Error ? error.message : String(error);
			record.finalAnswer = record.statusMessage;
			record.queuedMessage = undefined;
			record.queuedMail = undefined;
			record.updatedAt = Date.now();
			this.releaseExecutionSlot(record);
			this.writeAgentResult(record);
			this.persistState();
			void this.deliver(record.path, record.parentPath, this.completionNotice(record), false, "AGENT_STATUS").catch(() => {});
		}
	}

	private async runQueuedScheduler(): Promise<void> {
		while (!this.disposed && !this.shuttingDown && this.activeExecutionSlots < this.maxConcurrentSubagents) {
			const next = this.queuedRecords()[0];
			if (!next) break;
			await this.startQueued(next);
		}
	}

	private async scheduleQueued(): Promise<void> {
		if (this.disposed || this.shuttingDown) return;
		if (this.schedulerPromise) return this.schedulerPromise;
		const operation = this.runQueuedScheduler();
		this.schedulerPromise = operation;
		try {
			await operation;
		} finally {
			if (this.schedulerPromise === operation) this.schedulerPromise = undefined;
			if (!this.disposed && !this.shuttingDown && this.activeExecutionSlots < this.maxConcurrentSubagents && this.queuedRecords().length > 0) {
				queueMicrotask(() => void this.scheduleQueued());
			}
		}
	}

	async spawnMany(ctx: ExtensionContext, requests: SpawnRequest[]): Promise<AgentView[]> {
		return this.enqueueSpawnOperation(async () => {
			const prepared = await this.prepareSpawnBatch(ctx, requests);
			const records = this.materializeQueuedBatch(ctx, prepared);
			await this.scheduleQueued();
			return records.map((record) => this.view(record));
		});
	}

	private async deliver(
		senderPath: string,
		recipientPath: string,
		payload: string,
		triggerTurn: boolean,
		type: "NEW_TASK" | "MESSAGE" | "AGENT_STATUS" = triggerTurn ? "NEW_TASK" : "MESSAGE",
	): Promise<void> {
		const taskPath = type === "AGENT_STATUS" ? senderPath : recipientPath;
		const taskName = taskPath.split("/").filter(Boolean).at(-1) || "root";
		const content = formatTeamMessage({ type, taskName, sender: senderPath, payload });
		if (this.activeTurns.has(recipientPath)) {
			// Never append into a live turn: it would split assistant tool_calls from
			// their tool results and produce protocol-invalid history.
			const queued = this.pendingMail.get(recipientPath) ?? [];
			queued.push(content);
			this.pendingMail.set(recipientPath, queued);
		} else if (recipientPath === ROOT_PATH) {
			this.pi.sendMessage(
				{ customType: EXTENSION_ID, content, display: true, details: { sender: senderPath, recipient: recipientPath, type } },
				{ triggerTurn, deliverAs: "steer" },
			);
		} else {
			const record = this.agentsByPath.get(recipientPath);
			if (!record) throw new Error(`agent ${recipientPath} not found`);
			if (!record.session && (record.status === "queued" || record.status === "pending_init")) {
				record.queuedMail = [...(record.queuedMail ?? []), content];
				record.updatedAt = Date.now();
				this.persistState();
			} else {
				await this.ensureLoaded(record);
				const wasIdle = record.session!.isIdle;
				if (triggerTurn && wasIdle) {
					this.launch(record, content);
				} else {
					await record.session!.sendCustomMessage(
						{ customType: EXTENSION_ID, content, display: true, details: { sender: senderPath, recipient: recipientPath, type } },
						{ triggerTurn, deliverAs: "steer" },
					);
				}
				record.lastUsedAt = Date.now();
			}
		}
		this.notifyMailbox(recipientPath);
	}

	async message(ctx: ExtensionContext, request: MessageRequest): Promise<AgentView> {
		const callerPath = this.callerPath(ctx);
		if (!request.message.trim()) throw new Error("message must not be empty");
		const target = this.requireTarget(callerPath, request.target);
		if (request.triggerTurn && target.path === ROOT_PATH) {
			throw new Error("follow-up tasks cannot target the root agent");
		}
		await this.deliver(callerPath, target.path, request.message, request.triggerTurn);
		if (request.triggerTurn && target.record) {
			target.record.lastAssignedAt = Date.now();
			target.record.updatedAt = target.record.lastAssignedAt;
			this.persistState();
		}
		return target.path === ROOT_PATH ? this.rootView() : this.view(target.record!);
	}

	private notifyMailbox(recipientPath: string): void {
		this.mailboxPending.set(recipientPath, (this.mailboxPending.get(recipientPath) || 0) + 1);
		const waiters = this.waiters.get(recipientPath);
		if (waiters) {
			for (const waiter of [...waiters]) {
				clearTimeout(waiter.timer);
				waiter.abort?.();
				waiter.resolve("mailbox");
			}
			waiters.clear();
		}
		this.changed();
	}

	async waitForMailbox(ctx: ExtensionContext, timeoutMs?: number, signal?: AbortSignal): Promise<{ timedOut: boolean; aborted: boolean }> {
		const callerPath = this.callerPath(ctx);
		if ((this.pendingMail.get(callerPath)?.length || 0) > 0 || (this.mailboxPending.get(callerPath) || 0) > 0) {
			this.mailboxPending.set(callerPath, 0);
			return { timedOut: false, aborted: false };
		}
		const duration = Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
		const outcome = await new Promise<"mailbox" | "timeout" | "aborted">((resolve) => {
			const waiter: StateWaiter = {
				resolve,
				timer: setTimeout(() => {
					this.waiters.get(callerPath)?.delete(waiter);
					resolve("timeout");
				}, duration),
			};
			if (signal) {
				const onAbort = () => {
					clearTimeout(waiter.timer);
					this.waiters.get(callerPath)?.delete(waiter);
					resolve("aborted");
				};
				signal.addEventListener("abort", onAbort, { once: true });
				waiter.abort = () => signal.removeEventListener("abort", onAbort);
			}
			const set = this.waiters.get(callerPath) || new Set<StateWaiter>();
			set.add(waiter);
			this.waiters.set(callerPath, set);
		});
		if (outcome === "mailbox") this.mailboxPending.set(callerPath, 0);
		return { timedOut: outcome === "timeout", aborted: outcome === "aborted" };
	}

	async interrupt(ctx: ExtensionContext, reference: string): Promise<AgentView> {
		const callerPath = this.callerPath(ctx);
		const target = this.requireTarget(callerPath, reference);
		if (target.path === ROOT_PATH) throw new Error("root is not a spawned agent");
		if (target.path === callerPath) throw new Error("an agent cannot interrupt itself");
		const record = target.record!;
		if (record.status === "queued") {
			record.status = "interrupted";
			record.statusMessage = "cancelled while waiting for an execution slot";
			record.queuedMessage = undefined;
			record.queuedMail = undefined;
			record.updatedAt = Date.now();
			this.persistState();
			return this.view(record);
		}
		await this.ensureLoaded(record);
		await record.session!.abort();
		record.status = "interrupted";
		record.statusMessage = "interrupted";
		record.updatedAt = Date.now();
		this.releaseExecutionSlot(record);
		this.persistState();
		void this.scheduleQueued();
		return this.view(record);
	}

	list(ctx: ExtensionContext, prefix?: string, includeResults = false): AgentView[] {
		const callerPath = this.callerPath(ctx);
		const resolvedPrefix = prefix?.trim() ? this.resolveReference(callerPath, prefix) : undefined;
		const views = [this.rootView(), ...[...this.agentsByPath.values()].map((record) => this.view(record, includeResults))];
		return views
			.filter((agent) => !resolvedPrefix || agent.path === resolvedPrefix || agent.path.startsWith(`${resolvedPrefix}/`))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	transcript(ctx: ExtensionContext, reference: string): AgentTranscriptView {
		const callerPath = this.callerPath(ctx);
		const target = this.requireTarget(callerPath, reference);
		if (target.path === ROOT_PATH) throw new Error("the root transcript is already visible in the main session");
		const record = target.record!;
		if (!record.sessionFile) throw new Error(`agent ${record.path} has no persisted session file`);

		const sessionManager = SessionManager.open(record.sessionFile);
		const forkContextLength = this.forkContextFromSessionManager(sessionManager).length;
		const messages = record.session
			? structuredClone(record.session.messages.slice(forkContextLength))
			: structuredClone(sessionManager.buildSessionContext().messages);
		const toolNames = new Set<string>();
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall") toolNames.add(block.name);
			}
		}
		const toolDefinitions: ToolDefinition[] = [];
		for (const name of toolNames) {
			const liveDefinition = record.session?.getToolDefinition(name);
			if (liveDefinition) this.transcriptToolDefinitions.set(name, liveDefinition);
			const definition = liveDefinition ?? this.transcriptToolDefinitions.get(name);
			if (definition) toolDefinitions.push(definition);
		}
		return {
			agent: this.view(record),
			sessionFile: record.sessionFile,
			cwd: sessionManager.getCwd(),
			messages,
			toolDefinitions,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}

	listRoles(ctx: ExtensionContext): AgentRoleView[] {
		this.callerPath(ctx);
		const settings = loadAgentSettings();
		return discoverRoles(ctx.cwd, ctx.isProjectTrusted()).map((role) => ({
			name: role.name,
			description: role.description,
			model: role.model || settings.defaultModel,
			thinkingLevel: role.thinkingLevel ?? settings.defaultThinkingLevel ?? DEFAULT_CHILD_THINKING_LEVEL,
			tools: role.tools,
			source: role.source,
		}));
	}


	private rootView(): AgentView {
		return {
			id: this.root?.sessionId || "root",
			path: ROOT_PATH,
			model: this.root?.model ? `${this.root.model.provider}/${this.root.model.id}` : "unknown",
			thinkingLevel: this.root?.thinkingLevel,
			status: this.rootStatus,
			statusMessage: this.rootStatusMessage,
			loaded: true,
		};
	}

	private queuedRecords(): AgentRecord[] {
		return [...this.agentsByPath.values()]
			.filter((record) => record.status === "queued")
			.sort((left, right) => left.createdAt - right.createdAt);
	}

	private queuePosition(record: AgentRecord): number | undefined {
		if (record.status !== "queued") return undefined;
		const index = this.queuedRecords().findIndex((candidate) => candidate.path === record.path);
		return index >= 0 ? index + 1 : undefined;
	}

	view(record: AgentRecord, includeResult = false): AgentView {
		let storedAnswer = includeResult ? record.finalAnswer : undefined;
		if (includeResult && !storedAnswer && record.resultFile) {
			try { storedAnswer = fs.readFileSync(record.resultFile, "utf8"); } catch { /* result may have been cleaned up */ }
		}
		return {
			id: record.id,
			path: record.path,
			parentPath: record.parentPath,
			nickname: record.nickname,
			role: record.role,
			model: `${record.modelProvider}/${record.modelId}`,
			thinkingLevel: record.thinkingLevel,
			status: record.status,
			statusMessage: record.statusMessage,
			loaded: record.loaded,
			resultFile: includeResult ? record.resultFile : undefined,
			finalAnswer: storedAnswer,
			queuePosition: this.queuePosition(record),
			lastAssignedAt: record.lastAssignedAt ?? record.createdAt,
		};
	}

	private persistState(): void {
		if (!this.root || this.disposed) return;
		const state: PersistedTreeState = {
			version: 1,
			rootSessionId: this.root.sessionId,
			agents: [...this.agentsByPath.values()].map(clonePersisted),
		};
		try {
			this.pi.appendEntry(STATE_ENTRY_TYPE, state);
		} catch {
			// The root extension may already be stale during shutdown/reload.
		}
		this.changed();
	}

	private restoreState(ctx: ExtensionContext): void {
		for (const record of this.agentsByPath.values()) this.unload(record);
		this.agentsByPath.clear();
		this.pathBySessionId.clear();
		this.pathBySessionId.set(ctx.sessionManager.getSessionId(), ROOT_PATH);
		this.activeExecutionSlots = 0;
		this.usedNicknames.clear();
		let latest: PersistedTreeState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE && isPersistedState(entry.data)) latest = entry.data;
		}
		if (!latest || latest.rootSessionId !== ctx.sessionManager.getSessionId()) return;
		let migratedAnyFile = false;
		for (const persisted of latest.agents) {
			const status: AgentLifecycleStatus = persisted.status === "queued" || (persisted.status === "pending_init" && Boolean(persisted.queuedMessage))
				? "queued"
				: persisted.status === "running" || persisted.status === "pending_init"
					? "interrupted"
					: persisted.status;
			const migratedSession = this.migrateStoredFile(persisted.sessionFile, this.childSessionDirectory);
			const migratedResult = this.migrateStoredFile(persisted.resultFile, this.agentResultDirectory);
			migratedAnyFile ||= migratedSession.migrated || migratedResult.migrated;
			const record: AgentRecord = {
				...persisted,
				sessionFile: migratedSession.path,
				resultFile: migratedResult.path,
				status,
				statusMessage: status === "queued"
					? "waiting for an execution slot"
					: status === "interrupted" && persisted.status === "running"
						? "interrupted by previous session shutdown"
						: persisted.statusMessage,
				loaded: false,
				holdsExecutionSlot: false,
				launchGeneration: 0,
			};
			this.agentsByPath.set(record.path, record);
			this.pathBySessionId.set(record.id, record.path);
			if (record.nickname) this.usedNicknames.add(record.nickname);
		}
		if (migratedAnyFile) this.persistState();
	}

	private forkContextFromSessionManager(sessionManager: SessionManager): AgentMessage[] {
		const hasCompaction = sessionManager.getEntries().some((entry) => entry.type === "compaction");
		if (hasCompaction) return [];
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== FORK_CONTEXT_ENTRY_TYPE) continue;
			const payload = entry.data as ForkContextPayload | undefined;
			if (payload?.messages && Array.isArray(payload.messages)) return structuredClone(payload.messages);
		}
		return [];
	}

	private async ensureLoaded(record: AgentRecord): Promise<void> {
		if (record.session) {
			record.loaded = true;
			record.lastUsedAt = Date.now();
			return;
		}
		if (!record.sessionFile) throw new Error(`agent ${record.path} has no persisted session file`);
		if (!this.root) throw new Error("root session is not bound");
		await this.evictForResidency(record.path);
		const sessionManager = SessionManager.open(record.sessionFile);
		const forkContext = this.forkContextFromSessionManager(sessionManager);
		const role = resolveRole(this.root.cwd, this.root.ctx.isProjectTrusted(), record.role);
		const settingsManager = SettingsManager.create(this.root.cwd, getAgentDir());
		const loader = await this.createLoader(this.root.cwd, settingsManager, this.childInstructions(record, role.systemPrompt));
		const runtime = await this.getModelRuntime(this.root.ctx);
		const model = runtime.getModel(record.modelProvider, record.modelId) || this.root.model;
		if (!model) throw new Error(`model ${record.modelProvider}/${record.modelId} is unavailable`);
		const allowedTools = role.tools ? [...new Set([...role.tools, ...COLLABORATION_TOOL_NAMES])] : undefined;
		const { session } = await createAgentSession({
			cwd: this.root.cwd,
			agentDir: getAgentDir(),
			modelRuntime: runtime,
			model,
			thinkingLevel: record.thinkingLevel,
			tools: allowedTools,
			customTools: this.tools,
			resourceLoader: loader,
			sessionManager,
			settingsManager,
		});
		this.configureChildTools(session);
		if (forkContext.length > 0) session.agent.state.messages = [...forkContext, ...session.messages];
		record.session = session;
		this.attachRootUi(record, session);
		record.loaded = true;
		record.lastUsedAt = Date.now();
		this.pathBySessionId.set(session.sessionId, record.path);
		if (session.sessionId !== record.id) {
			this.pathBySessionId.delete(record.id);
			record.id = session.sessionId;
		}
		this.subscribe(record);
		this.changed();
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.schedulerPromise) {
			try { await this.schedulerPromise; } catch { /* scheduler failures are recorded per agent */ }
		}
		for (const waiters of this.waiters.values()) {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.abort?.();
				waiter.resolve("aborted");
			}
		}
		this.waiters.clear();
		this.activeTurns.clear();
		this.pendingMail.clear();
		for (const record of this.agentsByPath.values()) {
			if (record.session?.isStreaming) {
				try { await record.session.abort(); } catch { /* best effort */ }
				record.status = "interrupted";
				record.statusMessage = "root session shut down";
			}
			this.releaseExecutionSlot(record);
		}
		this.persistState();
		this.disposed = true;
		for (const record of this.agentsByPath.values()) this.unload(record);
		this.changed();
	}

	getRootInstructions(): string {
		return rootAgentInstructions();
	}

	getCounts(): AgentCounts {
		const records = [...this.agentsByPath.values()];
		return {
			running: records.filter((record) => record.status === "running" || record.status === "pending_init").length,
			queued: records.filter((record) => record.status === "queued").length,
			loaded: records.filter((record) => record.loaded).length,
			total: records.length,
			slots: this.maxConcurrentSubagents,
			residentSlots: this.maxResidentSubagents,
		};
	}
}
