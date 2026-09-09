import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { STATE_ENTRY_TYPE } from "./types.ts";

const STORAGE_DIRECTORY_NAME = "pi-agents";
const LEGACY_STORAGE_DIRECTORY_NAME = "codex-agents";
const SETTINGS_FILE_NAME = "settings.json";
const LEGACY_SETTINGS_FILE_NAME = "agents-setting.json";

export interface StorageMigrationReport {
	movedEntries: number;
	warnings: string[];
}

export interface LegacyArchiveReport {
	archivedFiles: number;
	retainedFiles: number;
	scannedMainSessions: number;
	archiveDirectory?: string;
	error?: string;
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

/** Move the old package-owned directory without overwriting newer data. */
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
	// persisted path whenever it still exists rather than shadowing it with a
	// different destination file that happens to share its relative name.
	if (fs.existsSync(source)) return source;
	const translated = path.join(getAgentStorageDirectory(), path.relative(legacyRoot, source));
	return fs.existsSync(translated) ? translated : source;
}

function listMainSessionFiles(): string[] {
	const sessionsRoot = path.join(getAgentDir(), "sessions");
	if (!fs.existsSync(sessionsRoot)) return [];
	const files: string[] = [];
	for (const project of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!project.isDirectory() && !project.isSymbolicLink()) continue;
		const projectDirectory = path.join(sessionsRoot, project.name);
		try {
			for (const entry of fs.readdirSync(projectDirectory, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(projectDirectory, entry.name));
			}
		} catch {
			// A failed directory scan makes archival unsafe.
			throw new Error(`could not scan main session directory: ${projectDirectory}`);
		}
	}
	return files;
}

function sessionFileIds(file: string): string[] {
	const ids = new Set<string>();
	const basename = path.basename(file);
	const filenameMatch = basename.match(/_([0-9a-f-]{16,})\.jsonl$/i);
	if (filenameMatch?.[1]) ids.add(filenameMatch[1]);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(file, "r");
		const buffer = Buffer.allocUnsafe(4096);
		const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
		if (firstLine) {
			const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
			if (header.type === "session" && typeof header.id === "string") ids.add(header.id);
		}
	} catch {
		// The filename ID remains usable for conservative reference detection.
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
	return [...ids];
}

function legacyFlatFiles(): Array<{ file: string; ids: string[] }> {
	const roots = [getAgentStorageDirectory(), getLegacyAgentStorageDirectory()];
	const files: Array<{ file: string; ids: string[] }> = [];
	for (const root of roots) {
		for (const kind of ["sessions", "results"] as const) {
			const directory = path.join(root, kind);
			if (!fs.existsSync(directory)) continue;
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				if (kind === "sessions" && !entry.name.endsWith(".jsonl")) continue;
				if (kind === "results" && !entry.name.endsWith(".md")) continue;
				const file = path.join(directory, entry.name);
				const ids = kind === "sessions"
					? sessionFileIds(file)
					: [path.basename(file, path.extname(file))];
				files.push({ file, ids });
			}
		}
	}
	return files;
}

function uniqueArchiveTarget(directory: string, basename: string): string {
	let target = path.join(directory, basename);
	let suffix = 2;
	while (fs.existsSync(target)) {
		const extension = path.extname(basename);
		const stem = path.basename(basename, extension);
		target = path.join(directory, `${stem}-${suffix}${extension}`);
		suffix++;
	}
	return target;
}

/**
 * Archive legacy flat files only after scanning every ordinary Pi session for a
 * persisted agent-state reference. Any scan failure leaves all candidates in place.
 */
export async function archiveUnownedLegacyFiles(): Promise<LegacyArchiveReport> {
	let candidates: Array<{ file: string; ids: string[] }>;
	let mainSessions: string[];
	try {
		candidates = legacyFlatFiles();
		if (candidates.length === 0) return { archivedFiles: 0, retainedFiles: 0, scannedMainSessions: 0 };
		mainSessions = listMainSessionFiles();
	} catch (error) {
		return {
			archivedFiles: 0,
			retainedFiles: 0,
			scannedMainSessions: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const referencedIds = new Set<string>();
	const candidateIds = new Set(candidates.flatMap((candidate) => candidate.ids));
	let scannedMainSessions = 0;
	try {
		for (const sessionFile of mainSessions) {
			const lines = createInterface({ input: fs.createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
			for await (const line of lines) {
				if (!line.includes(STATE_ENTRY_TYPE)) continue;
				for (const id of candidateIds) {
					if (line.includes(id)) referencedIds.add(id);
				}
			}
			scannedMainSessions++;
		}
	} catch (error) {
		return {
			archivedFiles: 0,
			retainedFiles: candidates.length,
			scannedMainSessions,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// An unidentifiable file cannot be proven unowned and must remain untouched.
	const unowned = candidates.filter((candidate) => candidate.ids.length > 0 && !candidate.ids.some((id) => referencedIds.has(id)));
	if (unowned.length === 0) {
		return { archivedFiles: 0, retainedFiles: candidates.length, scannedMainSessions };
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const archiveDirectory = path.join(getAgentStorageDirectory(), "archive", "legacy-unowned", stamp);
	let archivedFiles = 0;
	try {
		for (const candidate of unowned) {
			const kind = candidate.file.endsWith(".jsonl") ? "sessions" : "results";
			const destinationDirectory = path.join(archiveDirectory, kind);
			fs.mkdirSync(destinationDirectory, { recursive: true });
			fs.renameSync(candidate.file, uniqueArchiveTarget(destinationDirectory, path.basename(candidate.file)));
			archivedFiles++;
		}
	} catch (error) {
		return {
			archivedFiles,
			retainedFiles: candidates.length - archivedFiles,
			scannedMainSessions,
			archiveDirectory,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		archivedFiles,
		retainedFiles: candidates.length - archivedFiles,
		scannedMainSessions,
		archiveDirectory,
	};
}
