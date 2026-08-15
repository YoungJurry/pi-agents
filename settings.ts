import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AgentSettings {
	defaultModel?: string;
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

	const defaultModel = (value as { defaultModel?: unknown }).defaultModel;
	if (defaultModel === undefined) return {};
	if (typeof defaultModel !== "string" || !defaultModel.trim()) {
		throw new Error(`defaultModel in ${filePath} must be a non-empty provider/model string`);
	}
	return { defaultModel: defaultModel.trim() };
}
