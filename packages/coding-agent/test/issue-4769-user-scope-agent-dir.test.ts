import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@gajae-code/coding-agent/capability";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { type Rule, ruleCapability } from "@gajae-code/coding-agent/capability/rule";
import { type Skill, skillCapability } from "@gajae-code/coding-agent/capability/skill";
import { type SystemPrompt, systemPromptCapability } from "@gajae-code/coding-agent/capability/system-prompt";
import type { LoadContext } from "@gajae-code/coding-agent/capability/types";
import { runMigrate } from "@gajae-code/coding-agent/cli/migrate-cli";
import {
	discoverRuntimeSkills,
	findRuntimeSkillByName,
} from "@gajae-code/coding-agent/extensibility/runtime-skill-discovery";
import {
	listNativeSkillsForManagement,
	writeNativeSkill,
} from "@gajae-code/coding-agent/extensibility/skill-management";
import { loadSkills } from "@gajae-code/coding-agent/extensibility/skills";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
// Register all discovery providers as a side effect.
import "@gajae-code/coding-agent/discovery";

let tempDir: string;
let home: string;
let project: string;
let profile: string;
let originalAgentDir: string;

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

async function makeSkill(root: string, name: string, description = `${name} body`): Promise<string> {
	const filePath = path.join(root, name, "SKILL.md");
	await writeFile(
		filePath,
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
	);
	return filePath;
}

function nativeProvider(capabilityId: string) {
	const capability = getCapability(capabilityId);
	if (!capability) throw new Error(`capability ${capabilityId} missing`);
	const provider = capability.providers.find(p => p.id === "native");
	if (!provider) throw new Error(`native provider for ${capabilityId} not registered`);
	return provider.load as (ctx: LoadContext) => Promise<{ items: unknown[] }>;
}

beforeEach(async () => {
	clearCache();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4769-user-scope-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	profile = path.join(tempDir, "profile-agent-dir");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(profile, { recursive: true });
	await fs.mkdir(path.join(project, ".git"), { recursive: true });
	originalAgentDir = getAgentDir();
});

afterEach(async () => {
	clearCache();
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe("issue #4769: user scope follows the agent directory", () => {
	test("user SYSTEM.md is read from the agent directory, not the home-relative default", async () => {
		await writeFile(path.join(profile, "SYSTEM.md"), "# profile system prompt");
		// Decoy in the home-relative default location: must stay unread.
		await writeFile(path.join(home, ".gjc", "agent", "SYSTEM.md"), "# default-profile decoy");

		const load = nativeProvider(systemPromptCapability.id) as (
			ctx: LoadContext,
		) => Promise<{ items: SystemPrompt[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });

		expect(items.map(item => item.content)).toEqual(["# profile system prompt"]);
		expect(items[0]?.path).toBe(path.join(profile, "SYSTEM.md"));
	});

	test("user RULES.md is read from the agent directory, not the home-relative default", async () => {
		await writeFile(path.join(profile, "RULES.md"), "profile rules body");
		await writeFile(path.join(home, ".gjc", "agent", "RULES.md"), "default-profile decoy");

		const load = nativeProvider(ruleCapability.id) as (ctx: LoadContext) => Promise<{ items: Rule[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });
		const sticky = items.find(rule => rule.name === "RULES");

		expect(sticky?.path).toBe(path.join(profile, "RULES.md"));
		expect(items.every(rule => rule.path !== path.join(home, ".gjc", "agent", "RULES.md"))).toBe(true);
	});

	test("discovery scans only the profile's skills; the default profile's skills do not leak in", async () => {
		await makeSkill(path.join(profile, "skills"), "profile-skill");
		await makeSkill(path.join(home, ".gjc", "agent", "skills"), "default-profile-skill");

		const load = nativeProvider(skillCapability.id) as (ctx: LoadContext) => Promise<{ items: Skill[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });

		expect(items.map(skill => skill.name)).toEqual(["profile-skill"]);
	});

	test("a hostile mocked HOME cannot inject user skills under a profile", async () => {
		const hostileHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4769-hostile-home-"));
		vi.spyOn(os, "homedir").mockReturnValue(hostileHome);
		await makeSkill(path.join(hostileHome, ".gjc", "agent", "skills"), "hostile-skill");
		await makeSkill(path.join(hostileHome, ".gjc", "skills"), "hostile-legacy-skill");

		const load = nativeProvider(skillCapability.id) as (ctx: LoadContext) => Promise<{ items: Skill[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: profile });

		expect(items.map(skill => skill.name)).toEqual([]);
	});

	test("default profile keeps scanning the home-relative legacy roots", async () => {
		const defaultAgentDir = path.join(home, ".gjc", "agent");
		await makeSkill(path.join(defaultAgentDir, "skills"), "canonical-skill");
		await makeSkill(path.join(home, ".gjc", "skills"), "legacy-skill");

		const load = nativeProvider(skillCapability.id) as (ctx: LoadContext) => Promise<{ items: Skill[] }>;
		const { items } = await load({ cwd: project, home, repoRoot: project, userAgentDir: defaultAgentDir });

		expect(items.map(skill => skill.name).sort()).toEqual(["canonical-skill", "legacy-skill"]);
	});
});

describe("issue #4769: every writer is discovered by every reader", () => {
	test("writeNativeSkill(user) targets the agent dir and is listed, discovered, and loaded", async () => {
		const receipt = await writeNativeSkill({
			cwd: project,
			scope: "user",
			name: "writer-skill",
			content: ["---", "name: writer-skill", "description: written by gjc skill", "---", "", "# writer"].join("\n"),
			agentDir: profile,
		});
		expect(receipt.path).toBe(path.join(profile, "skills", "writer-skill", "SKILL.md"));

		// skill-management reader
		const records = await listNativeSkillsForManagement({ cwd: project, home, agentDir: profile });
		const record = records.find(r => r.name === "writer-skill");
		expect(record).toMatchObject({ scope: "user", enabled: true, path: receipt.path });

		// runtime skill discovery reader
		const discovered = await discoverRuntimeSkills({
			cwd: project,
			home,
			agentDir: profile,
			policy: { enabled: true, trustUserSkills: true },
		});
		expect(discovered.candidates.map(c => c.name)).toContain("writer-skill");

		const byName = await findRuntimeSkillByName(project, "writer-skill", { enabled: true }, home, profile);
		expect(byName?.filePath).toBe(receipt.path);

		// capability/session reader
		setAgentDir(profile);
		const { skills } = await loadSkills({ cwd: project });
		expect(skills.map(skill => skill.name)).toContain("writer-skill");
	});

	test("gjc migrate writes user skills into the agent dir and discovery finds them", async () => {
		const sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4769-migrate-home-"));
		await makeSkill(path.join(sourceHome, ".claude", "skills"), "migrated-skill");

		setAgentDir(profile);
		const report = await runMigrate({
			from: ["claude-code"],
			force: false,
			dryRun: false,
			homeDir: sourceHome,
			project: false,
			json: false,
			cwd: project,
		});
		expect(report.actions.length).toBeGreaterThan(0);

		const migratedPath = path.join(profile, "skills", "migrated-skill", "SKILL.md");
		expect(await fs.readFile(migratedPath, "utf8")).toContain("migrated-skill");

		const { skills } = await loadSkills({ cwd: project });
		expect(skills.map(skill => skill.name)).toContain("migrated-skill");
		await fs.rm(sourceHome, { recursive: true, force: true });
	});
});
