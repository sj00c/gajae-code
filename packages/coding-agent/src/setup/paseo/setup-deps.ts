/**
 * Injectable dependency surface for `gjc setup paseo`.
 *
 * Every module in this directory takes `PaseoSetupDependencies` explicitly so
 * tests can substitute paths, the Paseo CLI probe, and the clock without
 * module-scope mocks.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";

/** Prefix used to enumerate Paseo-owned skills when scanning for drift. */
export const PASEO_SKILL_PREFIX = "paseo";

/** Skill names GJC never bridges: `context-search` duplicates GJC's own tools. */
export const UNBRIDGED_SKILL_NAMES = ["context-search"] as const;

/**
 * Where Paseo keeps its skills.
 *
 * A CLI install materializes `~/.agents/skills`; a desktop app ships them inside
 * the app bundle. The bridge reads whichever exists and never writes either.
 */
export interface PaseoSkillSource {
	/** Absolute directory holding Paseo's skill folders. */
	readonly dir: string;
	/** `"user"` (`~/.agents/skills`) or `"app-bundle"` (inside a Paseo.app). */
	readonly origin: "user" | "app-bundle";
}

/** Default Paseo desktop app names, both install roots, in order. */
const PASEO_APP_NAMES = ["Paseo.app", "Paseo Beta.app", "Paseo Nightly.app"] as const;

/** Every app-bundle skills directory to probe. Bounded: a fixed list, never a search. */
export function paseoAppSkillsCandidates(home: string = os.homedir()): readonly string[] {
	const roots = process.platform === "darwin" ? ["/Applications", path.join(home, "Applications")] : [];
	const candidates: string[] = [];
	for (const root of roots) {
		for (const app of PASEO_APP_NAMES) {
			candidates.push(path.join(root, app, "Contents", "Resources", "skills"));
		}
	}
	return candidates;
}

/**
 * Resolve the directory Paseo's skills live in.
 *
 * `PASEO_SKILLS_DIR` overrides discovery for relocated bundles and tests; it is
 * honored only when absolute and present, so a stale variable can never produce
 * dangling bridge links. `~/.agents/skills` wins over an app bundle because it
 * is the user-visible location GJC documented. Returns `undefined` when no
 * source directory exists at all -- the bridge is skipped, never guessed at.
 */
export async function resolvePaseoSkillsSource(home: string = os.homedir()): Promise<PaseoSkillSource | undefined> {
	const override = process.env.PASEO_SKILLS_DIR;
	if (override !== undefined && path.isAbsolute(override) && (await isDirectory(override))) {
		return { dir: path.resolve(override), origin: "app-bundle" };
	}
	const userDir = path.join(home, ".agents", "skills");
	if (await isDirectory(userDir)) return { dir: userDir, origin: "user" };
	for (const candidate of paseoAppSkillsCandidates(home)) {
		if (await isDirectory(candidate)) return { dir: candidate, origin: "app-bundle" };
	}
	return undefined;
}

async function isDirectory(candidate: string): Promise<boolean> {
	try {
		return (await fs.stat(candidate)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Base provider key written into `agents.providers`. */
export const PROVIDER_KEY = "gjc";

/** Paseo's undocumented provider inheritance contract, reverse-engineered from a hand-written config. */
export const PROVIDER_EXTENDS = "acp";

/**
 * Role keys Paseo stores under `providers` in `orchestration-preferences.json`.
 *
 * Verified against a live file: the roles are nested, not top-level, and the
 * sibling `preferences` array belongs to the user.
 */
export const ORCHESTRATION_ROLE_KEYS = ["impl", "ui", "research", "planning", "audit"] as const;

export interface PaseoPaths {
	/** `~/.paseo/config.json` */
	readonly configJson: string;
	/** `~/.paseo/orchestration-preferences.json` */
	readonly orchestrationPreferences: string;
	/**
	 * Paseo's skills directory -- READ-ONLY, never written by this setup.
	 * Resolved per run via `resolvePaseoSkillsSource`: `~/.agents/skills` for a
	 * CLI install, the app bundle for a desktop install, `undefined` when absent.
	 */
	readonly agentsSkillsDir?: string;
	/** `<agentDir>/paseo-skills` -- the bridge directory this setup owns. */
	readonly bridgeDir: string;
	/** `<agentDir>/paseo/provenance.json` -- GJC-side ownership ledger. */
	readonly provenanceLedger: string;
	/** `<agentDir>/paseo/intent.json` -- durable crash-recovery intent record. */
	readonly intentRecord: string;
	/** `<agentDir>/skills` -- second protected tree, never written by this setup. */
	readonly gjcSkillsDir: string;
}

/** A provider row as `paseo provider ls --json` reports it. */
export interface PaseoProviderRow {
	readonly id: string;
	/** Paseo reports `"available"` for a provider it can actually reach. */
	readonly status?: string;
}

/** Distinct outcomes of probing `paseo provider ls --json`. Never collapsed into a boolean. */
export type PaseoLsOutcome =
	| { readonly kind: "ok"; readonly providerIds: readonly string[]; readonly rows: readonly PaseoProviderRow[] }
	| { readonly kind: "unavailable"; readonly detail: string }
	| { readonly kind: "timeout"; readonly timeoutMs: number }
	| { readonly kind: "malformed"; readonly detail: string }
	| { readonly kind: "nonzero-exit"; readonly exitCode: number; readonly detail: string };

export interface PaseoSetupDependencies {
	readonly paths: Omit<PaseoPaths, "agentsSkillsDir">;
	/** Bounded probe of the Paseo daemon. MUST enforce `timeoutMs` and kill the child on expiry. */
	runProviderLs(timeoutMs: number): Promise<PaseoLsOutcome>;
	now(): Date;
	/**
	 * Resolve Paseo's skills directory. Injectable so tests stay hermetic;
	 * defaults to the real discovery order (`PASEO_SKILLS_DIR`, `~/.agents/skills`,
	 * a Paseo.app bundle).
	 */
	readonly skillsSource?: () => Promise<PaseoSkillSource | undefined>;
	/** Home directory used to derive the legacy pre-#4638 bridge source. */
	readonly home?: string;
}

export function createDefaultPaseoPaths(agentDir: string = getAgentDir(), home: string = os.homedir()): PaseoPaths {
	const paseoHome = path.join(home, ".paseo");
	return {
		configJson: path.join(paseoHome, "config.json"),
		orchestrationPreferences: path.join(paseoHome, "orchestration-preferences.json"),
		bridgeDir: path.join(agentDir, "paseo-skills"),
		provenanceLedger: path.join(agentDir, "paseo", "provenance.json"),
		intentRecord: path.join(agentDir, "paseo", "intent.json"),
		gjcSkillsDir: path.join(agentDir, "skills"),
	};
}

/**
 * Probe the Paseo daemon for its registered providers.
 *
 * The daemon may be down, wedged, or a different version, so every failure mode
 * is classified rather than collapsed: `--check` maps `unavailable`/`timeout` to
 * `skipped` and must never report `drift` because the daemon did not answer.
 */
async function runProviderLs(timeoutMs: number): Promise<PaseoLsOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const child = Bun.spawn(["paseo", "provider", "ls", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (controller.signal.aborted) return { kind: "timeout", timeoutMs };
		if (exitCode !== 0) return { kind: "nonzero-exit", exitCode, detail: stderr.trim().slice(0, 500) };
		return parseProviderLs(stdout);
	} catch (error) {
		if (controller.signal.aborted) return { kind: "timeout", timeoutMs };
		return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Parse `paseo provider ls --json`.
 *
 * The measured shape is an array of `{ provider, label, status, ... }` rows.
 * `id` and `name` are also accepted because the key is undocumented and has no
 * stability guarantee, and a bare string array is accepted for the same reason.
 */
export function parseProviderLs(stdout: string): PaseoLsOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		return { kind: "malformed", detail: error instanceof Error ? error.message : String(error) };
	}
	const raw = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { providers?: unknown }).providers)
			? ((parsed as { providers: unknown[] }).providers as unknown[])
			: undefined;
	if (!raw) return { kind: "malformed", detail: "expected an array or an object carrying a providers array" };

	const rows: PaseoProviderRow[] = [];
	for (const row of raw) {
		if (typeof row === "string") {
			rows.push({ id: row });
			continue;
		}
		if (!row || typeof row !== "object") {
			return { kind: "malformed", detail: "provider entry was not an object" };
		}
		const candidate = row as { provider?: unknown; id?: unknown; name?: unknown; status?: unknown };
		const id =
			typeof candidate.provider === "string"
				? candidate.provider
				: typeof candidate.id === "string"
					? candidate.id
					: typeof candidate.name === "string"
						? candidate.name
						: undefined;
		if (id === undefined) return { kind: "malformed", detail: "provider entry carried no string id" };
		rows.push(typeof candidate.status === "string" ? { id, status: candidate.status } : { id });
	}
	return { kind: "ok", providerIds: rows.map(row => row.id), rows };
}

export function createDefaultPaseoSetupDependencies(): PaseoSetupDependencies {
	return {
		paths: createDefaultPaseoPaths(),
		runProviderLs,
		now: () => new Date(),
		skillsSource: () => resolvePaseoSkillsSource(),
		home: os.homedir(),
	};
}
