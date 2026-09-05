import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "./types.ts";

const BUILTIN_ROLES: AgentRole[] = [
	{
		name: "default",
		description: "General-purpose coding agent",
		systemPrompt: "",
		source: "builtin",
	},
	{
		name: "explorer",
		description: "Read-only codebase exploration and focused research",
		systemPrompt: "Explore the codebase efficiently. Do not modify files. Return concise findings with exact paths and relevant implementation details.",
		tools: ["read", "bash", "grep", "find", "ls"],
		source: "builtin",
	},
	{
		name: "awaiter",
		description: "Wait for long-running commands or tasks and report completion",
		systemPrompt: "Wait conservatively for the assigned command or task to reach a terminal state. Do not modify or optimize it. Use long waits, do not hallucinate completion, and report the final status only when known.",
		thinkingLevel: "low",
		source: "builtin",
	},
];

type RoleFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	skills?: unknown;
	model?: unknown;
	thinking?: unknown;
	nickname_candidates?: unknown;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stringList(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const result = values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
	return result.length > 0 ? result : undefined;
}

function loadDirectory(directory: string, source: "user" | "project"): AgentRole[] {
	if (!fs.existsSync(directory)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const roles: AgentRole[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		try {
			const content = fs.readFileSync(path.join(directory, entry.name), "utf8");
			const { frontmatter, body } = parseFrontmatter<RoleFrontmatter>(content);
			if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
			const thinking = typeof frontmatter.thinking === "string" && THINKING_LEVELS.has(frontmatter.thinking as ThinkingLevel)
				? frontmatter.thinking as ThinkingLevel
				: undefined;
			roles.push({
				name: frontmatter.name.trim(),
				description: frontmatter.description.trim(),
				systemPrompt: body.trim(),
				tools: stringList(frontmatter.tools),
				skills: stringList(frontmatter.skills),
				model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,
				thinkingLevel: thinking,
				nicknameCandidates: stringList(frontmatter.nickname_candidates),
				source,
			});
		} catch {
			// A malformed role must not prevent other roles from loading.
		}
	}
	return roles;
}

function nearestProjectRoles(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Continue walking.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function discoverRoles(cwd: string, projectTrusted: boolean): AgentRole[] {
	const roles = new Map<string, AgentRole>();
	for (const role of BUILTIN_ROLES) roles.set(role.name, role);
	for (const role of loadDirectory(path.join(getAgentDir(), "agents"), "user")) roles.set(role.name, role);
	const projectDirectory = nearestProjectRoles(cwd);
	if (projectTrusted && projectDirectory) {
		for (const role of loadDirectory(projectDirectory, "project")) roles.set(role.name, role);
	}
	return [...roles.values()];
}

export function resolveRole(cwd: string, projectTrusted: boolean, name?: string): AgentRole {
	const roleName = name?.trim() || "default";
	const role = discoverRoles(cwd, projectTrusted).find((candidate) => candidate.name === roleName);
	if (!role) {
		const names = discoverRoles(cwd, projectTrusted).map((candidate) => candidate.name).join(", ");
		throw new Error(`unknown agent_type '${roleName}'. Available roles: ${names}`);
	}
	return role;
}

export function formatAssignedSkills(requestedNames: readonly string[] | undefined, discoveredSkills: readonly Skill[]): string {
	if (!requestedNames?.length) return "";
	const skillsByName = new Map(discoveredSkills.map((skill) => [skill.name, skill]));
	const missing = requestedNames.filter((name) => !skillsByName.has(name));
	if (missing.length > 0) {
		const available = [...skillsByName.keys()].sort().join(", ") || "none";
		throw new Error(`Role references unknown skill(s): ${missing.join(", ")}. Available skills: ${available}`);
	}
	const sections = requestedNames.map((name) => {
		const skill = skillsByName.get(name)!;
		const instructions = fs.readFileSync(skill.filePath, "utf8").trim();
		return `<skill>\nName: ${skill.name}\nLocation: ${skill.filePath}\nBase directory: ${skill.baseDir}\n\n${instructions}\n</skill>`;
	});
	return `<agent_skills>\nThe following Role-selected skills are fully loaded. Follow them when completing the task. Resolve relative paths against each skill's base directory.\n\n${sections.join("\n\n")}\n</agent_skills>`;
}
