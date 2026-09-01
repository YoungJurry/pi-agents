import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;
export const DEFAULT_MAX_RESIDENT_SUBAGENTS = 3;
export const DEFAULT_CHILD_THINKING_LEVEL: ThinkingLevel = "medium";
export const CHILD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface AgentSettings {
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	maxConcurrentSubagents?: number;
	maxResidentSubagents?: number;
}

export interface AgentLimits {
	maxConcurrentSubagents: number;
	maxResidentSubagents: number;
}

export function getAgentSettingsPath(): string {
	return path.join(getAgentDir(), "codex-agents", "agents-setting.json");
}

export function selectAgentModel(...candidates: Array<string | undefined>): string | undefined {
	for (const candidate of candidates) {
		const model = candidate?.trim();
		if (model) return model;
	}
	return undefined;
}

export function selectAgentThinkingLevel(
	model: Model<any>,
	explicitModel: string | undefined,
	explicitThinking: ThinkingLevel | undefined,
	roleThinking: ThinkingLevel | undefined,
	globalThinking: ThinkingLevel | undefined,
): ThinkingLevel {
	if (explicitThinking !== undefined) return clampThinkingLevel(model, explicitThinking) as ThinkingLevel;
	if (explicitModel?.trim()) {
		const levels = getSupportedThinkingLevels(model);
		return (levels.at(-1) ?? "off") as ThinkingLevel;
	}
	return clampThinkingLevel(model, roleThinking ?? globalThinking ?? DEFAULT_CHILD_THINKING_LEVEL) as ThinkingLevel;
}

export function loadAgentSettings(filePath = getAgentSettingsPath()): AgentSettings {
	if (!fs.existsSync(filePath)) return {};

	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to read agent settings at ${filePath}: ${message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`agent settings at ${filePath} must contain a JSON object`);
	}

	const raw = value as Record<string, unknown>;
	const settings: AgentSettings = {};
	if (raw.defaultModel !== undefined) {
		if (typeof raw.defaultModel !== "string" || !raw.defaultModel.trim()) {
			throw new Error(`defaultModel in ${filePath} must be a non-empty provider/model string`);
		}
		settings.defaultModel = raw.defaultModel.trim();
	}
	if (raw.defaultThinkingLevel !== undefined) {
		if (typeof raw.defaultThinkingLevel !== "string" || !CHILD_THINKING_LEVELS.includes(raw.defaultThinkingLevel as ThinkingLevel)) {
			throw new Error(`defaultThinkingLevel in ${filePath} must be one of: ${CHILD_THINKING_LEVELS.join(", ")}`);
		}
		settings.defaultThinkingLevel = raw.defaultThinkingLevel as ThinkingLevel;
	}
	for (const key of ["maxConcurrentSubagents", "maxResidentSubagents"] as const) {
		const limit = raw[key];
		if (limit === undefined) continue;
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
			throw new Error(`${key} in ${filePath} must be a positive integer`);
		}
		settings[key] = limit;
	}
	return settings;
}

export function resolveAgentLimits(settings: AgentSettings, filePath = getAgentSettingsPath()): AgentLimits {
	const maxConcurrentSubagents = settings.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
	const maxResidentSubagents = settings.maxResidentSubagents
		?? Math.max(DEFAULT_MAX_RESIDENT_SUBAGENTS, maxConcurrentSubagents);
	if (maxResidentSubagents < maxConcurrentSubagents) {
		throw new Error(`maxResidentSubagents in ${filePath} must be greater than or equal to maxConcurrentSubagents`);
	}
	return { maxConcurrentSubagents, maxResidentSubagents };
}
