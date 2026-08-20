/**
 * Paseo skills bridge.
 *
 * The bridge mirrors Paseo's own skills into GJC skill discovery with symlinks.
 * Bridged names are derived from what the resolved source directory actually
 * contains (#4638): a Paseo release that adds or drops an orchestration skill can
 * no longer wedge `--check` into a permanently red verdict, an install whose
 * skills live inside the Paseo.app bundle is bridged the same way as one whose
 * skills live in `~/.agents/skills`, and a missing source directory skips the
 * bridge instead of publishing dangling links. Install converges the bridge to
 * the current source: it creates missing links, prunes links whose target is
 * gone, and never replaces a non-symlink entry.
 */

import * as nodeCrypto from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CasReceipt } from "../../config/atomic-yaml-patch";
import type { RawSettings, Settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import { readProvenance } from "./paseo-ownership";
import type { DriftReason } from "./result-types";
import { PASEO_SKILL_PREFIX, type PaseoSetupDependencies, type PaseoSkillSource } from "./setup-deps";

/**
 * Resolve the skills source through the injectable seam, so tests never touch a
 * real `~/.agents/skills` or app bundle. Production always supplies the default.
 */
async function resolveSource(deps: PaseoSetupDependencies): Promise<PaseoSkillSource | undefined> {
	return deps.skillsSource !== undefined ? deps.skillsSource() : undefined;
}

/** The source directory a pre-#4638 ledger's bridge entries were linked from. */
export function legacyRecordedSourceDir(home: string): string {
	return path.join(home, ".agents", "skills");
}

/**
 * Resolve the source directory recorded bridge entries were linked from,
 * preferring the ledger's own record and falling back to the single legacy
 * location a pre-#4638 install could have linked from (`~/.agents/skills`).
 *
 * Without this fallback a machine wedged by #4638 -- whose legacy ledger
 * predates `bridgeSourceDir` -- can never be migrated or removed: the
 * discovered desktop-app source is a different directory, so every recorded
 * entry looks foreign and `--remove` refuses while `--check` stays red.
 */
export async function recordedSkillsSourceDir(deps: PaseoSetupDependencies): Promise<string | undefined> {
	const ledger = await readProvenance(deps.paths.provenanceLedger);
	return ledger.bridgeSourceDir ?? legacyRecordedSourceDir(deps.home ?? "");
}

type BridgeEntryAction = "create" | "noop" | "prune-and-recreate";

type BridgeEntryPlan = {
	readonly name: string;
	readonly action: BridgeEntryAction;
	readonly linkPath: string;
	readonly targetPath: string;
	/** The dangling link text captured during preflight, used as an unlink guard. */
	readonly danglingTarget?: string;
};

/** A bridge link that no longer mirrors the source and is removed, never recreated. */
type BridgePrunePlan = {
	readonly name: string;
	readonly linkPath: string;
	/** Captured link text; the unlink is refused if it changed in between. */
	readonly linkTarget: string;
};
/** A recorded pre-#4638 link to re-point at the source the ledger records going forward. */
type BridgeAdoptPlan = {
	readonly name: string;
	readonly linkPath: string;
	readonly targetPath: string;
	/** The legacy source the link currently points at, captured during preflight. */
	readonly legacySourceDir: string;
};

/** Immutable preflight evidence consumed by the install saga and its inverse. */
export interface SkillsBridgePreflight {
	readonly bridgeDir: string;
	readonly bridgeDirCreated: boolean;
	/** Source directory the entries were derived from, absent when the bridge is skipped. */
	readonly sourceDir?: string;
	readonly entries: Readonly<Record<string, BridgeEntryPlan>>;
	/** Stale bridge links to remove so a re-run converges instead of accumulating drift. */
	readonly prunes: readonly BridgePrunePlan[];
	/** Recorded legacy links to re-point at the discovered source (pre-#4638 migration). */
	readonly adopts: readonly BridgeAdoptPlan[];
}

/** What the forward operation actually did, rather than what preflight intended to do. */
export interface SkillsBridgeInstallResult {
	readonly createdEntries: readonly string[];
	readonly prunedEntries: readonly string[];
	/** Recorded legacy links this run re-pointed at the discovered source. */
	readonly adoptedEntries: readonly string[];
	readonly bridgeDirCreated: boolean;
	/** Directory the created links point at; absent when nothing was created. */
	readonly sourceDir?: string;
}

export class SkillsBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillsBridgeError";
	}
}
/**
 * Atomically quarantine a bridge symlink and unlink it only after its identity
 * is verified POST-rename.
 *
 * A plain `lstat` → `unlink` sequence has a destructive window: another
 * process can replace the checked symlink between the two calls, and the
 * unlink then deletes the foreign replacement. Renaming the entry into a
 * GJC-owned quarantine name first closes that window -- the rename is atomic,
 * nothing is deleted until the quarantined object's link text is re-verified,
 * and a mis-captured foreign object is restored by renaming it back before the
 * error surfaces. (`exactUnlink` cannot express this for symlinks: the native
 * deliberately refuses `S_IFLNK` targets.)
 */
async function quarantineUnlinkVerified(linkPath: string, expectedTarget: string): Promise<void> {
	const quarantine = path.join(
		path.dirname(linkPath),
		`.gjc-paseo-quarantine-${process.pid}-${nodeCrypto.randomUUID()}`,
	);
	await fs.rename(linkPath, quarantine);
	let text: string;
	try {
		text = await fs.readlink(quarantine);
	} catch (error) {
		// The quarantined name is not a symlink at all (a foreign file or
		// directory was swapped onto the pathname): restore and refuse.
		void error;
		await fs.rename(quarantine, linkPath).catch(() => undefined);
		throw new SkillsBridgeError(`Paseo skill bridge entry diverged before removal: ${linkPath}`);
	}
	if (resolvedLinkTarget(text, quarantine) !== expectedTarget) {
		// The pathname was swapped between preflight and the rename: what we
		// captured is foreign. Restore it atomically and refuse.
		await fs.rename(quarantine, linkPath);
		throw new SkillsBridgeError(`Paseo skill bridge entry diverged before removal: ${linkPath}`);
	}
	await fs.unlink(quarantine);
}

/**
 * Entry names the bridge mirrors, derived from the source directory's own
 * contents: every `paseo`-prefixed directory. Plain files yield nothing, and a
 * directory symlink/junction is resolved and validated before it is bridged --
 * GJC's own skill discovery follows such links, so a symlinked skills directory
 * is a legitimate source shape. There is no name denylist: the prefix
 * (`paseo`, not `paseo-`) is the filter, so a denylisted name like
 * `context-search` fails the prefix test on its own.
 */
export async function sourceBridgeEntries(sourceDir: string): Promise<readonly string[]> {
	let entries: readonly Dirent[];
	try {
		entries = await fs.readdir(sourceDir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Only a genuinely absent source is an empty source. An unreadable one
		// (EACCES, EIO, a dangling parent during an app update) must never be
		// read as "no skills", because every recorded entry would then look
		// stale and get pruned while the bridge is actually fine.
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
	const names: string[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(PASEO_SKILL_PREFIX)) continue;
		if (entry.isDirectory()) {
			names.push(entry.name);
			continue;
		}
		// A directory symlink (or Windows junction) is a valid source shape:
		// resolve it and keep it only when it really is a directory. A dangling
		// symlink (ENOENT from stat) is absent, not foreign; any other stat
		// failure (EACCES and friends) is propagated rather than collapsed into
		// "not a directory", so an unreadable source cannot silently prune the
		// bridge entries it backs.
		if (entry.isSymbolicLink()) {
			let resolved: Stats | undefined;
			try {
				resolved = await fs.stat(path.join(sourceDir, entry.name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (resolved?.isDirectory()) names.push(entry.name);
		}
	}
	names.sort();
	return names;
}

function linkPath(deps: PaseoSetupDependencies, name: string): string {
	return path.join(deps.paths.bridgeDir, name);
}

function resolvedLinkTarget(link: string, destination: string): string {
	return path.resolve(path.dirname(destination), link);
}

async function entryState(
	destination: string,
	expected: string,
): Promise<
	| { readonly kind: "absent" }
	| { readonly kind: "expected"; readonly link: string }
	| { readonly kind: "dangling"; readonly link: string }
	| { readonly kind: "conflict" }
> {
	try {
		const stat = await fs.lstat(destination);
		if (!stat.isSymbolicLink()) return { kind: "conflict" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
	const link = await fs.readlink(destination);
	if (resolvedLinkTarget(link, destination) !== expected) return { kind: "conflict" };
	try {
		await fs.stat(destination);
		return { kind: "expected", link };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "dangling", link };
		throw error;
	}
}

/** A bridge symlink that points anywhere other than `expected`. */
async function foreignSymlinkState(
	destination: string,
): Promise<
	{ readonly kind: "absent" } | { readonly kind: "symlink"; readonly link: string } | { readonly kind: "conflict" }
> {
	try {
		const stat = await fs.lstat(destination);
		if (!stat.isSymbolicLink()) return { kind: "conflict" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
	return { kind: "symlink", link: await fs.readlink(destination) };
}

async function bridgeDirectoryState(bridgeDir: string): Promise<"absent" | "directory" | "conflict"> {
	try {
		const stat = await fs.lstat(bridgeDir);
		return stat.isDirectory() ? "directory" : "conflict";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
}

/**
 * Classify every bridge entry without mutating either skill tree.
 * All conflicts are accumulated so the caller can report them together.
 *
 * Three groups are planned:
 * - `entries`: one per source skill that should have a link (`create`, `noop`,
 *   or `prune-and-recreate` when only the link text rotted).
 * - `prunes`: recorded `paseo`-prefixed bridge entries GJC owns whose name the
 *   source no longer carries. They are removed so a re-run converges; the
 *   compensation inverse does not restore them because their target is gone by
 *   definition.
 * - `adopts`: pre-#4638 links pointing at the legacy `~/.agents/skills` source.
 *   They are re-pointed at the source the ledger will record going forward, so
 *   a machine wedged by the old allowlist converges instead of conflicting.
 *
 * Pruning is provenance-gated: an existing bridge directory is supported
 * (`bridgeDirCreated: false`), so directory creation cannot establish ownership
 * of every entry. A `paseo`-prefixed symlink GJC never recorded is foreign and
 * is reported as a conflict rather than silently removed. A non-symlink
 * occupying a `paseo`-prefixed bridge name is likewise a conflict and refuses
 * the whole plan, exactly as before.
 */
export async function preflightSkillsBridge(deps: PaseoSetupDependencies): Promise<SkillsBridgePreflight> {
	const directory = await bridgeDirectoryState(deps.paths.bridgeDir);
	if (directory === "conflict") {
		throw new SkillsBridgeError(
			`Refusing to modify Paseo skills bridge; conflicting entries: ${deps.paths.bridgeDir}`,
		);
	}
	const conflicts: string[] = [];
	const entries: Record<string, BridgeEntryPlan> = {};
	const prunes: BridgePrunePlan[] = [];
	const adopts: BridgeAdoptPlan[] = [];
	const source = await resolveSource(deps);
	const ledger = await readProvenance(deps.paths.provenanceLedger);
	const recordedEntries = new Set(ledger.bridgeEntries ?? []);
	// The recorded source decides ownership everywhere in this preflight: a name
	// in the ledger is ours only while its link still points where the ledger
	// says we put it. A ledger that predates `bridgeSourceDir` is legacy, and the
	// single location a pre-#4638 install could have linked from stands in.
	const ledgerSourceDir = ledger.bridgeSourceDir;
	const legacySourceDir = legacyRecordedSourceDir(deps.home ?? "");
	const isLegacyLedger = ledgerSourceDir === undefined;
	const ownershipSourceDir = ledgerSourceDir ?? legacySourceDir;
	if (source === undefined) {
		// No source directory anywhere: the bridge is skipped entirely. Creating
		// links into a directory that does not exist is worse than not bridging.
		return { bridgeDir: deps.paths.bridgeDir, bridgeDirCreated: directory === "absent", entries, prunes, adopts };
	}
	const sourceDir = source.dir;
	// The resolver only returns directories it verified as present, so a source
	// that is gone again by enumeration time was removed underneath this run
	// (an app update or uninstall race). That is never "an empty source": an
	// empty read here would classify every recorded entry as stale and prune a
	// healthy bridge. Fail closed and change nothing.
	try {
		const stat = await fs.stat(sourceDir);
		// An app update can replace the skills directory with a regular file (or
		// anything non-directory). Treating that as an empty source would prune
		// every recorded bridge link, so the type change itself is a refusal.
		if (!stat.isDirectory()) {
			throw new SkillsBridgeError(
				`Refusing to converge Paseo skills bridge: the resolved skills directory (${sourceDir}) is not a directory anymore; the existing bridge is left untouched`,
			);
		}
	} catch (error) {
		if (error instanceof SkillsBridgeError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		throw new SkillsBridgeError(
			`Refusing to converge Paseo skills bridge: the resolved skills directory (${sourceDir}) became unreadable (${code ?? "unknown"}); the existing bridge is left untouched`,
		);
	}
	const names = await sourceBridgeEntries(sourceDir).catch(error => {
		throw new SkillsBridgeError(
			`Refusing to converge Paseo skills bridge: the resolved skills directory (${sourceDir}) could not be read (${error instanceof Error ? error.message : String(error)}); the existing bridge is left untouched`,
		);
	});
	const wanted = new Set(names);

	for (const name of names) {
		const destination = linkPath(deps, name);
		const target = path.resolve(sourceDir, name);
		const state = directory === "absent" ? { kind: "absent" as const } : await entryState(destination, target);
		if (state.kind === "conflict") {
			// A recorded link whose text still resolves into the ownership source
			// (the ledger's own record, or the legacy location for a legacy
			// ledger) is GJC's own link, not a user hand edit: re-point it at the
			// discovered source. Adoption exists only for legacy ledgers -- a
			// ledger that already records a source must not have its links
			// silently rewritten to a different directory.
			const recorded = recordedEntries.has(name);
			const ownershipTarget = path.resolve(ownershipSourceDir, name);
			const migratable =
				recorded &&
				isLegacyLedger &&
				directory !== "absent" &&
				(await entryState(destination, ownershipTarget).then(s => s.kind !== "conflict"));
			if (!migratable) {
				conflicts.push(destination);
				continue;
			}
			adopts.push({ name, linkPath: destination, targetPath: target, legacySourceDir: ownershipSourceDir });
			continue;
		}
		entries[name] = {
			name,
			action: state.kind === "expected" ? "noop" : state.kind === "dangling" ? "prune-and-recreate" : "create",
			linkPath: destination,
			targetPath: target,
			...(state.kind === "dangling" ? { danglingTarget: state.link } : {}),
		};
	}

	if (directory !== "absent") {
		const present = await fs.readdir(deps.paths.bridgeDir, { withFileTypes: true });
		for (const entry of present) {
			if (!entry.name.startsWith(PASEO_SKILL_PREFIX)) continue;
			if (wanted.has(entry.name)) continue;
			if (adopts.some(adopt => adopt.name === entry.name)) continue;
			const destination = path.join(deps.paths.bridgeDir, entry.name);
			if (!recordedEntries.has(entry.name)) {
				// Provenance, not the prefix, proves ownership: an existing bridge
				// directory may hold entries GJC never created, and a live foreign
				// symlink is never pruned just because its name starts with `paseo`.
				conflicts.push(destination);
				continue;
			}
			const state = await foreignSymlinkState(destination);
			if (state.kind === "absent") continue;
			if (state.kind === "conflict") {
				conflicts.push(destination);
				continue;
			}
			// The same exact-target predicate `--remove` applies: a recorded
			// name is only ours while the link still points under the source the
			// ledger recorded. A user who retargeted the link at their own tree
			// keeps it -- it is reported as a conflict instead of pruned.
			if (resolvedLinkTarget(state.link, destination) !== path.resolve(ownershipSourceDir, entry.name)) {
				conflicts.push(destination);
				continue;
			}
			prunes.push({ name: entry.name, linkPath: destination, linkTarget: state.link });
		}
	}

	if (conflicts.length > 0) {
		throw new SkillsBridgeError(
			`Refusing to modify Paseo skills bridge; conflicting entries: ${conflicts.join(", ")}`,
		);
	}
	return {
		bridgeDir: deps.paths.bridgeDir,
		bridgeDirCreated: directory === "absent",
		...(source ? { sourceDir: source.dir } : {}),
		entries,
		prunes,
		adopts,
	};
}

async function createBridgeDirectory(preflight: SkillsBridgePreflight): Promise<void> {
	try {
		await fs.mkdir(preflight.bridgeDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new SkillsBridgeError(`Paseo skills bridge appeared during creation: ${preflight.bridgeDir}`);
	}
}

async function pruneRecordedDangling(entry: BridgeEntryPlan): Promise<void> {
	if (entry.danglingTarget === undefined)
		throw new SkillsBridgeError(`Missing dangling-link evidence for ${entry.linkPath}`);
	const state = await entryState(entry.linkPath, entry.targetPath);
	if (state.kind !== "dangling" || state.link !== entry.danglingTarget) {
		throw new SkillsBridgeError(`Paseo skill bridge entry diverged before pruning: ${entry.linkPath}`);
	}
	await quarantineUnlinkVerified(entry.linkPath, entry.targetPath);
}

async function createNoReplace(entry: BridgeEntryPlan): Promise<void> {
	try {
		await fs.symlink(entry.targetPath, entry.linkPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const observed = await entryState(entry.linkPath, entry.targetPath);
		throw new SkillsBridgeError(
			`Paseo skill bridge entry appeared during creation (${observed.kind}): ${entry.linkPath}`,
		);
	}
}

async function pruneStale(plan: BridgePrunePlan): Promise<void> {
	await quarantineUnlinkVerified(plan.linkPath, resolvedLinkTarget(plan.linkTarget, plan.linkPath));
}

async function adoptLegacyLink(plan: BridgeAdoptPlan, legacySourceDir: string): Promise<void> {
	// The preflight recorded this exact symlink as GJC's own legacy link; the
	// captured object is verified post-rename inside the quarantine, so a
	// pathname swap can never delete a foreign link.
	await quarantineUnlinkVerified(plan.linkPath, path.resolve(legacySourceDir, plan.name));
	await fs.symlink(plan.targetPath, plan.linkPath);
}

/** Create only preflight-approved bridge links; symlink publication never replaces an existing entry. */
export async function installSkillsBridge(preflight: SkillsBridgePreflight): Promise<SkillsBridgeInstallResult> {
	const hasWork =
		Object.keys(preflight.entries).length > 0 || preflight.prunes.length > 0 || preflight.adopts.length > 0;
	let bridgeDirCreated = false;
	if (preflight.bridgeDirCreated && hasWork) {
		await createBridgeDirectory(preflight);
		bridgeDirCreated = true;
	}
	const createdEntries: string[] = [];
	const prunedEntries: string[] = [];
	const adoptedEntries: string[] = [];
	for (const plan of preflight.prunes) {
		await pruneStale(plan);
		prunedEntries.push(plan.name);
	}
	for (const entry of Object.values(preflight.entries)) {
		if (entry.action === "noop") continue;
		if (entry.action === "prune-and-recreate") await pruneRecordedDangling(entry);
		await createNoReplace(entry);
		createdEntries.push(entry.name);
	}
	for (const adopt of preflight.adopts) {
		await adoptLegacyLink(adopt, adopt.legacySourceDir);
		adoptedEntries.push(adopt.name);
	}
	return createdEntries.length > 0 || prunedEntries.length > 0 || adoptedEntries.length > 0
		? {
				createdEntries,
				prunedEntries,
				adoptedEntries,
				bridgeDirCreated,
				...(preflight.sourceDir ? { sourceDir: preflight.sourceDir } : {}),
			}
		: { createdEntries, prunedEntries, adoptedEntries, bridgeDirCreated };
}

/**
 * Undo exactly the links this run created. A changed link is reported as a
 * conflict rather than being deleted; this makes compensation safe after edits.
 * Pruned stale links are deliberately not restored: their target is gone.
 */
export async function inverseSkillsBridge(
	deps: PaseoSetupDependencies,
	result: SkillsBridgeInstallResult,
	options: { readonly bridgeDir?: string } = {},
): Promise<void> {
	if (result.sourceDir === undefined) {
		throw new SkillsBridgeError("Refusing to undo Paseo skill bridge entries without a recorded source directory");
	}
	// Removal must operate on the SAME directory it validated. The ledger
	// records the directory GJC actually created links in; a later profile or
	// path migration must not make removal inspect the old directory while
	// unlinking from the current one.
	const bridgeDir = options.bridgeDir ?? deps.paths.bridgeDir;
	const diverged: string[] = [];
	const ownedNames = [...result.createdEntries, ...result.adoptedEntries];
	for (const name of ownedNames) {
		const destination = path.join(bridgeDir, name);
		const target = path.resolve(result.sourceDir, name);
		const state = await entryState(destination, target);
		// `dangling` still carries link text pointing exactly where we wrote it;
		// the source went away (Paseo uninstalled or updated), and a dead link in
		// GJC's own bridge directory is safe -- and correct -- to remove.
		if (state.kind !== "expected" && state.kind !== "dangling") diverged.push(destination);
	}
	if (diverged.length > 0) {
		throw new SkillsBridgeError(`Refusing to remove diverged Paseo skill bridge entries: ${diverged.join(", ")}`);
	}
	for (const name of ownedNames) {
		await quarantineUnlinkVerified(path.join(bridgeDir, name), path.resolve(result.sourceDir, name));
	}
	if (!result.bridgeDirCreated) return;
	try {
		await fs.rmdir(bridgeDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

/**
 * Drift inside GJC's own installation. Two honest signals only:
 *
 * - `orphan-skill`: a `paseo`-prefixed bridge entry that is not a live symlink
 *   into the current source. Real drift; a re-run repairs it.
 * - `missing-bridge-link`: a bridge entry the ledger says GJC created is gone
 *   from the bridge directory. Real drift in GJC's own mirror.
 *
 * A skill Paseo ships that GJC never bridged is NOT drift (#4638): the bridge
 * mirrors what GJC chose to bridge at install time, and a Paseo release adding
 * a skill must not turn `--check` red. Provenance decides what `--remove`
 * touches, not this scan.
 */
export async function scanSkillsBridgeDrift(
	deps: PaseoSetupDependencies,
	recordedEntries?: readonly string[],
): Promise<readonly DriftReason[]> {
	const reasons: DriftReason[] = [];
	const source = await resolveSource(deps);
	const bridgeEntries = await fs.readdir(deps.paths.bridgeDir, { withFileTypes: true }).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	const liveNames = new Set(bridgeEntries.map(entry => entry.name));
	for (const entry of bridgeEntries) {
		if (!entry.name.startsWith(PASEO_SKILL_PREFIX)) continue;
		const destination = path.join(deps.paths.bridgeDir, entry.name);
		if (entry.isSymbolicLink()) {
			try {
				await fs.stat(destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				reasons.push({
					code: "orphan-skill",
					subject: destination,
					detail: "bridge symlink target no longer exists",
				});
			}
			continue;
		}
		reasons.push({
			code: "orphan-skill",
			subject: destination,
			detail: "bridge entry is not a symlink; remove it or re-run gjc setup paseo",
		});
	}
	if (source === undefined) return reasons;
	// A live bridge entry pointing outside the source is drift: the bridge
	// mirrors Paseo's skills exactly, so a foreign target is a hand edit.
	for (const entry of bridgeEntries) {
		if (!entry.name.startsWith(PASEO_SKILL_PREFIX) || !entry.isSymbolicLink()) continue;
		const destination = path.join(deps.paths.bridgeDir, entry.name);
		const expected = path.resolve(source.dir, entry.name);
		const state = await foreignSymlinkState(destination);
		if (state.kind === "symlink" && resolvedLinkTarget(state.link, destination) !== expected) {
			const recorded = (recordedEntries ?? []).includes(entry.name);
			reasons.push({
				code: recorded ? "foreign-skill-link" : "orphan-skill",
				subject: destination,
				detail: recorded
					? "a recorded bridge entry does not point into the source the ledger records"
					: `bridge symlink does not point into Paseo's skills directory (${source.dir})`,
			});
		}
	}
	// Only entries GJC recorded creating can be "missing". A source skill GJC
	// never bridged is Paseo's own surface, not a hole in GJC's installation.
	for (const name of recordedEntries ?? []) {
		if (liveNames.has(name)) continue;
		if (!(await sourceBridgeEntries(source.dir)).includes(name)) continue;
		reasons.push({
			code: "missing-bridge-link",
			subject: path.join(deps.paths.bridgeDir, name),
			detail: "bridge symlink is missing",
		});
	}
	return reasons;
}

function existingCustomDirectories(current: Readonly<RawSettings>): string[] {
	const skills = current.skills;
	if (skills === undefined) return [];
	if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
		throw new SkillsBridgeError("Cannot register Paseo skills bridge: skills config is not an object.");
	}
	const directories = (skills as Record<string, unknown>).customDirectories;
	if (directories === undefined) return [];
	if (!Array.isArray(directories) || directories.some(directory => typeof directory !== "string")) {
		throw new SkillsBridgeError(
			"Cannot register Paseo skills bridge: skills.customDirectories is not a string array.",
		);
	}
	return [...directories];
}

/**
 * Register the bridge directory without discarding concurrent user config
 * changes. A path migration swaps the registration in ONE commit: the old
 * recorded path leaves `skills.customDirectories` in the same atomic batch
 * that adds the new one, so a crash can never leave both or neither, and the
 * CAS receipt restores the exact prior array on undo.
 */
export async function registerSkillsBridgeDirectory(
	settings: Settings,
	bridgeDir: string,
	options: { readonly replaces?: string } = {},
): Promise<CasReceipt> {
	return settings.commitAtomicBatchWithCurrent(current => {
		const directories = existingCustomDirectories(current);
		let next = directories;
		if (options.replaces !== undefined && options.replaces !== bridgeDir) {
			next = next.filter(directory => directory !== options.replaces);
		}
		next = next.includes(bridgeDir) ? next : [...next, bridgeDir];
		if (next.length === directories.length && next.every((directory, index) => directories[index] === directory)) {
			return [];
		}
		return [{ path: "skills.customDirectories" as SettingPath, op: "set", value: next }];
	});
}
