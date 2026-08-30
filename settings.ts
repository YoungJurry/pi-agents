import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;
export const DEFAULT_MAX_RESIDENT_SUBAGENTS = 3;

export interface AgentSettings {
	defaultModel?: string;
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
