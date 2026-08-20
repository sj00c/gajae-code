/**
 * Top-level orchestration for `gjc setup paseo`.
 *
 * Dispatches to diagnosis, install, or removal, and owns the flag combinations
 * that must be rejected before any target is touched.
 */
import * as path from "node:path";
import { Settings } from "../../config/settings";
import { checkPaseoSetup } from "./check";
import { type CompletedStep, compensate, receiptStep, recoverIntent, runJsonStep, SagaStepError } from "./install-saga";
import { PaseoPublishError, readTarget } from "./json-publisher";
import { createOrchestrationSeed, removeSeededRoles } from "./orchestration-preferences";
import { withPaseoMutationLock } from "./paseo-mutation-lock";
import { type ProvenanceLedger, readProvenance, writeProvenance } from "./paseo-ownership";
import {
	buildProviderEntry,
	createProviderMutation,
	hasProviderConflict,
	providerEntryHash,
	providerKeyFor,
	resolveGjcCommand,
} from "./provider-config";
import { removePaseoSetup, safeBridgeEntryNames, validatedBridgeDir } from "./remove";
import type { PaseoInstallResult, PaseoRemoveResult, SetupCheckResult } from "./result-types";
import type { PaseoSetupDependencies } from "./setup-deps";
import {
	installSkillsBridge,
	inverseSkillsBridge,
	legacyRecordedSourceDir,
	preflightSkillsBridge,
	registerSkillsBridgeDirectory,
} from "./skills-bridge";

export interface PaseoSetupFlags {
	readonly check?: boolean;
	readonly json?: boolean;
	readonly force?: boolean;
	readonly remove?: boolean;
	readonly mpreset?: string;
}

export class PaseoSetupUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaseoSetupUsageError";
	}
}

export type PaseoSetupOutcome =
	| { readonly kind: "check"; readonly result: SetupCheckResult }
	| { readonly kind: "install"; readonly result: PaseoInstallResult }
	| { readonly kind: "remove"; readonly result: PaseoRemoveResult };

/**
 * Reject flag combinations that have no coherent meaning.
 *
 * Rejected before any read or write so a misuse can never leave partial state.
 */
export function assertUsableFlags(flags: PaseoSetupFlags): void {
	if (flags.check && flags.remove) {
		throw new PaseoSetupUsageError(
			"--check and --remove cannot be combined: --check only reports, --remove mutates.",
		);
	}
	if (flags.mpreset !== undefined && flags.mpreset.trim() === "") {
		throw new PaseoSetupUsageError("--mpreset requires a preset name.");
	}
}

export async function runPaseoSetup(flags: PaseoSetupFlags, deps: PaseoSetupDependencies): Promise<PaseoSetupOutcome> {
	assertUsableFlags(flags);

	if (flags.check) {
		const result = await checkPaseoSetup(deps, { mpreset: flags.mpreset, force: flags.force });
		return { kind: "check", result };
	}

	if (flags.remove) {
		// `--check` is read-only and needs no lock. Install and remove mutate the
		// same intent record, provenance ledger, Paseo config targets, bridge, and
		// GJC settings, so both hold one per-agent-directory mutation lock from
		// recovery through the final provenance write: a concurrent remove cannot
		// clear the ledger while an install is still creating links and
		// registering the bridge.
		return await withPaseoMutationLock(deps, async () => {
			const settings = await Settings.init();
			const ledger = await readProvenance(deps.paths.provenanceLedger);
			// Unregister the LEDGER-RECORDED directory (the one GJC actually
			// registered at install time); after a path migration this can differ
			// from the current default bridge path.
			const recordedBridgeDir = ledger.bridgePath ?? deps.paths.bridgeDir;
			const result = await removePaseoSetup(deps, {
				now: deps.now(),
				unregisterBridgeDirectory: async () => {
					await unregisterBridgeDirectory(settings, recordedBridgeDir);
					if (recordedBridgeDir !== deps.paths.bridgeDir) {
						await unregisterBridgeDirectory(settings, deps.paths.bridgeDir).catch(() => undefined);
					}
				},
			});
			return { kind: "remove", result };
		});
	}

	return {
		kind: "install",
		result: await withPaseoMutationLock(deps, () => installPaseoSetup(flags, deps)),
	};
}

/**
 * Run the four-step install saga.
 *
 * Preflight happens first and is entirely read-only, so the common failure
 * cases (unparseable config, a conflicting entry, an unresolvable executable, a
 * foreign file sitting at one of our bridge names) all abort before anything is
 * written and therefore need no compensation.
 */
async function installPaseoSetup(flags: PaseoSetupFlags, deps: PaseoSetupDependencies): Promise<PaseoInstallResult> {
	const now = deps.now();

	// An interrupted earlier run must be settled before starting a new one. A
	// discardable intent is cleared here; a `complete-ledger` intent whose ledger
	// contents are unknown to this run is reported rather than guessed at, and
	// the steps below re-derive and commit the same provenance anyway.
	const recovery = await recoverIntent(deps.paths.intentRecord, { repair: true });
	if (recovery && !recovery.recovered) {
		return {
			outcome: "partial-install",
			compensated: [],
			uncompensated: [deps.paths.intentRecord],
			evidence: { failedStep: "intent-recovery", detail: recovery.detail, retained: [deps.paths.intentRecord] },
		};
	}

	const resolution = resolveGjcCommand();
	if (!resolution.ok) {
		throw new PaseoSetupUsageError(
			`Cannot register GJC with Paseo: ${resolution.detail}. Paseo needs an absolute command path, so GJC will not write a bare 'gjc' string.`,
		);
	}

	const providerKey = providerKeyFor(flags.mpreset);
	const entry = buildProviderEntry(resolution.command, flags.mpreset);

	const config = await readTarget(deps.paths.configJson);
	const conflict = hasProviderConflict(config.parsed, providerKey, entry);
	if (conflict.conflict && !flags.force) {
		throw new PaseoSetupUsageError(`${conflict.detail} Re-run with --force to overwrite it.`);
	}

	const preferences = await readTarget(deps.paths.orchestrationPreferences);
	const seed = createOrchestrationSeed(preferences.parsed);
	const bridgePreflight = await preflightSkillsBridge(deps);

	const completed: CompletedStep[] = [];
	const changed: string[] = [];
	const entryHash = providerEntryHash(entry);

	try {
		// Step 1: provider entry + provider-key provenance.
		//
		// Ownership is decided by what existed BEFORE this run, not by value
		// equality: an identical entry the user hand-wrote stays theirs (marked
		// pre-existing, never recorded in providerKeys), while a `--force`
		// overwrite stores the replaced entry so `--remove` restores it rather
		// than deleting content that was never GJC's to take.
		const existingProviderEntry = readProviderEntry(config.parsed, providerKey);
		// Same structural equality the conflict check uses, so ownership follows
		// the exact predicate that decides whether GJC would write anything.
		const existingMatches =
			existingProviderEntry !== undefined && JSON.stringify(existingProviderEntry) === JSON.stringify(entry);
		const replacedEntry = existingProviderEntry !== undefined && !existingMatches ? existingProviderEntry : undefined;
		const step1 = await runJsonStep({
			label: deps.paths.configJson,
			step: "provider-config",
			targetPath: deps.paths.configJson,
			provenancePath: deps.paths.provenanceLedger,
			intentPath: deps.paths.intentRecord,
			ownedKeys: [`agents.providers.${providerKey}`],
			mutate: createProviderMutation(config, providerKey, entry),
			nextLedger: ledger => ({
				...ledger,
				providerKeys: existingMatches
					? { ...ledger.providerKeys }
					: { ...ledger.providerKeys, [providerKey]: entryHash },
				providerPreexistingKeys: existingMatches
					? { ...ledger.providerPreexistingKeys, [providerKey]: true as const }
					: { ...ledger.providerPreexistingKeys },
				providerReplacedEntries: replacedEntry
					? { ...ledger.providerReplacedEntries, [providerKey]: replacedEntry }
					: { ...ledger.providerReplacedEntries },
			}),
			revert: draft => removeProviderKey(draft, providerKey),
			revertLedger: ledger => {
				const providerKeys = { ...ledger.providerKeys };
				delete providerKeys[providerKey];
				const providerPreexistingKeys = { ...ledger.providerPreexistingKeys };
				delete providerPreexistingKeys[providerKey];
				const providerReplacedEntries = { ...ledger.providerReplacedEntries };
				delete providerReplacedEntries[providerKey];
				return { ...ledger, providerKeys, providerPreexistingKeys, providerReplacedEntries };
			},
			now,
		});
		completed.push(step1.completed);
		if (step1.changed) changed.push(deps.paths.configJson);

		// Step 2: seed empty orchestration roles only.
		if (seed.seededKeys.length > 0) {
			const step2 = await runJsonStep({
				label: deps.paths.orchestrationPreferences,
				step: "orchestration-preferences",
				targetPath: deps.paths.orchestrationPreferences,
				provenancePath: deps.paths.provenanceLedger,
				intentPath: deps.paths.intentRecord,
				ownedKeys: [...seed.seededKeys],
				mutate: seed.mutate,
				nextLedger: ledger => ({
					...ledger,
					seededOrchestrationKeys: { ...ledger.seededOrchestrationKeys, ...seed.seededValues },
				}),
				// Compensation must reach the same nested map the forward step wrote.
				revert: draft => removeSeededRoles(draft, seed.seededKeys, () => true),
				revertLedger: ledger => {
					const seededOrchestrationKeys = { ...ledger.seededOrchestrationKeys };
					for (const key of seed.seededKeys) delete seededOrchestrationKeys[key];
					return { ...ledger, seededOrchestrationKeys };
				},
				now,
			});
			completed.push(step2.completed);
			if (step2.changed) changed.push(deps.paths.orchestrationPreferences);
		}

		// Step 3: the symlink bridge. Install converges the bridge to the current
		// source (create missing, prune stale, adopt pre-#4638 legacy links).
		//
		// Provenance is committed BEFORE any link is created or pruned, and the
		// ownership set is exactly what GJC will own after this run: links it
		// created in an earlier run (the pre-existing non-noop entries), links
		// it adopts through the legacy migration, and -- until the prunes
		// complete -- the stale links it is about to remove, so a crash between
		// record and unlink still leaves every on-disk link covered. A `noop`
		// entry GJC did not previously record is deliberately NOT added: an
		// exact-target link the user created themselves must never become
		// GJC-owned just because a re-run observed it.
		const bridgeLedger = await readProvenance(deps.paths.provenanceLedger);
		// Migration binding: recorded ownership belongs to the recorded bridge
		// PATH, not to the skill names alone. When the agent/profile path moved,
		// the names are not carried over silently -- a user-owned exact-target
		// link at the new path must never inherit ownership from the old one,
		// and the old path's links are cleaned up explicitly instead of being
		// abandoned by the overwrite below.
		const recordedBridgePath = bridgeLedger.bridgePath;
		const isMigration =
			recordedBridgePath !== undefined && path.resolve(recordedBridgePath) !== path.resolve(deps.paths.bridgeDir);
		let migratedOldEntries: readonly string[] = [];
		if (isMigration && (bridgeLedger.bridgeEntries?.length ?? 0) > 0) {
			const oldSourceDir = bridgeLedger.bridgeSourceDir ?? legacyRecordedSourceDir(deps.home ?? "");
			// The migration branch composes destructive cleanup paths from the
			// ledger's own bytes, so it must fail closed exactly like `--remove`
			// does: a tampered or malformed record (a `..` entry, a relative or
			// escaping bridge path) is refused, never fed to the unlinker.
			const oldBridgeDir = await validatedBridgeDir(bridgeLedger, deps);
			migratedOldEntries = safeBridgeEntryNames(bridgeLedger.bridgeEntries ?? []);
			await inverseSkillsBridge(
				deps,
				{
					createdEntries: [...migratedOldEntries],
					prunedEntries: [],
					adoptedEntries: [],
					bridgeDirCreated: bridgeLedger.bridgeDirCreated ?? false,
					sourceDir: oldSourceDir,
				},
				{ bridgeDir: oldBridgeDir },
			).catch(error => {
				throw new SagaStepError(
					"install",
					`bridge path migrated from ${recordedBridgePath} but the old bridge could not be cleaned: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}
		const previouslyRecorded = isMigration ? new Set<string>() : new Set(bridgeLedger.bridgeEntries ?? []);
		const ownedAfterRun = [
			// Entries this run or an earlier run actually creates/recreates.
			...Object.values(bridgePreflight.entries)
				.filter(entry => entry.action !== "noop" || (previouslyRecorded.has(entry.name) && entry.action === "noop"))
				.map(entry => entry.name),
			// Legacy links GJC adopts become owned at their new target.
			...bridgePreflight.adopts.map(adopt => adopt.name),
			// Prune candidates stay recorded until the unlink completes below;
			// the post-install write then drops them.
			...bridgePreflight.prunes.map(prune => prune.name),
		].filter((name, index, all) => all.indexOf(name) === index);
		const hasBridgeWork = ownedAfterRun.length > 0 || bridgePreflight.bridgeDirCreated;
		// A resolved source containing no `paseo*` skills is an intentional
		// no-bridge state: `installSkillsBridge` will create neither the
		// directory nor any link, so persisting a bridge path here would record
		// a directory GJC never created and registering it would globally load
		// whatever foreign content later appears at that path. Provenance and
		// registration are both skipped; the ledger keeps whatever it had.
		const intentionalNoBridge =
			bridgePreflight.sourceDir !== undefined &&
			ownedAfterRun.length === 0 &&
			Object.keys(bridgePreflight.entries).length === 0 &&
			bridgePreflight.adopts.length === 0 &&
			bridgePreflight.prunes.length === 0;
		if (intentionalNoBridge) {
			await writeProvenance(deps.paths.provenanceLedger, {
				...bridgeLedger,
				bridgePath: undefined,
				bridgeEntries: [],
				bridgeDirCreated: false,
				bridgeSourceDir: undefined,
			});
			return { outcome: "installed", changed: [...changed, "paseo skills bridge (empty source)"] };
		}
		if (hasBridgeWork || bridgePreflight.sourceDir !== undefined) {
			await writeProvenance(deps.paths.provenanceLedger, {
				...bridgeLedger,
				bridgePath: deps.paths.bridgeDir,
				bridgeEntries: ownedAfterRun,
				// `bridgeDirCreated` records whether GJC created THIS directory
				// originally, so `--remove` knows whether the empty directory is
				// ours to delete. It is per-path ownership: a migration to a new
				// directory resets it (the old directory's creator bit was cleaned
				// up with the old bridge above), and a convergence run over an
				// existing directory never rewrites a previous `true` to `false`.
				bridgeDirCreated: isMigration
					? bridgePreflight.bridgeDirCreated
					: bridgeLedger.bridgeDirCreated === true || bridgePreflight.bridgeDirCreated,
				...(bridgePreflight.sourceDir !== undefined ? { bridgeSourceDir: bridgePreflight.sourceDir } : {}),
			});
		}
		const bridge = await installSkillsBridge(bridgePreflight);
		// Prunes have completed: drop them from the ownership record so a later
		// `--remove` does not treat the removed names as still owned.
		if (bridgePreflight.prunes.length > 0) {
			const afterPrunes = await readProvenance(deps.paths.provenanceLedger);
			await writeProvenance(deps.paths.provenanceLedger, {
				...afterPrunes,
				bridgeEntries: (afterPrunes.bridgeEntries ?? []).filter(name => !bridge.prunedEntries.includes(name)),
			});
		}
		if (
			bridge.createdEntries.length > 0 ||
			bridge.prunedEntries.length > 0 ||
			bridge.adoptedEntries.length > 0 ||
			bridge.bridgeDirCreated
		) {
			changed.push(deps.paths.bridgeDir);
			completed.push({
				label: deps.paths.bridgeDir,
				undo: async () => {
					try {
						await inverseSkillsBridge(deps, bridge);
						return { status: "reverted" as const };
					} catch (error) {
						return {
							status: "conflict" as const,
							detail: error instanceof Error ? error.message : String(error),
							retained: [deps.paths.bridgeDir],
						};
					}
				},
			});
		}

		// Step 4: register the bridge with GJC skill discovery -- only when the
		// bridge was validated against a real source this run. Registering an
		// existing directory that no source validates and no ledger owns would
		// globally load whatever a stale or foreign bridge contains.
		if (bridgePreflight.sourceDir === undefined && !ledgerOwnsBridge(bridgeLedger)) {
			throw new SagaStepError(
				"install",
				`Refusing to register Paseo skills bridge without a validated source or ownership record (${deps.paths.bridgeDir}); re-run after Paseo is installed or point PASEO_SKILLS_DIR at the real skills directory`,
			);
		}
		const settings = await Settings.init();
		const receipt = await registerSkillsBridgeDirectory(settings, deps.paths.bridgeDir);
		completed.push(receiptStep("config.yml skills.customDirectories", receipt));
		changed.push("config.yml skills.customDirectories");
	} catch (error) {
		const failure =
			error instanceof SagaStepError
				? error
				: new SagaStepError(
						"install",
						error instanceof PaseoPublishError || error instanceof Error ? error.message : String(error),
					);
		const outcome = await compensate(completed, failure);
		return { outcome: "partial-install", ...outcome };
	}

	return { outcome: "installed", changed };
}

/** True when the ledger proves GJC owns the current bridge directory and its entries. */
function ledgerOwnsBridge(ledger: ProvenanceLedger): boolean {
	return (ledger.bridgeEntries?.length ?? 0) > 0 && ledger.bridgePath !== undefined;
}
/** The provider entry a Paseo config carries at `key`, if any. */
function readProviderEntry(config: Record<string, unknown>, providerKey: string): Record<string, unknown> | undefined {
	const agents = config.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	const entry = (providers as Record<string, unknown>)[providerKey];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	return entry as Record<string, unknown>;
}

function removeProviderKey(draft: Record<string, unknown>, providerKey: string): void {
	const agents = draft.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
	delete (providers as Record<string, unknown>)[providerKey];
}

async function unregisterBridgeDirectory(settings: Settings, bridgeDir: string): Promise<void> {
	await settings.commitAtomicBatchWithCurrent(current => {
		const skills = current.skills;
		if (!skills || typeof skills !== "object" || Array.isArray(skills)) return [];
		const directories = (skills as Record<string, unknown>).customDirectories;
		if (!Array.isArray(directories)) return [];
		const next = directories.filter(directory => directory !== bridgeDir);
		if (next.length === directories.length) return [];
		return [{ path: "skills.customDirectories", op: "set", value: next }];
	});
}
