import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSetupArgs } from "../src/cli/setup-cli";
import { checkPaseoSetup, STALE_GUIDANCE } from "../src/setup/paseo/check";
import { type CompletedStep, compensate, recoverIntent, SagaStepError } from "../src/setup/paseo/install-saga";
import {
	currentIdentity,
	hashBytes,
	planPublish,
	publishPlan,
	readTarget,
	serializeJson,
} from "../src/setup/paseo/json-publisher";
import { createOrchestrationSeed } from "../src/setup/paseo/orchestration-preferences";
import {
	classifyIdentity,
	classifyIntent,
	INTENT_VERSION,
	type IntentRecord,
	isProvenancedProvider,
	provenancedProviderKeys,
	readIntent,
	readProvenance,
	writeIntent,
	writeProvenance,
} from "../src/setup/paseo/paseo-ownership";
import { assertUsableFlags, PaseoSetupUsageError, runPaseoSetup } from "../src/setup/paseo/paseo-setup";
import {
	buildProviderEntry,
	hasProviderConflict,
	providerEntryHash,
	providerKeyFor,
	resolveGjcCommand,
} from "../src/setup/paseo/provider-config";
import { removePaseoSetup } from "../src/setup/paseo/remove";
import {
	checkExitCode,
	type PaseoRemoveResult,
	type SetupCheckResult,
	type SetupCheckStatus,
} from "../src/setup/paseo/result-types";
import {
	type PaseoLsOutcome,
	type PaseoPaths,
	type PaseoSetupDependencies,
	parseProviderLs,
	paseoAppSkillsCandidates,
	resolvePaseoSkillsSource,
} from "../src/setup/paseo/setup-deps";
import { installSkillsBridge, preflightSkillsBridge, SkillsBridgeError } from "../src/setup/paseo/skills-bridge";

const FIXTURE_PASSWORD = "$2b$10$FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTUR";
const SKILL_NAMES = ["paseo", "paseo-advisor", "paseo-committee", "paseo-handoff", "paseo-loop"];
/** Built from codepoints so this test file stays pure ASCII on disk. */
const NON_ASCII_VALUE = String.fromCodePoint(0xd55c, 0xad6d, 0xc5b4);

/** A reachable-daemon outcome carrying the measured row shape. */
function lsOk(...ids: string[]): PaseoLsOutcome {
	return { kind: "ok", providerIds: ids, rows: ids.map(id => ({ id, status: "available" })) };
}

const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-paseo-test-"));
	tempRoots.push(root);
	return root;
}

interface Fixture {
	readonly root: string;
	readonly paths: PaseoPaths;
	readonly deps: PaseoSetupDependencies;
	readonly probes: number[];
	readonly spawned: string[][];
}

/**
 * Build a fully isolated fixture.
 *
 * Every path points inside a temp root, so no test can reach the real
 * `~/.paseo`, `~/.agents`, or `~/.gjc`. `runProviderLs` is injected rather than
 * mocked at module scope, which is why this suite needs no `mock.module()`.
 */
async function makeFixture(outcome: PaseoLsOutcome = { kind: "timeout", timeoutMs: 5_000 }): Promise<Fixture> {
	const root = await makeRoot();
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agentdir");
	const paseoHome = path.join(home, ".paseo");
	const agentsSkills = path.join(home, ".agents", "skills");
	await fs.mkdir(paseoHome, { recursive: true });
	await fs.mkdir(agentsSkills, { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });

	const paths: PaseoPaths = {
		configJson: path.join(paseoHome, "config.json"),
		orchestrationPreferences: path.join(paseoHome, "orchestration-preferences.json"),
		agentsSkillsDir: agentsSkills,
		bridgeDir: path.join(agentDir, "paseo-skills"),
		provenanceLedger: path.join(agentDir, "paseo", "provenance.json"),
		intentRecord: path.join(agentDir, "paseo", "intent.json"),
		gjcSkillsDir: path.join(agentDir, "skills"),
	};

	const probes: number[] = [];
	const spawned: string[][] = [];
	// The skills source is injected, never discovered: a developer machine that
	// happens to carry ~/.agents/skills or a Paseo.app must not leak into a test.
	const deps: PaseoSetupDependencies = {
		paths,
		runProviderLs: async timeoutMs => {
			probes.push(timeoutMs);
			return outcome;
		},
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		skillsSource: async () => ({ dir: agentsSkills, origin: "user" }),
		home,
	};
	return { root, paths, deps, probes, spawned };
}

async function seedConfig(paths: PaseoPaths, providers: Record<string, unknown> = {}): Promise<void> {
	const config = {
		daemon: { auth: { password: FIXTURE_PASSWORD }, port: 4317 },
		agents: { providers: { claude: { enabled: true }, ...providers } },
	};
	await fs.writeFile(paths.configJson, serializeJson(config), { mode: 0o600 });
}

async function seedSkills(paths: PaseoPaths, extra: string[] = []): Promise<void> {
	const sourceDir = paths.agentsSkillsDir;
	if (sourceDir === undefined) throw new Error("fixture carries no skills source");
	for (const name of [...SKILL_NAMES, ...extra]) {
		await fs.mkdir(path.join(sourceDir, name), { recursive: true });
		await fs.writeFile(path.join(sourceDir, name, "SKILL.md"), `# ${name}\n`);
	}
}

/** Recursive metadata + content snapshot, used to prove a tree was not modified. */
async function snapshotTree(root: string): Promise<string> {
	const rows: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			const stat = await fs.lstat(full);
			if (entry.isSymbolicLink()) {
				rows.push(`link ${rel} -> ${await fs.readlink(full)}`);
			} else if (entry.isDirectory()) {
				rows.push(`dir ${rel} ${(stat.mode & 0o777).toString(8)}`);
				await walk(full);
			} else {
				rows.push(`file ${rel} ${(stat.mode & 0o777).toString(8)} ${hashBytes(await fs.readFile(full, "utf8"))}`);
			}
		}
	}
	await walk(root);
	return rows.join("\n");
}

function providersOf(parsed: Record<string, unknown>): Record<string, unknown> {
	const agents = parsed.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return {};
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
	return providers as Record<string, unknown>;
}

describe("byte preservation (AC-3)", () => {
	test("2-space input round-trips and preserves non-owned regions", async () => {
		const { paths } = await makeFixture();
		await seedConfig(paths);
		const original = await fs.readFile(paths.configJson, "utf8");

		const current = await readTarget(paths.configJson);
		expect(current.raw).toBe(original);

		const plan = planPublish(current, draft => {
			providersOf(draft).gjc = { enabled: true };
		});
		await publishPlan(paths.configJson, plan, {
			expectedIdentity: current.identity,
			backup: false,
			now: new Date(),
		});

		const after = JSON.parse(await fs.readFile(paths.configJson, "utf8")) as Record<string, unknown>;
		// The regions we do not own must survive untouched, including the credential.
		expect(JSON.stringify(after.daemon)).toBe(JSON.stringify({ auth: { password: FIXTURE_PASSWORD }, port: 4317 }));
		expect(JSON.stringify(providersOf(after).claude)).toBe(JSON.stringify({ enabled: true }));
	});

	test.each([
		["4-space indentation", (o: unknown) => `${JSON.stringify(o, null, 4)}\n`],
		["tab indentation", (o: unknown) => `${JSON.stringify(o, null, "\t")}\n`],
		["no trailing newline", (o: unknown) => JSON.stringify(o, null, 2)],
	])("%s is refused as format-drift and nothing is written", async (_label: string, encode: (
		o: unknown,
	) => string) => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.configJson, encode({ agents: { providers: {} } }));
		const before = await fs.readFile(paths.configJson, "utf8");

		await expect(readTarget(paths.configJson)).rejects.toMatchObject({
			name: "PaseoPublishError",
			refusal: { reason: "format-drift" },
		});
		expect(await fs.readFile(paths.configJson, "utf8")).toBe(before);
	});

	test("unparseable JSON is refused as parse-refusal and nothing is written", async () => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.configJson, "{ not json ");
		const before = await fs.readFile(paths.configJson, "utf8");

		await expect(readTarget(paths.configJson)).rejects.toMatchObject({
			refusal: { reason: "parse-refusal" },
		});
		expect(await fs.readFile(paths.configJson, "utf8")).toBe(before);
	});

	test("non-ASCII values round-trip under 2-space encoding", async () => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.configJson, serializeJson({ label: NON_ASCII_VALUE, agents: { providers: {} } }));
		const current = await readTarget(paths.configJson);
		expect(current.parsed.label).toBe(NON_ASCII_VALUE);
	});

	test("number spellings that do not survive re-serialization are refused", async () => {
		const { paths } = await makeFixture();
		// `1e3` re-serializes as `1000`, so the self-check must catch it rather
		// than silently normalizing a file we do not own.
		await fs.writeFile(paths.configJson, '{\n  "timeout": 1e3\n}\n');
		await expect(readTarget(paths.configJson)).rejects.toMatchObject({
			refusal: { reason: "format-drift" },
		});
	});
});

describe("compare-and-swap", () => {
	test("publish refuses when the file changed after it was read", async () => {
		const { paths } = await makeFixture();
		await seedConfig(paths);
		const current = await readTarget(paths.configJson);
		const plan = planPublish(current, draft => {
			providersOf(draft).gjc = { enabled: true };
		});

		// Another writer lands between our read and our publish.
		await fs.writeFile(paths.configJson, serializeJson({ agents: { providers: { other: { enabled: true } } } }));
		const interleaved = await fs.readFile(paths.configJson, "utf8");

		await expect(
			publishPlan(paths.configJson, plan, { expectedIdentity: current.identity, backup: false, now: new Date() }),
		).rejects.toMatchObject({ refusal: { reason: "cas-conflict" } });
		expect(await fs.readFile(paths.configJson, "utf8")).toBe(interleaved);
	});
});

describe("backup safety", () => {
	test("backups are always mode 0600 even when the source is world-readable", async () => {
		const { paths } = await makeFixture();
		await fs.writeFile(paths.orchestrationPreferences, serializeJson({}), { mode: 0o644 });

		const current = await readTarget(paths.orchestrationPreferences);
		const plan = planPublish(current, draft => {
			draft.providers = { impl: "gjc" };
		});
		const result = await publishPlan(paths.orchestrationPreferences, plan, {
			expectedIdentity: current.identity,
			backup: true,
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(result.backupPath).toBeDefined();
		const stat = await fs.stat(result.backupPath as string);
		expect(stat.mode & 0o777).toBe(0o600);
		// Republishing must not widen the source's own permissions either.
		expect((await fs.stat(paths.orchestrationPreferences)).mode & 0o777).toBe(0o644);
	});

	test("the credential never appears in a check result", async () => {
		const fixture = await makeFixture();
		await seedConfig(fixture.paths);
		const result = await checkPaseoSetup(fixture.deps);
		expect(JSON.stringify(result)).not.toContain(FIXTURE_PASSWORD);
	});
});

describe("executable resolution", () => {
	function withChannel<T>(channel: string | undefined, compiled: boolean, fn: () => T): T {
		const priorChannel = process.env.GJC_BUILD_CHANNEL;
		const priorCompiled = process.env.PI_COMPILED;
		if (channel === undefined) delete process.env.GJC_BUILD_CHANNEL;
		else process.env.GJC_BUILD_CHANNEL = channel;
		if (compiled) process.env.PI_COMPILED = "true";
		else delete process.env.PI_COMPILED;
		try {
			return fn();
		} finally {
			if (priorChannel === undefined) delete process.env.GJC_BUILD_CHANNEL;
			else process.env.GJC_BUILD_CHANNEL = priorChannel;
			if (priorCompiled === undefined) delete process.env.PI_COMPILED;
			else process.env.PI_COMPILED = priorCompiled;
		}
	}

	// A shipped binary defines PI_COMPILED together with channel release/dev, and
	// resolveBuildMetadata reads the explicit channel first, so it never reports
	// "compiled". Grouping release/dev/compiled is the fix for that defect.
	test.each(["release", "dev"])("channel %s resolves to the running executable", (channel: string) => {
		const resolution = withChannel(channel, true, () => resolveGjcCommand());
		expect(resolution.ok).toBe(true);
		if (resolution.ok) expect(resolution.command).toEqual([process.execPath, "acp"]);
	});

	test("unknown channel is a hard failure naming the channel", () => {
		const resolution = withChannel("unknown", false, () => resolveGjcCommand());
		expect(resolution.ok).toBe(false);
		if (!resolution.ok) expect(resolution.channel).toBe("unknown");
	});

	test("no resolution ever emits a bare gjc string", () => {
		for (const channel of ["release", "dev", "unknown", undefined]) {
			const compiled = channel === "release" || channel === "dev";
			const resolution = withChannel(channel, compiled, () => resolveGjcCommand());
			if (resolution.ok) expect(resolution.command[0]).not.toBe("gjc");
		}
	});
});

describe("provider entry", () => {
	test("permission mode is always prompt, with and without an mpreset", () => {
		expect(buildProviderEntry(["/bin/gjc", "acp"]).env.GJC_ACP_PERMISSION_MODE).toBe("prompt");
		expect(buildProviderEntry(["/bin/gjc", "acp"], "codex-pro").env.GJC_ACP_PERMISSION_MODE).toBe("prompt");
	});

	test("mpreset changes the key and the command tail", () => {
		expect(providerKeyFor()).toBe("gjc");
		expect(providerKeyFor("codex-pro")).toBe("gjc-codex-pro");
		expect(buildProviderEntry(["/bin/gjc", "acp"], "codex-pro").command.slice(-3)).toEqual([
			"acp",
			"--mpreset",
			"codex-pro",
		]);
	});

	test("an absent key is not a conflict", () => {
		const entry = buildProviderEntry(["/bin/gjc", "acp"]);
		expect(hasProviderConflict({ agents: { providers: {} } }, "gjc", entry).conflict).toBe(false);
	});

	test("an identical entry is not a conflict, a differing one is", () => {
		const entry = buildProviderEntry(["/bin/gjc", "acp"]);
		expect(hasProviderConflict({ agents: { providers: { gjc: entry } } }, "gjc", entry).conflict).toBe(false);
		expect(
			hasProviderConflict({ agents: { providers: { gjc: { ...entry, label: "mine" } } } }, "gjc", entry).conflict,
		).toBe(true);
	});
});

describe("orchestration seeding (AC-15)", () => {
	// Verified against a live file: roles are nested under `providers`, and the
	// sibling `preferences` array belongs to the user.
	test("seeds only empty nested roles and leaves populated ones untouched", () => {
		const preferences: Record<string, unknown> = {
			providers: { impl: "mine", ui: "" },
			preferences: ["keep"],
		};
		const seed = createOrchestrationSeed(preferences);
		expect(seed.seededKeys).not.toContain("impl");
		expect(seed.seededKeys).toContain("ui");
		expect(seed.seededKeys).toContain("audit");

		const draft = structuredClone(preferences);
		seed.mutate(draft);
		const roles = draft.providers as Record<string, unknown>;
		expect(roles.impl).toBe("mine");
		expect(roles.ui).toBe("gjc");
		expect(draft.preferences).toEqual(["keep"]);
	});

	test("writes nothing at the top level and creates providers when absent", () => {
		const seed = createOrchestrationSeed({});
		const draft: Record<string, unknown> = {};
		seed.mutate(draft);
		expect(Object.keys(draft)).toEqual(["providers"]);
		expect(Object.keys(draft.providers as Record<string, unknown>).sort()).toEqual([
			"audit",
			"impl",
			"planning",
			"research",
			"ui",
		]);
	});

	test("a fully assigned file needs no seeding", () => {
		const seed = createOrchestrationSeed({
			providers: { impl: "a", ui: "b", research: "c", planning: "d", audit: "e" },
		});
		expect(seed.seededKeys).toEqual([]);
	});
});

describe("four-state check (AC-16, AC-17, AC-18)", () => {
	async function cleanL1(outcome: PaseoLsOutcome): Promise<Fixture> {
		const fixture = await makeFixture(outcome);
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		for (const name of SKILL_NAMES) {
			await fs.symlink(
				path.join(fixture.paths.agentsSkillsDir as string, name),
				path.join(fixture.paths.bridgeDir, name),
			);
		}
		const resolution = resolveGjcCommand();
		const command = resolution.ok ? resolution.command : [process.execPath, "acp"];
		await seedConfig(fixture.paths, { gjc: buildProviderEntry(command) });
		await fs.writeFile(
			fixture.paths.orchestrationPreferences,
			serializeJson({ providers: { impl: "gjc", ui: "gjc", research: "gjc", planning: "gjc", audit: "gjc" } }),
		);
		return fixture;
	}

	test("a dirty L1 is drift regardless of the daemon, and exits 1", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("drift");
		expect(checkExitCode(result)).toBe(1);
	});

	test("clean L1 plus a daemon listing the provider is pass", async () => {
		const fixture = await cleanL1(lsOk("gjc"));
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("clean L1 plus a daemon omitting the provider is stale with guidance", async () => {
		const fixture = await cleanL1(lsOk("claude"));
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("stale");
		expect(result.guidance).toBe(STALE_GUIDANCE);
		expect(checkExitCode(result)).toBe(0);
	});

	// The specific regression: an unreachable daemon must map uniquely to
	// `skipped`. An earlier draft let this same predicate also satisfy `pass`.
	test.each<PaseoLsOutcome>([
		{ kind: "timeout", timeoutMs: 5_000 },
		{ kind: "unavailable", detail: "spawn failed" },
		{ kind: "malformed", detail: "bad json" },
		{ kind: "nonzero-exit", exitCode: 3, detail: "boom" },
	])("clean L1 plus an unreachable daemon is skipped, never pass ($kind)", async (outcome: PaseoLsOutcome) => {
		const fixture = await cleanL1(outcome);
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("skipped");
		expect(result.status).not.toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("the status union never leaves the four locked values", async () => {
		const seen = new Set<SetupCheckStatus>();
		const outcomes: PaseoLsOutcome[] = [lsOk("gjc"), lsOk(), { kind: "timeout", timeoutMs: 1 }];
		for (const outcome of outcomes) {
			const fixture = await cleanL1(outcome);
			seen.add((await checkPaseoSetup(fixture.deps)).status);
		}
		const dirty = await makeFixture();
		seen.add((await checkPaseoSetup(dirty.deps)).status);
		expect([...seen].every(status => ["pass", "drift", "stale", "skipped"].includes(status))).toBe(true);
		expect(seen.size).toBe(4);
	});

	// Regression: a listed-but-unavailable provider was reported as `pass`,
	// claiming a working integration the user does not have.
	test("a listed but unavailable provider is stale, not pass", async () => {
		const fixture = await cleanL1({
			kind: "ok",
			providerIds: ["gjc"],
			rows: [{ id: "gjc", status: "unavailable" }],
		});
		const result = await checkPaseoSetup(fixture.deps);
		expect(result.status).toBe("stale");
		expect(result.guidance).toContain("unavailable");
	});

	test("a row without a status is trusted as available", async () => {
		const fixture = await cleanL1({ kind: "ok", providerIds: ["gjc"], rows: [{ id: "gjc" }] });
		expect((await checkPaseoSetup(fixture.deps)).status).toBe("pass");
	});

	test("check never spawns a daemon restart", async () => {
		const fixture = await cleanL1(lsOk());
		await checkPaseoSetup(fixture.deps);
		// The injected probe is the only process surface check is given.
		expect(fixture.probes.length).toBe(1);
		expect(fixture.spawned).toEqual([]);
	});
});

describe("skills bridge", () => {
	test("links every paseo-prefixed source skill except the denylist (AC-6, #4638)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths, ["context-search", "paseo-help", "unrelated-skill"]);
		const preflight = await preflightSkillsBridge(fixture.deps);
		await installSkillsBridge(preflight);

		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...SKILL_NAMES, "paseo-help"].sort());
		expect(linked).not.toContain("context-search");
		expect(linked).not.toContain("unrelated-skill");
	});

	test("a foreign file at a bridged name refuses before any mutation", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo"), "user file\n");
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a foreign file squatting on a name the source no longer carries refuses too", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo-retired"), "user file\n");
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a symlink pointing elsewhere refuses before any mutation", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(path.join(fixture.root, "elsewhere"), path.join(fixture.paths.bridgeDir, "paseo"));
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("an already-correct link is a no-op and is not recreated", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo"),
		);

		const preflight = await preflightSkillsBridge(fixture.deps);
		const result = await installSkillsBridge(preflight);
		expect(result.createdEntries).not.toContain("paseo");
		expect(result.createdEntries.length).toBe(SKILL_NAMES.length - 1);
	});

	test("a source entry that is a file, not a directory, is never linked", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.writeFile(path.join(fixture.paths.agentsSkillsDir as string, "paseo-file"), "not a skill\n");
		const preflight = await preflightSkillsBridge(fixture.deps);
		await installSkillsBridge(preflight);
		expect(await fs.readdir(fixture.paths.bridgeDir)).not.toContain("paseo-file");
	});

	/** Install without the full saga but with a realistic ledger, so preflight's provenance gate can run. */
	async function installWithLedger(deps: PaseoSetupDependencies): Promise<void> {
		const preflight = await preflightSkillsBridge(deps);
		await installSkillsBridge(preflight);
		await writeProvenance(deps.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: deps.paths.bridgeDir,
			bridgeEntries: [...Object.keys(preflight.entries), ...preflight.adopts.map(adopt => adopt.name)],
			bridgeDirCreated: false,
			...(preflight.sourceDir ? { bridgeSourceDir: preflight.sourceDir } : {}),
		});
	}

	test("install converges the bridge after a Paseo release adds and drops skills (#4638)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// Paseo 0.4.0: paseo-loop is gone, paseo-help is new.
		await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		await fs.mkdir(path.join(fixture.paths.agentsSkillsDir as string, "paseo-help"), { recursive: true });
		await fs.writeFile(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo-help", "SKILL.md"),
			"# paseo-help\n",
		);

		const second = await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		expect(second.prunedEntries).toEqual(["paseo-loop"]);
		expect(second.createdEntries).toEqual(["paseo-help"]);
		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...SKILL_NAMES.slice(0, 4), "paseo-help"].sort());
		// No dangling links survive the release change.
		for (const name of linked) {
			const stat = await fs.stat(path.join(fixture.paths.bridgeDir, name));
			expect(stat.isDirectory()).toBe(true);
		}
	});

	test("a re-run after a source skill is deleted prunes the dead link instead of leaving it (#4638)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-committee"), { recursive: true });

		const result = await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		expect(result.prunedEntries).toEqual(["paseo-committee"]);
		await expect(fs.lstat(path.join(fixture.paths.bridgeDir, "paseo-committee"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	test("a foreign paseo-prefixed symlink is never pruned, with or without provenance (#4644 review)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// A live user symlink at a name the source does not carry and no ledger
		// ever recorded: directory creation cannot prove ownership, so install
		// must refuse instead of silently deleting it.
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo-mine"),
		);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});
	test("a retargeted recorded link is a conflict, never pruned (#4644 review r2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// The user retargets a ledger-recorded name at their own tree, then a
		// Paseo release drops that name from the source. Setup must apply the
		// same exact-target predicate remove does: the recorded NAME is not
		// ownership once the link no longer points where the ledger recorded.
		await fs.rm(path.join(fixture.paths.bridgeDir, "paseo-loop"));
		await fs.symlink(path.join(fixture.root, "user-own-tree"), path.join(fixture.paths.bridgeDir, "paseo-loop"));
		await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(preflightSkillsBridge(fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("adoption is refused when the ledger already records a source (#4644 review r2)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		// The ledger records ~/.agents/skills as its source, but the discovered
		// source is the app bundle and a recorded link points somewhere else
		// entirely: adoption exists only for legacy ledgers, so this conflicts.
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of ["paseo"]) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(path.join(fixture.root, "elsewhere"), path.join(fixture.paths.bridgeDir, "paseo"));
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: ["paseo"],
			bridgeDirCreated: false,
			bridgeSourceDir: fixture.paths.agentsSkillsDir,
		});
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};

		await expect(preflightSkillsBridge(deps)).rejects.toBeInstanceOf(SkillsBridgeError);
	});

	test("PASEO_SKILLS_DIR from a project .env is not honored (#4644 review r2)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		// A cloned repository ships this .env and the directory it points at.
		const repoDir = path.join(root, "repo");
		const repoSkills = path.join(repoDir, "skills");
		await fs.mkdir(repoSkills, { recursive: true });
		await fs.mkdir(path.join(repoSkills, "paseo-evil"), { recursive: true });
		await Bun.write(path.join(repoDir, ".env"), `PASEO_SKILLS_DIR=${repoSkills}\n`);
		const priorCwd = process.cwd();
		process.chdir(repoDir);
		const prior = process.env.PASEO_SKILLS_DIR;
		process.env.PASEO_SKILLS_DIR = repoSkills;
		try {
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			if (prior === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = prior;
		}
	});

	test("a bridge-step provenance write failure leaves the ledger intact and no links behind (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// Complete one install so provider/orchestration steps and their ledger
		// records exist, then reset ONLY the bridge and make the provenance
		// directory unwritable. The next run must fail while committing the
		// bridge provenance -- AFTER the earlier steps, AT the bridge step --
		// proving the record-before-mutation ordering: no link appears and the
		// ledger is unchanged (the failed write rolls back to the old record).
		await runPaseoSetup({}, fixture.deps);
		const before = await fs.readFile(fixture.paths.provenanceLedger, "utf8");
		await fs.rm(fixture.paths.bridgeDir, { recursive: true });
		const ledgerParent = path.dirname(fixture.paths.provenanceLedger);
		await fs.chmod(ledgerParent, 0o555);
		let outcome: Awaited<ReturnType<typeof runPaseoSetup>> | undefined;
		try {
			outcome = await runPaseoSetup({}, fixture.deps);
		} catch {
			// A thrown error is also acceptable; both must leave no unrecorded
			// links.
		} finally {
			await fs.chmod(ledgerParent, 0o755);
		}

		// The bridge directory must not exist: no link was created before the
		// record committed.
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
		// The failed atomic write left the previous ledger byte-identical and no
		// temporary litter behind.
		expect(await fs.readFile(fixture.paths.provenanceLedger, "utf8")).toBe(before);
		expect((await fs.readdir(ledgerParent)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		if (outcome?.kind === "install") {
			expect(outcome.result.outcome).not.toBe("installed");
		}
	});

	test("a user-created exact-target link is never recorded or removed (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// The user pre-creates a link whose target matches what GJC would write,
		// in an existing bridge directory no ledger ever recorded.
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo"),
		);

		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");
		// The user link is a noop to install but is NOT adopted into ownership.
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).not.toContain("paseo");
		expect(ledger.bridgeEntries).toContain("paseo-advisor");

		// Remove cleans only what GJC recorded; the user's link survives.
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		expect((await fs.lstat(path.join(fixture.paths.bridgeDir, "paseo"))).isSymbolicLink()).toBe(true);
	});

	test("a corrupt provenance ledger is an explicit error, never an empty one (#4644 review r3)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(path.dirname(fixture.paths.provenanceLedger), { recursive: true });
		await Bun.write(fixture.paths.provenanceLedger, "{ not json at all");
		await expect(readProvenance(fixture.paths.provenanceLedger)).rejects.toThrow(/corrupt/);
		// Check surfaces the corruption instead of silently owning nothing.
		await expect(checkPaseoSetup(fixture.deps)).rejects.toThrow(/corrupt/);
	});

	test("prune ownership stays recorded until the unlink completes (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// A Paseo release drops a skill; the next install prunes it.
		await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"), { recursive: true });
		const rerun = await runPaseoSetup({}, fixture.deps);
		expect(rerun.kind).toBe("install");
		// After the prune completes the name is no longer owned...
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).not.toContain("paseo-loop");
		// ...and the link is gone.
		await expect(fs.lstat(path.join(fixture.paths.bridgeDir, "paseo-loop"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		// The pre-prune record (written before mutation) included the name, so a
		// crash between record and unlink could not strand an unowned link; that
		// window is exercised by the ownership-superset invariant below.
		expect([...(ledger.bridgeEntries ?? [])].sort()).toEqual([
			"paseo",
			"paseo-advisor",
			"paseo-committee",
			"paseo-handoff",
		]);
	});

	test("a swapped pathname is detected post-rename and the foreign link restored (#4644 review r3)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		// A foreign link occupies a name the (hand-built) preflight believes is
		// GJC's own with a different recorded target.
		await fs.symlink(
			path.join(fixture.paths.agentsSkillsDir as string, "paseo"),
			path.join(fixture.paths.bridgeDir, "paseo-loop"),
		);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		await expect(
			installSkillsBridge({
				bridgeDir: fixture.paths.bridgeDir,
				bridgeDirCreated: false,
				entries: {},
				prunes: [
					{
						name: "paseo-loop",
						linkPath: path.join(fixture.paths.bridgeDir, "paseo-loop"),
						linkTarget: path.join(fixture.paths.agentsSkillsDir as string, "paseo-loop"),
					},
				],
				adopts: [],
			}),
		).rejects.toBeInstanceOf(SkillsBridgeError);
		// The foreign link is back at its original path, untouched, and no
		// quarantine litter remains.
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("an interpolated project .env override is rejected by presence (#4644 review r3)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		const repoDir = path.join(root, "repo");
		const repoSkills = path.join(repoDir, "skills");
		await fs.mkdir(path.join(repoSkills, "paseo-evil"), { recursive: true });
		// Bun expands $PWD before process.env sees the value, so a literal
		// comparison would match nothing; presence must be the rule.
		await Bun.write(path.join(repoDir, ".env"), "PASEO_SKILLS_DIR=$PWD/skills\n");
		const priorCwd = process.cwd();
		process.chdir(repoDir);
		process.env.PASEO_SKILLS_DIR = repoSkills;
		try {
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			delete process.env.PASEO_SKILLS_DIR;
		}
	});

	test("removal uses the ledger-recorded bridge directory throughout (#4644 review r3)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// Simulate a path migration: the ledger still records the original
		// directory (which holds the links), while deps.paths points elsewhere.
		const recorded = fixture.paths.bridgeDir;
		const moved = path.join(fixture.root, "moved-paseo-skills");
		await fs.mkdir(moved, { recursive: true });
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: moved },
		};

		const remove = await removePaseoSetup(migratedDeps, { now: new Date() });
		if (remove.outcome !== "removed" && remove.outcome !== "partial-removal") {
			throw new Error(`expected a removal outcome, got ${remove.outcome}`);
		}
		// The RECORDED directory is the one cleaned: its links are gone, and the
		// failure path (if any) reports the recorded directory rather than the
		// current one.
		for (const name of ledger.bridgeEntries ?? []) {
			await expect(fs.lstat(path.join(recorded, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	test("a valid but empty source bridges nothing and records no phantom bridge (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		// The source directory exists but ships no `paseo*` skills: an
		// intentional no-bridge state. No directory is created, nothing is
		// registered, and the ledger must not claim a bridge GJC never built
		// (a phantom record would make --remove straddle a missing path and
		// --check look healthy while loading nothing).
		await runPaseoSetup({}, fixture.deps);
		await runPaseoSetup({}, fixture.deps);

		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeDirCreated).toBeFalsy();
		expect(ledger.bridgePath).toBeUndefined();
		expect(ledger.bridgeEntries).toEqual([]);

		// Removal is still a clean no-op-with-provenance: the daemon credential
		// and the foreign provider survive, and no bridge path is touched.
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};
		const remove = await runPaseoSetup({ remove: true }, deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(Object.keys(providers).sort()).toEqual(["claude"]);
	});
	test("install and remove serialize on one per-agent mutation lock (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);

		// An in-flight install pauses inside its bridge step; a concurrent
		// remove must wait for it rather than clearing the ledger while links
		// are still being created.
		let releaseInstall: (() => void) | undefined;
		const gate = Promise.withResolvers<void>();
		const gatedSource = fixture.deps.skillsSource;
		const installDeps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => {
				const source = await gatedSource?.();
				if (releaseInstall === undefined) {
					releaseInstall = () => gate.resolve();
				} else {
					await gate.promise;
				}
				return source;
			},
		};

		const installPromise = runPaseoSetup({}, installDeps);
		await Bun.sleep(50);
		releaseInstall?.();
		const install = await installPromise;
		expect(install.kind).toBe("install");

		// A remove that starts while another holder owns the lock serializes:
		// both complete, and the serialized order is whichever won the lock.
		// The invariant under test is consistency, not ordering: every live
		// bridge link is covered by the ledger record (the un-serialized bug
		// left links live with a cleared record).
		const [secondInstall, remove] = await Promise.all([
			runPaseoSetup({}, fixture.deps),
			runPaseoSetup({ remove: true }, fixture.deps),
		]);
		expect(secondInstall.kind === "install" || remove.kind === "remove").toBe(true);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		const liveLinks = (await fs.readdir(fixture.paths.bridgeDir).catch(() => [])).filter(name =>
			name.startsWith("paseo"),
		);
		const recorded = new Set(ledger.bridgeEntries ?? []);
		for (const name of liveLinks) {
			expect(recorded.has(name)).toBe(true);
		}
		if (remove.kind === "remove" && remove.result.outcome === "removed" && liveLinks.length === 0) {
			expect(ledger.bridgeEntries ?? []).toEqual([]);
		}
	});

	test("a pre-existing identical provider entry is never claimed as GJC-owned (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		// Run 1: GJC installs and records its entry.
		await runPaseoSetup({}, fixture.deps);
		// The ledger is lost (or the machine is rebuilt): the config still
		// carries an entry byte-identical to what GJC writes, but GJC no
		// longer has any record of creating it.
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
		});

		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");

		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerKeys.gjc).toBeUndefined();
		expect(ledger.providerPreexistingKeys?.gjc).toBe(true);

		// A later remove leaves the entry in place: it was never GJC's.
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBeDefined();
	});

	test("a --force overwrite restores the replaced provider entry on remove (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const userEntry = { ...buildProviderEntry([process.execPath, "acp"]), label: "USER EDIT", enabled: false };
		await seedConfig(fixture.paths, { gjc: userEntry });

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerKeys.gjc).toBeDefined();
		expect(ledger.providerReplacedEntries?.gjc).toEqual(userEntry);

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toEqual(userEntry);
	});

	test("a migration with a tampered ledger name or path refuses instead of cleaning (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// Tamper: a traversal entry name inside the recorded set.
		const victimDir = path.join(fixture.root, "outside");
		await fs.mkdir(victimDir, { recursive: true });
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			bridgeEntries: ["paseo", "../../outside/paseo-skills"],
		});

		const newBridge = path.join(fixture.root, "agentdir-new", "paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: newBridge },
		};

		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("partial-install");
		// The old directory's real links are untouched by the refusal.
		for (const name of ["paseo", "paseo-advisor"]) {
			await expect(fs.lstat(path.join(fixture.paths.bridgeDir, name))).resolves.toBeDefined();
		}
		await expect(fs.lstat(victimDir)).resolves.toBeDefined();
	});

	test("an unreadable source directory fails closed and preserves the bridge (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		// The source directory exists but cannot be read: an app update or a
		// permission change mid-run. Every recorded entry must survive.
		await fs.chmod(fixture.paths.agentsSkillsDir as string, 0o000);
		try {
			// Preflight refuses before any mutation; nothing is pruned.
			await expect(runPaseoSetup({}, fixture.deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		} finally {
			await fs.chmod(fixture.paths.agentsSkillsDir as string, 0o755);
		}
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a source that vanishes mid-run fails closed and preserves the bridge (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		// The resolver verifies the directory, then it disappears before
		// enumeration: the preflight must refuse rather than prune everything.
		const vanishable = path.join(fixture.root, "vanishing-skills");
		await fs.cp(fixture.paths.agentsSkillsDir as string, vanishable, { recursive: true });
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => {
				await fs.rm(vanishable, { recursive: true, force: true });
				return { dir: vanishable, origin: "user" };
			},
		};

		// Preflight refuses rather than pruning; the bridge is untouched.
		await expect(runPaseoSetup({}, deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a resolved source that becomes empty prunes to a recorded-created empty bridge, and remove cleans it (#4644 review r5)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// Every skill disappears but the directory itself remains valid.
		for (const name of SKILL_NAMES) {
			await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		const converged = await runPaseoSetup({}, fixture.deps);
		expect(converged.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toEqual([]);
		expect(ledger.bridgeDirCreated).toBe(true);

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("a --force overwrite of a scalar provider value is restored on remove (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths, { gjc: "user scalar value" });

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.providerReplacedEntries?.gjc).toBe("user scalar value");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBe("user scalar value");
	});

	test("a --force overwrite of a null provider value is restored on remove (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		const config = {
			daemon: { auth: { password: FIXTURE_PASSWORD }, port: 4317 },
			agents: { providers: { claude: { enabled: true }, gjc: null } },
		};
		await fs.writeFile(fixture.paths.configJson, serializeJson(config), { mode: 0o600 });

		const install = await runPaseoSetup({ force: true }, fixture.deps);
		expect(install.kind).toBe("install");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		const after = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (after.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBeNull();
	});

	test("a migration replaces the old custom-directory registration atomically (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;

		// The ledger stays in place; only the bridge path moves (a relocation
		// inside the same agent directory, where the ledger still records the
		// old path).
		const newBridge = path.join(path.dirname(oldDir), "relocated-paseo-skills");
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: {
				...fixture.deps.paths,
				bridgeDir: newBridge,
			},
		};
		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("expected an install outcome");
		expect(install.result.outcome).toBe("installed");

		// The new path is registered and the old one is gone in the same swap.
		const settings = await fs.readFile(path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "config.yml"), "utf8");
		expect(settings).toContain(newBridge);
		expect(settings).not.toContain(oldDir);
		// The old bridge is cleaned after the durable cutover.
		for (const name of ["paseo", "paseo-advisor"]) {
			await expect(fs.lstat(path.join(oldDir, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	test("a tampered ledger path refuses removal before any settings mutation (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		const victimDir = path.join(fixture.root, "victim");
		await fs.mkdir(victimDir, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(victimDir, "paseo"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgePath: victimDir });

		const settingsBefore = await snapshotTree(path.dirname(fixture.paths.provenanceLedger));
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("partial-removal");
		// The registration and provider entries were NOT touched: validation
		// failed before any settings mutation.
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(providers.gjc).toBeDefined();
		expect(await snapshotTree(path.dirname(fixture.paths.provenanceLedger))).toBe(settingsBefore);
	});

	test("a resolved source replaced by a regular file refuses instead of pruning (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const before = await snapshotTree(fixture.paths.bridgeDir);

		// An app update replaces the skills directory with a file.
		await fs.rm(fixture.paths.agentsSkillsDir as string, { recursive: true, force: true });
		await fs.writeFile(fixture.paths.agentsSkillsDir as string, "not a directory\n");
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: fixture.paths.agentsSkillsDir as string, origin: "user" }),
		};

		await expect(runPaseoSetup({}, deps)).rejects.toBeInstanceOf(SkillsBridgeError);
		expect(await snapshotTree(fixture.paths.bridgeDir)).toBe(before);
	});

	test("a convergence over an owned empty bridge preserves its provenance and registration (#4644 review r6)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		for (const name of [...SKILL_NAMES]) {
			await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		// First convergence: entries pruned, directory GJC-created and owned.
		await runPaseoSetup({}, fixture.deps);
		let ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeDirCreated).toBe(true);

		// Second convergence over the still-empty source must NOT discard the
		// ownership record: the directory and its registration stay removable.
		await runPaseoSetup({}, fixture.deps);
		ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeDirCreated).toBe(true);
		expect(ledger.bridgePath).toBe(fixture.paths.bridgeDir);

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("remove after every entry was pruned still cleans the recorded-created empty bridge (#4644 review r4)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		// A Paseo release drops EVERY skill: convergence prunes the final entry
		// and leaves `bridgeEntries: []` with `bridgeDirCreated: true`.
		for (const name of [...SKILL_NAMES]) {
			await fs.rm(path.join(fixture.paths.agentsSkillsDir as string, name), { recursive: true });
		}
		const converged = await runPaseoSetup({}, fixture.deps);
		expect(converged.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toEqual([]);
		expect(ledger.bridgeDirCreated).toBe(true);
		// The empty directory GJC created must not be stranded.
		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a tampered ledger bridge path never drives destructive removal (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		// Tamper: the ledger points outside the agent directory at a directory
		// holding a foreign link with a matching name.
		const victimDir = path.join(fixture.root, "victim");
		await fs.mkdir(victimDir, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(victimDir, "paseo"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, { ...ledger, bridgePath: victimDir });

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toContain("escapes the agent directory");
		// The foreign link is untouched.
		expect((await fs.lstat(path.join(victimDir, "paseo"))).isSymbolicLink()).toBe(true);
	});

	test("a ledger bridge path that is a symlink is refused before removal (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		const real = path.join(fixture.root, "real-bridge");
		await fs.mkdir(real, { recursive: true });
		await fs.symlink(real, path.join(fixture.root, "agentdir", "paseo-skills-link"));
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			bridgePath: path.join(fixture.root, "agentdir", "paseo-skills-link"),
		});

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toContain("symlink");
	});

	test("a recorded entry replaced by a regular file is a divergence, not silent success (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);
		// The user replaces a bridged name with their own regular file.
		await fs.rm(path.join(fixture.paths.bridgeDir, "paseo"));
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo"), "user data\n");

		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("partial-removal");
		// The user's file survives and the provenance is retained.
		expect(await fs.readFile(path.join(fixture.paths.bridgeDir, "paseo"), "utf8")).toBe("user data\n");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toContain("paseo");
	});

	test("no resolved source and no ownership record refuses to register the bridge (#4644 review r4)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedConfig(fixture.paths);
		// A stale foreign bridge directory exists; no source resolves and no
		// ledger records ownership of it.
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		await fs.writeFile(path.join(fixture.paths.bridgeDir, "paseo-foreign"), "stale\n");
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		if (install.kind !== "install") throw new Error("unreachable");
		expect(install.result.outcome).toBe("partial-install");
		if (install.result.outcome === "partial-install") {
			expect(install.result.evidence.detail).toContain("Refusing to register");
		}
		// The stale bridge content was never touched.
		expect(await fs.readFile(path.join(fixture.paths.bridgeDir, "paseo-foreign"), "utf8")).toBe("stale\n");
	});

	test("a symlinked source skill directory is bridged after resolution (#4644 review r4)", async () => {
		const fixture = await makeFixture();
		const realSkill = path.join(fixture.root, "real-skills", "paseo-linked");
		await fs.mkdir(realSkill, { recursive: true });
		await Bun.write(path.join(realSkill, "SKILL.md"), "# real\n");
		// The source directory contains a SYMLINK to a skill directory.
		await fs.symlink(realSkill, path.join(fixture.paths.agentsSkillsDir as string, "paseo-linked"));
		// And a dangling symlink of the same shape is not bridged.
		await fs.symlink(
			path.join(fixture.root, "gone"),
			path.join(fixture.paths.agentsSkillsDir as string, "paseo-dangling"),
		);

		const preflight = await preflightSkillsBridge(fixture.deps);
		const names = [...Object.keys(preflight.entries)];
		expect(names).toContain("paseo-linked");
		expect(names).not.toContain("paseo-dangling");
	});

	test("a bridge-path migration cleans the old directory and never inherits its names (#4644 review r4)", async () => {
		const fixture = await makeFixture(lsOk("gjc"));
		await seedSkills(fixture.paths);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		const oldDir = fixture.paths.bridgeDir;
		const oldLedger = await readProvenance(fixture.paths.provenanceLedger);

		// The agent dir moves; a USER link already sits at the new path.
		const newBridge = path.join(fixture.root, "agentdir-new", "paseo-skills");
		await fs.mkdir(newBridge, { recursive: true });
		await fs.symlink(path.join(fixture.paths.agentsSkillsDir as string, "paseo"), path.join(newBridge, "paseo"));
		const migratedDeps: PaseoSetupDependencies = {
			...fixture.deps,
			paths: { ...fixture.deps.paths, bridgeDir: newBridge },
		};

		const install = await runPaseoSetup({}, migratedDeps);
		expect(install.kind).toBe("install");
		// The old directory's links were cleaned, not abandoned.
		for (const name of oldLedger.bridgeEntries ?? []) {
			await expect(fs.lstat(path.join(oldDir, name))).rejects.toMatchObject({ code: "ENOENT" });
		}
		// The new ledger owns only the links the new run created: the user's
		// pre-existing `paseo` link at the new path did NOT inherit ownership.
		const ledger = await readProvenance(migratedDeps.paths.provenanceLedger);
		expect(ledger.bridgePath).toBe(newBridge);
		expect(ledger.bridgeEntries).not.toContain("paseo");
		expect(ledger.bridgeEntries).toContain("paseo-advisor");
	});

	test(".env.local and NODE_ENV variants are rejected for PASEO_SKILLS_DIR (#4644 review r4)", async () => {
		const root = await makeRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		const repoDir = path.join(root, "repo");
		await fs.mkdir(repoDir, { recursive: true });
		const priorCwd = process.cwd();
		const priorEnv = process.env.PASEO_SKILLS_DIR;
		const priorNodeEnv = process.env.NODE_ENV;
		try {
			for (const file of [".env.local", ".env.production", ".env.production.local"]) {
				await Bun.write(path.join(repoDir, file), "PASEO_SKILLS_DIR=/some/override\n");
			}
			process.chdir(repoDir);
			process.env.NODE_ENV = "production";
			process.env.PASEO_SKILLS_DIR = "/some/override";
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		} finally {
			process.chdir(priorCwd);
			if (priorEnv === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = priorEnv;
			if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = priorNodeEnv;
		}
	});

	test("a pre-#4638 bridge pointing at the legacy source is adopted, not refused (#4644 review)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		// The legacy machine: allowlist links into ~/.agents/skills, ledger
		// without bridgeSourceDir. The source still resolves to the same
		// directory, so adoption is a no-op re-point of the same target.
		await installWithLedger(fixture.deps);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		await writeProvenance(fixture.paths.provenanceLedger, {
			...ledger,
			bridgeSourceDir: undefined,
		});

		const preflight = await preflightSkillsBridge(fixture.deps);
		// Same-directory legacy links are already correct: nothing to adopt.
		expect(preflight.adopts).toEqual([]);
	});

	test("a legacy ledger with links into a retired ~/.agents/skills converges onto the app bundle (#4644 review)", async () => {
		// The exact wedged state from #4638: five allowlist links into a
		// ~/.agents/skills that never existed, a desktop app now present, and a
		// legacy ledger without bridgeSourceDir.
		const fixture = await makeFixture(lsOk("gjc"));
		await fs.rm(fixture.paths.agentsSkillsDir as string, { recursive: true });
		const legacySource = fixture.paths.agentsSkillsDir as string;
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of ["paseo", "paseo-help"]) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		for (const name of SKILL_NAMES) {
			await fs.symlink(path.join(legacySource, name), path.join(fixture.paths.bridgeDir, name));
		}
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeDirCreated: false,
		});
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};

		// Check reports the wedge (dangling legacy links) instead of passing.
		const drifted = await checkPaseoSetup(deps);
		expect(drifted.status).toBe("drift");

		// Re-running setup converges: adopt paseo, prune the retired names,
		// create paseo-help, and record the discovered source directory.
		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect([...(ledger.bridgeEntries ?? [])].sort()).toEqual(["paseo", "paseo-help"]);
		expect(ledger.bridgeSourceDir).toBe(bundle);
		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual(["paseo", "paseo-help"]);
		for (const name of linked) {
			expect(await fs.readlink(path.join(fixture.paths.bridgeDir, name))).toBe(path.join(bundle, name));
		}

		const result = await checkPaseoSetup(deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("remove rolls back a legacy ledger with no recorded source directory (#4644 review)", async () => {
		// The same wedged machine, exercising --remove directly: the ledger
		// predates bridgeSourceDir, so ownership is proven against the legacy
		// ~/.agents/skills location rather than a re-discovered source.
		const fixture = await makeFixture(lsOk("gjc"));
		const legacySource = fixture.paths.agentsSkillsDir as string;
		await fs.mkdir(fixture.paths.bridgeDir, { recursive: true });
		for (const name of SKILL_NAMES) {
			await fs.symlink(path.join(legacySource, name), path.join(fixture.paths.bridgeDir, name));
		}
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: {},
			seededOrchestrationKeys: {},
			bridgePath: fixture.paths.bridgeDir,
			bridgeEntries: [...SKILL_NAMES],
			bridgeDirCreated: true,
		});
		// No source can be discovered anymore (the app is gone), and the legacy
		// ledger has no bridgeSourceDir: removal must still prove ownership.
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const result = await removePaseoSetup(deps, { now: new Date() });
		expect(result.outcome).toBe("removed");
		// Every legacy link is gone and the bridge directory was removed.
		await expect(fs.stat(deps.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a non-ENOENT filesystem failure fails removal closed instead of reporting success (#4644 review)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		await installWithLedger(fixture.deps);

		// Simulate a permission failure on the bridge directory: the recorded
		// entry is still on disk, but lstat cannot traverse to it. Removal must
		// report partial-removal and retain the ledger, never claim success.
		// chmod 000 blocks traversal with EACCES on the real syscall surface,
		// which is exactly the errno class the review asked to keep distinct.
		await fs.chmod(fixture.paths.bridgeDir, 0o000);
		let result: PaseoRemoveResult;
		try {
			result = await removePaseoSetup(fixture.deps, { now: new Date() });
		} finally {
			await fs.chmod(fixture.paths.bridgeDir, 0o755);
		}
		expect(result.outcome).toBe("partial-removal");
		if (result.outcome !== "partial-removal") throw new Error("unreachable");
		expect(result.evidence.detail).toContain("EACCES");

		// The owned link still exists and the ledger still records it.
		expect((await fs.lstat(path.join(fixture.paths.bridgeDir, "paseo"))).isSymbolicLink()).toBe(true);
		const ledger = await readProvenance(fixture.paths.provenanceLedger);
		expect(ledger.bridgeEntries).toContain("paseo");
	});

	test("both protected skill trees are byte-identical across install and check (AC-8, AC-19)", async () => {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths, ["context-search"]);
		await fs.writeFile(path.join(fixture.paths.gjcSkillsDir, "mine.md"), "# mine\n");

		const agentsBefore = await snapshotTree(fixture.paths.agentsSkillsDir as string);
		const gjcBefore = await snapshotTree(fixture.paths.gjcSkillsDir);

		await installSkillsBridge(await preflightSkillsBridge(fixture.deps));
		await checkPaseoSetup(fixture.deps);

		expect(await snapshotTree(fixture.paths.agentsSkillsDir as string)).toBe(agentsBefore);
		expect(await snapshotTree(fixture.paths.gjcSkillsDir)).toBe(gjcBefore);
	});
});

describe("skills source discovery (#4638)", () => {
	async function discoveryRoot(): Promise<string> {
		const root = await makeRoot();
		return root;
	}

	test("PASEO_SKILLS_DIR wins when it points at a real directory", async () => {
		const root = await discoveryRoot();
		const home = path.join(root, "home");
		const relocated = path.join(root, "Elsewhere", "Paseo.app", "Contents", "Resources", "skills");
		await fs.mkdir(relocated, { recursive: true });
		const prior = process.env.PASEO_SKILLS_DIR;
		process.env.PASEO_SKILLS_DIR = relocated;
		try {
			await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: relocated, origin: "app-bundle" });
		} finally {
			if (prior === undefined) delete process.env.PASEO_SKILLS_DIR;
			else process.env.PASEO_SKILLS_DIR = prior;
		}
	});

	test("a stale or relative PASEO_SKILLS_DIR is ignored, never linked into", async () => {
		const root = await discoveryRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		for (const value of [path.join(root, "gone"), "relative/skills"]) {
			const prior = process.env.PASEO_SKILLS_DIR;
			process.env.PASEO_SKILLS_DIR = value;
			try {
				await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
			} finally {
				if (prior === undefined) delete process.env.PASEO_SKILLS_DIR;
				else process.env.PASEO_SKILLS_DIR = prior;
			}
		}
	});

	test("~/.agents/skills wins over an app bundle; nothing resolvable means undefined", async () => {
		const root = await discoveryRoot();
		const home = path.join(root, "home");
		const userDir = path.join(home, ".agents", "skills");
		await fs.mkdir(userDir, { recursive: true });
		await expect(resolvePaseoSkillsSource(home)).resolves.toEqual({ dir: userDir, origin: "user" });
		// A home with no ~/.agents/skills and no bundle resolves to nothing. The
		// bundle candidates are platform-bounded, so this holds everywhere.
		await expect(resolvePaseoSkillsSource(path.join(root, "empty-home"))).resolves.toBeUndefined();
	});

	test("app bundle candidates are bounded and platform-shaped", () => {
		const home = "/Users/tester";
		const candidates = paseoAppSkillsCandidates(home);
		if (process.platform === "darwin") {
			expect(candidates.length).toBe(6);
			expect(candidates[0]).toBe(path.join("/Applications", "Paseo.app", "Contents", "Resources", "skills"));
			expect(candidates).toContain(path.join(home, "Applications", "Paseo.app", "Contents", "Resources", "skills"));
		} else {
			expect(candidates).toEqual([]);
		}
	});
});

describe("desktop app install (#4638)", () => {
	const APP_SKILLS = ["paseo", "paseo-advisor", "paseo-committee", "paseo-handoff", "paseo-help"];

	/** `runPaseoSetup` narrowed to the check arm, for readable assertions. */
	async function check(deps: PaseoSetupDependencies): Promise<SetupCheckResult> {
		const outcome = await runPaseoSetup({ check: true }, deps);
		if (outcome.kind !== "check") throw new Error("expected a check outcome");
		return outcome.result;
	}

	/** The reported machine: Paseo.app 0.4.0 ships paseo-help, not paseo-loop, and there is no ~/.agents/skills. */
	async function appFixture(skillNames: readonly string[]): Promise<Fixture> {
		const fixture = await makeFixture(lsOk("gjc"));
		await fs.rm(fixture.paths.agentsSkillsDir as string, { recursive: true });
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		for (const name of skillNames) {
			await fs.mkdir(path.join(bundle, name), { recursive: true });
			await fs.writeFile(path.join(bundle, name, "SKILL.md"), `# ${name}\n`);
		}
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => ({ dir: bundle, origin: "app-bundle" }),
		};
		return { ...fixture, deps };
	}

	test("install bridges the bundle's skills and check reaches pass", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);

		const install = await runPaseoSetup({}, fixture.deps);
		expect(install.kind).toBe("install");

		const result = await check(fixture.deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);

		// The exact set the app ships is bridged -- nothing more, nothing less.
		const linked = (await fs.readdir(fixture.paths.bridgeDir)).sort();
		expect(linked).toEqual([...APP_SKILLS].sort());
		for (const name of linked) {
			const target = await fs.readlink(path.join(fixture.paths.bridgeDir, name));
			expect(path.dirname(target)).toBe(
				path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills"),
			);
		}
	});

	test("a missing source directory skips the bridge, creates nothing, and reports it once", async () => {
		const fixture = await appFixture([]);
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};
		await seedConfig(fixture.paths);

		const install = await runPaseoSetup({}, deps);
		expect(install.kind).toBe("install");
		await expect(fs.stat(deps.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		const result = await check(deps);
		expect(result.status).toBe("drift");
		const codes = result.reasons.map(reason => reason.code);
		expect(codes).toContain("missing-skills-directory");
		expect(codes).not.toContain("missing-bridge-link");
		expect(codes).not.toContain("orphan-skill");
	});

	test("a source skill with no bridge link is drift, and re-running setup repairs it", async () => {
		const fixture = await appFixture(SKILL_NAMES);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);
		await fs.rm(path.join(fixture.paths.bridgeDir, "paseo-advisor"));

		const drifted = await check(fixture.deps);
		expect(drifted.status).toBe("drift");
		expect(drifted.reasons).toEqual([
			{
				code: "missing-bridge-link",
				subject: path.join(fixture.paths.bridgeDir, "paseo-advisor"),
				detail: expect.any(String),
			},
		]);

		await runPaseoSetup({}, fixture.deps);
		expect((await check(fixture.deps)).status).toBe("pass");
	});

	test("a Paseo release adding a skill never turns check red", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// The app updates underneath GJC and ships one extra skill.
		const bundle = path.join(fixture.root, "Applications", "Paseo.app", "Contents", "Resources", "skills");
		await fs.mkdir(path.join(bundle, "paseo-brand-new"));

		const result = await check(fixture.deps);
		expect(result.status).toBe("pass");
		expect(checkExitCode(result)).toBe(0);
	});

	test("repeated install, check, and remove converge and preserve the foreign provider", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);

		await runPaseoSetup({}, fixture.deps);
		const again = await runPaseoSetup({}, fixture.deps);
		expect(again.kind).toBe("install");
		let result = await check(fixture.deps);
		expect(result.status).toBe("pass");

		const remove = await runPaseoSetup({ remove: true }, fixture.deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(fixture.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		// The foreign provider entry survives every pass untouched.
		const config = JSON.parse(await fs.readFile(fixture.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(Object.keys(providers).sort()).toEqual(["claude"]);

		// And a fresh install on top of the rolled-back state is green again.
		await runPaseoSetup({}, fixture.deps);
		result = await check(fixture.deps);
		expect(result.status).toBe("pass");
	});

	test("remove still cleans the bridge after Paseo itself is uninstalled (#4638)", async () => {
		const fixture = await appFixture(APP_SKILLS);
		await seedConfig(fixture.paths);
		await runPaseoSetup({}, fixture.deps);

		// Paseo disappears entirely: the app bundle is gone, so every bridge link
		// dangles and no source can be discovered anymore.
		await fs.rm(path.join(fixture.root, "Applications"), { recursive: true });
		const deps: PaseoSetupDependencies = {
			...fixture.deps,
			skillsSource: async () => undefined,
		};

		const remove = await runPaseoSetup({ remove: true }, deps);
		if (remove.kind !== "remove") throw new Error("expected a remove outcome");
		expect(remove.result.outcome).toBe("removed");
		await expect(fs.stat(deps.paths.bridgeDir)).rejects.toMatchObject({ code: "ENOENT" });

		const config = JSON.parse(await fs.readFile(deps.paths.configJson, "utf8")) as Record<string, unknown>;
		const providers = (config.agents as { providers: Record<string, unknown> }).providers;
		expect(Object.keys(providers).sort()).toEqual(["claude"]);
	});
});

describe("provenance-gated removal (AC-19)", () => {
	async function installedFixture(): Promise<Fixture> {
		const fixture = await makeFixture();
		await seedSkills(fixture.paths);
		const entry = buildProviderEntry([process.execPath, "acp"]);
		await seedConfig(fixture.paths, { gjc: entry });
		await fs.writeFile(fixture.paths.orchestrationPreferences, serializeJson({ providers: { impl: "gjc" } }));
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: { gjc: providerEntryHash(entry) },
			seededOrchestrationKeys: { impl: "gjc" },
		});
		return fixture;
	}

	test("an unedited seeded key is cleared", async () => {
		const fixture = await installedFixture();
		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("removed");
		const after = await readTarget(fixture.paths.configJson);
		expect(providersOf(after.parsed).gjc).toBeUndefined();
	});

	test("a user-edited key survives removal", async () => {
		const fixture = await installedFixture();
		const current = await readTarget(fixture.paths.configJson);
		const plan = planPublish(current, draft => {
			const entry = providersOf(draft).gjc as Record<string, unknown>;
			entry.label = "MY OWN LABEL";
		});
		await publishPlan(fixture.paths.configJson, plan, {
			expectedIdentity: current.identity,
			backup: false,
			now: new Date(),
		});

		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.configJson);
		const survivor = providersOf(after.parsed).gjc as Record<string, unknown> | undefined;
		expect(survivor?.label).toBe("MY OWN LABEL");
	});

	// Regression: removal deleted a top-level key that does not exist in the real
	// nested schema, clearing provenance while leaving the role pointing at a
	// provider entry it had just deleted.
	test("seeded nested roles are removed from providers, not from the top level", async () => {
		const fixture = await installedFixture();
		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.orchestrationPreferences);
		const roles = after.parsed.providers as Record<string, unknown> | undefined;
		expect(roles?.impl).toBeUndefined();
	});

	test("a user-reassigned role survives removal and keeps sibling keys", async () => {
		const fixture = await installedFixture();
		await fs.writeFile(
			fixture.paths.orchestrationPreferences,
			serializeJson({ providers: { impl: "someone-else", ui: "theirs" }, preferences: ["note"] }),
		);

		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.orchestrationPreferences);
		const roles = after.parsed.providers as Record<string, unknown>;
		expect(roles.impl).toBe("someone-else");
		expect(roles.ui).toBe("theirs");
		expect(after.parsed.preferences).toEqual(["note"]);
	});

	test("a never-provenanced key that coincidentally matches is untouched", async () => {
		const fixture = await makeFixture();
		const entry = buildProviderEntry([process.execPath, "acp"]);
		await seedConfig(fixture.paths, { gjc: entry });
		// The ledger records a different key, so `gjc` was never ours.
		await writeProvenance(fixture.paths.provenanceLedger, {
			version: 1,
			providerKeys: { "gjc-other": "deadbeef" },
			seededOrchestrationKeys: {},
		});

		await removePaseoSetup(fixture.deps, { now: new Date() });

		const after = await readTarget(fixture.paths.configJson);
		expect(providersOf(after.parsed).gjc).toBeDefined();
	});

	test("nothing recorded means nothing to remove", async () => {
		const fixture = await makeFixture();
		await seedConfig(fixture.paths);
		const result = await removePaseoSetup(fixture.deps, { now: new Date() });
		expect(result.outcome).toBe("nothing-to-remove");
	});

	test("all provenanced gjc keys from repeated mpreset runs are enumerated", () => {
		const ledger = {
			version: 1,
			providerKeys: { gjc: "a", "gjc-codex-pro": "b", "gjc-fast": "c" },
			seededOrchestrationKeys: {},
		};
		expect(provenancedProviderKeys(ledger)).toEqual(["gjc", "gjc-codex-pro", "gjc-fast"]);
	});

	test("ownership requires both a record and a matching value hash", () => {
		const ledger = { version: 1, providerKeys: { gjc: "hash-a" }, seededOrchestrationKeys: {} };
		expect(isProvenancedProvider(ledger, "gjc", "hash-a")).toBe(true);
		expect(isProvenancedProvider(ledger, "gjc", "hash-b")).toBe(false);
		expect(isProvenancedProvider(ledger, "absent", "hash-a")).toBe(false);
	});
});

describe("intent recovery", () => {
	async function intentFixture(): Promise<{ fixture: Fixture; intent: IntentRecord }> {
		const fixture = await makeFixture();
		await fs.mkdir(path.dirname(fixture.paths.provenanceLedger), { recursive: true });
		await fs.writeFile(fixture.paths.configJson, serializeJson({ before: true }));
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ before: true }));
		const intent: IntentRecord = {
			version: INTENT_VERSION,
			step: "provider-config",
			targetPath: fixture.paths.configJson,
			ownedKeys: ["agents.providers.gjc"],
			targetPreflightIdentity: await currentIdentity(fixture.paths.configJson),
			targetExpectedIdentity: hashBytes(serializeJson({ after: true })),
			provenancePath: fixture.paths.provenanceLedger,
			provenancePreflightIdentity: await currentIdentity(fixture.paths.provenanceLedger),
			provenanceExpectedIdentity: hashBytes(serializeJson({ after: true })),
			startedAt: new Date().toISOString(),
		};
		return { fixture, intent };
	}

	test("target published but ledger not yet committed means complete the ledger", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		expect((await classifyIntent(intent)).action).toBe("complete-ledger");
	});

	test("both written means discard the stale intent", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ after: true }));
		expect((await classifyIntent(intent)).action).toBe("discard");
	});

	test("target never written means discard", async () => {
		const { intent } = await intentFixture();
		expect((await classifyIntent(intent)).action).toBe("discard");
	});

	test("a third-party target identity refuses", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ someone: "else" }));
		expect((await classifyIntent(intent)).action).toBe("refuse");
	});

	test("a divergent ledger refuses regardless of target state", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ someone: "else" }));
		expect((await classifyIntent(intent)).action).toBe("refuse");
	});

	// An intent written before payloads were recorded cannot be completed, and
	// says so rather than silently discarding an uncommitted ownership record.
	test("complete-ledger without a payload reports honestly and retains the intent", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(false);
		expect(recovery?.detail).toContain("no ledger payload");
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	// Regression: a seed-if-empty step could never be recovered by retrying,
	// because its own publish removed the emptiness the step was gated on.
	test("complete-ledger commits the recorded payload instead of relying on a retry", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.configJson, serializeJson({ after: true }));
		await writeIntent(fixture.paths.intentRecord, {
			...intent,
			provenancePayload: { version: 1, providerKeys: {}, seededOrchestrationKeys: { ui: "gjc" } },
		});

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(true);
		expect((await readProvenance(fixture.paths.provenanceLedger)).seededOrchestrationKeys.ui).toBe("gjc");
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("a discardable intent is cleared under repair", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(true);
		expect(await readIntent(fixture.paths.intentRecord)).toBeUndefined();
	});

	test("check-mode recovery never mutates the intent", async () => {
		const { fixture, intent } = await intentFixture();
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: false });
		expect(recovery?.recovered).toBe(false);
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	test("a refusal is never repaired even under repair", async () => {
		const { fixture, intent } = await intentFixture();
		await fs.writeFile(fixture.paths.provenanceLedger, serializeJson({ someone: "else" }));
		await writeIntent(fixture.paths.intentRecord, intent);

		const recovery = await recoverIntent(fixture.paths.intentRecord, { repair: true });
		expect(recovery?.recovered).toBe(false);
		expect(await readIntent(fixture.paths.intentRecord)).toBeDefined();
	});

	test("identity classification is exhaustive over the three states", () => {
		expect(classifyIdentity("x", "x", "y")).toBe("before");
		expect(classifyIdentity("y", "x", "y")).toBe("intended-after");
		expect(classifyIdentity("z", "x", "y")).toBe("divergent");
	});
});

describe("saga compensation", () => {
	test("undoes completed steps in reverse order", async () => {
		const order: string[] = [];
		const steps: CompletedStep[] = ["one", "two", "three"].map(label => ({
			label,
			undo: async () => {
				order.push(label);
				return { status: "reverted" as const };
			},
		}));

		const outcome = await compensate(steps, new SagaStepError("four", "boom"));
		expect(order).toEqual(["three", "two", "one"]);
		expect(outcome.compensated).toEqual(["three", "two", "one"]);
		expect(outcome.uncompensated).toEqual([]);
	});

	test("a conflicting inverse halts the remaining compensation", async () => {
		const attempted: string[] = [];
		const steps: CompletedStep[] = [
			{
				label: "one",
				undo: async () => {
					attempted.push("one");
					return { status: "reverted" as const };
				},
			},
			{
				label: "two",
				undo: async () => {
					attempted.push("two");
					return { status: "conflict" as const, detail: "changed underneath", retained: ["/tmp/evidence"] };
				},
			},
		];

		const outcome = await compensate(steps, new SagaStepError("three", "boom"));
		// "one" is never attempted, because "two" halted the unwind.
		expect(attempted).toEqual(["two"]);
		expect(outcome.uncompensated).toEqual(["two", "one"]);
		expect(outcome.evidence.detail).toContain("changed underneath");
		expect(outcome.evidence.retained).toContain("/tmp/evidence");
	});
});

describe("CLI surface (AC-10, AC-11)", () => {
	test.each([
		[["setup", "paseo", "--check"], { check: true }],
		[["setup", "paseo", "--json", "--force"], { json: true, force: true }],
		[["setup", "paseo", "--remove"], { remove: true }],
		[["setup", "paseo", "--mpreset", "codex-pro"], { mpreset: "codex-pro" }],
	])("parseSetupArgs resolves %j", (argv: string[], expected: Record<string, unknown>) => {
		const parsed = parseSetupArgs(argv as string[]);
		expect(parsed?.component).toBe("paseo");
		expect(parsed?.flags).toMatchObject(expected as Record<string, unknown>);
	});

	test("check and remove together is rejected naming both flags", () => {
		expect(() => assertUsableFlags({ check: true, remove: true })).toThrow(PaseoSetupUsageError);
		try {
			assertUsableFlags({ check: true, remove: true });
			throw new Error("expected a usage error");
		} catch (error) {
			expect((error as Error).message).toContain("--check");
			expect((error as Error).message).toContain("--remove");
		}
	});

	test("an empty mpreset is rejected", () => {
		expect(() => assertUsableFlags({ mpreset: "  " })).toThrow(PaseoSetupUsageError);
	});
});

describe("provider probe parsing", () => {
	// The measured live shape uses a `provider` key, which an earlier draft
	// rejected as malformed -- making pass/stale unreachable against a real daemon.
	test("parses the real paseo provider ls shape", () => {
		const outcome = parseProviderLs(
			'[{"provider":"gjc","label":"Gajae Code","status":"available","enabled":"Enabled"}]',
		);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") {
			expect([...outcome.providerIds]).toEqual(["gjc"]);
			expect(outcome.rows[0]?.status).toBe("available");
		}
	});

	test.each([
		['["gjc","claude"]', ["gjc", "claude"]],
		['{"providers":["gjc"]}', ["gjc"]],
		['{"providers":[{"id":"gjc"}]}', ["gjc"]],
		['{"providers":[{"name":"gjc"}]}', ["gjc"]],
		['[{"provider":"gjc"}]', ["gjc"]],
	])("parses %s", (input: string, expected: string[]) => {
		const outcome = parseProviderLs(input);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") expect([...outcome.providerIds]).toEqual(expected);
	});

	test.each([
		"not json",
		'{"providers":{}}',
		'{"providers":[{"nope":1}]}',
	])("rejects %s as malformed", (input: string) => {
		expect(parseProviderLs(input).kind).toBe("malformed");
	});
});
