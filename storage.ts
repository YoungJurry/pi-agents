import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STORAGE_DIRECTORY_NAME = "pi-agents";
const SETTINGS_FILE_NAME = "settings.json";

export function getAgentStorageDirectory(): string {
	return path.join(getAgentDir(), STORAGE_DIRECTORY_NAME);
}

export function getAgentSettingsPath(): string {
	return path.join(getAgentStorageDirectory(), SETTINGS_FILE_NAME);
}
