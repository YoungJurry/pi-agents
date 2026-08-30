import type { KeybindingsManager, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { ROOT_PATH, type AgentTranscriptView, type AgentView } from "./types.ts";

type ChangeSubscriber = (listener: () => void) => () => void;

function statusIcon(status: AgentView["status"]): string {
	switch (status) {
		case "queued": return "◷";
		case "running": return "●";
		case "completed": return "✓";
		case "errored": return "✗";
		case "interrupted": return "■";
		case "pending_init": return "○";
		case "shutdown": return "×";
	}
}

function statusColor(status: AgentView["status"]): "success" | "error" | "warning" | "muted" | "dim" {
	switch (status) {
		case "queued": return "dim";
		case "running": return "warning";
		case "completed": return "success";
		case "errored": return "error";
		case "interrupted": return "muted";
		case "pending_init": return "dim";
		case "shutdown": return "muted";
	}
}

function framedRow(theme: Theme, content: string, innerWidth: number, selected = false): string {
	let body = truncateToWidth(content, innerWidth, "", true);
	if (selected) body = theme.bg("selectedBg", body);
	return `${theme.fg("border", "│")}${body}${theme.fg("border", "│")}`;
}

function framedRule(theme: Theme, innerWidth: number, left: "├" | "╭" | "╰", right: "┤" | "╮" | "╯"): string {
	return theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
}

function itemLine(agent: AgentView, theme: Theme, width: number): string {
	const depth = Math.max(0, agent.path.split("/").filter(Boolean).length - 2);
	const name = agent.path.split("/").at(-1) || agent.path;
	const branch = `${"  ".repeat(depth)}${depth > 0 ? "└─ " : ""}`;
	const icon = theme.fg(statusColor(agent.status), statusIcon(agent.status));
	const nickname = agent.nickname ? theme.fg("muted", ` (${agent.nickname})`) : "";
	const residency = agent.status === "queued"
		? theme.fg("warning", ` [waiting #${agent.queuePosition ?? "?"}]`)
		: agent.loaded ? "" : theme.fg("dim", " [unloaded]");
	const left = `${branch}${icon} ${theme.fg("accent", name)}${nickname}${residency}`;
	const right = theme.fg("dim", agent.status === "queued" ? `queued #${agent.queuePosition ?? "?"}` : agent.status);
	const available = Math.max(1, width - visibleWidth(right) - 2);
	const clipped = truncateToWidth(left, available, "…");
	return `${clipped}${" ".repeat(Math.max(1, width - visibleWidth(clipped) - visibleWidth(right)))}${right}`;
}

export class AgentPickerComponent {
	private agents: AgentView[] = [];
	private selectedIndex = 0;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly loadAgents: () => AgentView[],
		subscribe: ChangeSubscriber,
		private readonly done: (path: string | undefined) => void,
	) {
		this.refresh();
		this.unsubscribe = subscribe(() => {
			this.refresh();
			this.tui.requestRender();
		});
	}

	private refresh(): void {
		const selectedPath = this.agents[this.selectedIndex]?.path;
		this.agents = this.loadAgents().filter((agent) => agent.path !== ROOT_PATH);
		const nextIndex = selectedPath ? this.agents.findIndex((agent) => agent.path === selectedPath) : -1;
		this.selectedIndex = nextIndex >= 0
			? nextIndex
			: Math.min(this.selectedIndex, Math.max(0, this.agents.length - 1));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + 1);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 8);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + 8);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.agents[this.selectedIndex];
			if (selected) this.done(selected.path);
			return;
		} else if (data === "r") {
			this.refresh();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const maxVisible = Math.max(1, Math.min(14, this.tui.terminal.rows - 9));
		const maxStart = Math.max(0, this.agents.length - maxVisible);
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), maxStart));
		const visible = this.agents.slice(start, start + maxVisible);
		const lines = [
			framedRule(this.theme, innerWidth, "╭", "╮"),
			framedRow(this.theme, ` ${this.theme.fg("accent", this.theme.bold("Sub-agent sessions"))}`, innerWidth),
			framedRow(this.theme, ` ${this.theme.fg("dim", "Select an agent to inspect its read-only transcript")}`, innerWidth),
			framedRule(this.theme, innerWidth, "├", "┤"),
		];
		if (visible.length === 0) {
			lines.push(framedRow(this.theme, ` ${this.theme.fg("muted", "No sub-agents in this root session")}`, innerWidth));
		} else {
			for (let index = 0; index < visible.length; index++) {
				const absoluteIndex = start + index;
				const prefix = absoluteIndex === this.selectedIndex ? this.theme.fg("accent", "› ") : "  ";
				lines.push(framedRow(
					this.theme,
					`${prefix}${itemLine(visible[index]!, this.theme, Math.max(1, innerWidth - 2))}`,
					innerWidth,
					absoluteIndex === this.selectedIndex,
				));
			}
		}
		if (this.agents.length > maxVisible) {
			lines.push(framedRow(this.theme, ` ${this.theme.fg("dim", `${this.selectedIndex + 1}/${this.agents.length}`)}`, innerWidth));
		}
		lines.push(
			framedRule(this.theme, innerWidth, "├", "┤"),
			framedRow(this.theme, ` ${this.theme.fg("dim", "↑↓ navigate · Enter inspect · r refresh · Esc close")}`, innerWidth),
			framedRule(this.theme, innerWidth, "╰", "╯"),
		);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	const parts = content.map((part) => part.type === "text" ? (part.text ?? "") : `[${part.type}]`);
	return parts.filter(Boolean).join("\n");
}

function formatTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "unknown";
	return new Date(timestamp).toLocaleString();
}

export class AgentTranscriptViewer {
	private snapshot?: AgentTranscriptView;
	private error?: string;
	private content = new Container();
	private scrollOffset = 0;
	private followTail = true;
	private expandedTools = false;
	private hideThinking = false;
	private lastBodyHeight = 1;
	private lastBodyLines = 0;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private readonly unsubscribe: () => void;
	private toolDefinitions = new Map<string, ToolDefinition>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly loadTranscript: () => AgentTranscriptView,
		subscribe: ChangeSubscriber,
		private readonly done: () => void,
	) {
		this.refresh();
		this.unsubscribe = subscribe(() => this.scheduleRefresh());
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.refresh();
			this.tui.requestRender();
		}, 200);
	}

	private refresh(): void {
		try {
			this.snapshot = this.loadTranscript();
			this.toolDefinitions = new Map(this.snapshot.toolDefinitions.map((tool) => [tool.name, tool]));
			this.error = undefined;
			this.rebuildContent();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private rebuildContent(): void {
		this.content = new Container();
		const snapshot = this.snapshot;
		if (!snapshot) return;
		const markdownTheme = getMarkdownTheme();
		const pendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of snapshot.messages) {
			switch (message.role) {
				case "user": {
					const text = contentText(message.content);
					if (text) {
						if (this.content.children.length > 0) this.content.addChild(new Spacer(1));
						this.content.addChild(new UserMessageComponent(text, markdownTheme, 0));
					}
					break;
				}
				case "assistant": {
					this.content.addChild(new AssistantMessageComponent(message, this.hideThinking, markdownTheme, "thinking hidden", 0));
					for (const block of message.content) {
						if (block.type !== "toolCall") continue;
						const component = new ToolExecutionComponent(
							block.name,
							block.id,
							block.arguments,
							{ showImages: false },
							this.toolDefinitions.get(block.name),
							this.tui,
							snapshot.cwd,
						);
						component.markExecutionStarted();
						component.setArgsComplete();
						component.setExpanded(this.expandedTools);
						this.content.addChild(component);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							component.updateResult({
								content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }],
								isError: true,
							});
						} else {
							pendingTools.set(block.id, component);
						}
					}
					break;
				}
				case "toolResult": {
					const component = pendingTools.get(message.toolCallId);
					if (component) {
						component.updateResult(message);
						pendingTools.delete(message.toolCallId);
					} else {
						const text = contentText(message.content);
						this.content.addChild(new Text(
							this.theme.fg(message.isError ? "error" : "toolOutput", `[${message.toolName}] ${text}`),
							1,
							0,
						));
					}
					break;
				}
				case "custom": {
					if (message.display) {
						const component = new CustomMessageComponent(message, undefined, markdownTheme, 0);
						component.setExpanded(this.expandedTools);
						this.content.addChild(component);
					}
					break;
				}
				case "bashExecution": {
					const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
					component.appendOutput(message.output + (message.truncated ? "\n[output truncated]" : ""));
					component.setExpanded(this.expandedTools);
					component.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
					this.content.addChild(component);
					break;
				}
				case "compactionSummary": {
					const component = new CompactionSummaryMessageComponent(message, markdownTheme);
					component.setExpanded(this.expandedTools);
					this.content.addChild(component);
					break;
				}
				case "branchSummary": {
					const component = new BranchSummaryMessageComponent(message, markdownTheme);
					component.setExpanded(this.expandedTools);
					this.content.addChild(component);
					break;
				}
			}
		}
	}

	private maxScroll(): number {
		return Math.max(0, this.lastBodyLines - this.lastBodyHeight);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.expandedTools = !this.expandedTools;
			this.rebuildContent();
		} else if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.hideThinking = !this.hideThinking;
			this.rebuildContent();
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(this.maxScroll(), this.scrollOffset + 1);
			this.followTail = this.scrollOffset >= this.maxScroll();
		} else if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.followTail = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - this.lastBodyHeight);
		} else if (this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.scrollOffset = Math.min(this.maxScroll(), this.scrollOffset + this.lastBodyHeight);
			this.followTail = this.scrollOffset >= this.maxScroll();
		} else if (data === "t") {
			this.followTail = false;
			this.scrollOffset = 0;
		} else if (data === "b") {
			this.followTail = true;
			this.scrollOffset = this.maxScroll();
		} else if (data === "r") {
			this.refresh();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const bodyHeight = Math.max(1, Math.floor(this.tui.terminal.rows * 0.84) - 7);
		const bodyLines = this.error
			? [this.theme.fg("error", this.error)]
			: this.content.render(innerWidth);
		this.lastBodyHeight = bodyHeight;
		this.lastBodyLines = bodyLines.length;
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		if (this.followTail) this.scrollOffset = maxScroll;
		else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visible = bodyLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
		const snapshot = this.snapshot;
		const agent = snapshot?.agent;
		const title = agent
			? `${statusIcon(agent.status)} ${agent.path}${agent.nickname ? ` (${agent.nickname})` : ""}`
			: "Sub-agent transcript";
		const metadata = agent
			? `${agent.status}${agent.status === "queued" ? ` #${agent.queuePosition ?? "?"} (waiting for execution slot)` : ""} · ${agent.model}${agent.role ? ` · ${agent.role}` : ""} · ${snapshot.messages.length} messages`
			: "unavailable";
		const scroll = bodyLines.length > bodyHeight
			? ` · lines ${this.scrollOffset + 1}-${Math.min(bodyLines.length, this.scrollOffset + bodyHeight)}/${bodyLines.length}`
			: "";
		const lines = [
			framedRule(this.theme, innerWidth, "╭", "╮"),
			framedRow(this.theme, ` ${this.theme.fg("accent", this.theme.bold(title))}`, innerWidth),
			framedRow(this.theme, ` ${this.theme.fg("dim", `${metadata}${scroll}`)}`, innerWidth),
			framedRule(this.theme, innerWidth, "├", "┤"),
		];
		for (const line of visible) lines.push(framedRow(this.theme, line, innerWidth));
		for (let index = visible.length; index < bodyHeight; index++) lines.push(framedRow(this.theme, "", innerWidth));
		lines.push(
			framedRule(this.theme, innerWidth, "├", "┤"),
			framedRow(
				this.theme,
				` ${this.theme.fg("dim", `↑/↓ move · ←/→ page · t top · b bottom · Ctrl+O tools ${this.expandedTools ? "on" : "off"} · Ctrl+T thinking ${this.hideThinking ? "hidden" : "shown"} · r refresh · Esc back`)}`,
				innerWidth,
			),
			framedRow(this.theme, ` ${this.theme.fg("dim", snapshot ? `Read-only · created ${formatTimestamp(snapshot.createdAt)}` : "Read-only")}`, innerWidth),
			framedRule(this.theme, innerWidth, "╰", "╯"),
		);
		return lines;
	}

	invalidate(): void {
		this.content.invalidate();
	}

	dispose(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.unsubscribe();
	}
}
