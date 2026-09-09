import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STORAGE_DIRECTORY_NAME = "pi-agents";
const LEGACY_STORAGE_DIRECTORY_NAME = "codex-agents";
const SETTINGS_FILE_NAME = "settings.json";
const LEGACY_SETTINGS_FILE_NAME = "agents-setting.json";

export interface StorageMigrationReport {
	movedEntries: number;
	warnings: string[];
}

export function getAgentStorageDirectory(): string {
	return path.join(getAgentDir(), STORAGE_DIRECTORY_NAME);
}

export function getLegacyAgentStorageDirectory(): string {
	return path.join(getAgentDir(), LEGACY_STORAGE_DIRECTORY_NAME);
}

export function getAgentSettingsPath(): string {
	return path.join(getAgentStorageDirectory(), SETTINGS_FILE_NAME);
}

export function getLegacyAgentSettingsPaths(): string[] {
	return [
		path.join(getAgentStorageDirectory(), LEGACY_SETTINGS_FILE_NAME),
		path.join(getLegacyAgentStorageDirectory(), LEGACY_SETTINGS_FILE_NAME),
	];
}

function mergeWithoutOverwrite(source: string, destination: string, report: StorageMigrationReport): void {
	if (!fs.existsSync(source)) return;
	if (!fs.existsSync(destination)) {
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.renameSync(source, destination);
		report.movedEntries++;
		return;
	}
	const sourceStat = fs.statSync(source);
	const destinationStat = fs.statSync(destination);
	if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) {
		report.warnings.push(`storage migration left a conflicting path untouched: ${source}`);
		return;
	}
	for (const entry of fs.readdirSync(source)) {
		mergeWithoutOverwrite(path.join(source, entry), path.join(destination, entry), report);
	}
	try {
		if (fs.readdirSync(source).length === 0) fs.rmdirSync(source);
	} catch {
		// A partial migration remains readable through the legacy path fallback.
	}
}

/**
 * Preserve the 0.7.x upgrade path. For a fresh installation this is only an
 * existence check and performs no writes.
 */
export function migrateLegacyAgentStorage(): StorageMigrationReport {
	const report: StorageMigrationReport = { movedEntries: 0, warnings: [] };
	const source = getLegacyAgentStorageDirectory();
	const destination = getAgentStorageDirectory();
	try {
		mergeWithoutOverwrite(source, destination, report);
		const legacySettings = path.join(destination, LEGACY_SETTINGS_FILE_NAME);
		const settings = getAgentSettingsPath();
		if (fs.existsSync(legacySettings)) mergeWithoutOverwrite(legacySettings, settings, report);
	} catch (error) {
		report.warnings.push(error instanceof Error ? error.message : String(error));
	}
	return report;
}

/** Translate paths persisted before the storage directory rename. */
export function resolveMigratedStoragePath(file: string): string {
	const source = path.resolve(file);
	const legacyRoot = path.resolve(getLegacyAgentStorageDirectory());
	if (source !== legacyRoot && !source.startsWith(`${legacyRoot}${path.sep}`)) return source;
	// A collision-safe merge leaves the legacy source in place. Prefer the exact
	// persisted path instead of shadowing it with a different destination file.
	if (fs.existsSync(source)) return source;
	const translated = path.join(getAgentStorageDirectory(), path.relative(legacyRoot, source));
	return fs.existsSync(translated) ? translated : source;
}
