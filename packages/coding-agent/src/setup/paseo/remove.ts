/**
 * Provenance-gated rollback for `gjc setup paseo --remove`.
 *
 * Removal never deletes on value-equality alone. A key is removed only when
 * GJC's own ledger recorded creating it AND the current value still hashes to
 * what GJC wrote. A user who hand-authored the same value, or who edited ours
 * afterwards, keeps their content.
 *
 * Steps are undone in reverse of the install order (4 to 1). The first step
 * that cannot be undone safely halts the rest, so the result is an
 * interpretable prefix rather than a scattered mix.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { planPublish, publishPlan, readTarget } from "./json-publisher";
import { removeSeededRoles } from "./orchestration-preferences";
import type { ProvenanceLedger } from "./paseo-ownership";
import {
	EMPTY_LEDGER,
	isProvenancedOrchestrationKey,
	isProvenancedProvider,
	provenancedProviderKeys,
	readProvenance,
	writeProvenance,
} from "./paseo-ownership";
import { type PaseoProviderEntry, providerEntryHash } from "./provider-config";
import type { PartialRemovalEvidence, PaseoRemoveResult } from "./result-types";
import type { PaseoSetupDependencies } from "./setup-deps";
import { inverseSkillsBridge, legacyRecordedSourceDir, SkillsBridgeError } from "./skills-bridge";

export interface RemoveOptions {
	readonly now: Date;
	/** Undo the config.yml `skills.customDirectories` append. Supplied by the orchestrator. */
	readonly unregisterBridgeDirectory?: () => Promise<void>;
}
/**
 * `lstat` distinguishing a genuinely absent path from a filesystem failure.
 *
 * A permission or I/O error on the bridge directory must NOT be collapsed into
 * "absent": treating it as absence clears all bridge provenance and reports a
 * successful removal while an owned link is still on disk. Only `ENOENT` counts
 * as absent; every other error propagates and fails the removal closed.
 */
async function lstatAllowingAbsent(destination: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
/** The directory the ledger says GJC created links in; the current path only when the ledger predates the record. */
function bridgeDirOf(ledger: ProvenanceLedger, deps: PaseoSetupDependencies): string {
	return ledger.bridgePath ?? deps.paths.bridgeDir;
}

/**
 * Remove every target GJC can prove it owns.
 *
 * Returns `nothing-to-remove` when the ledger holds no ownership at all, which
 * is distinct from removing zero keys because the user edited all of them.
 */
export async function removePaseoSetup(
	deps: PaseoSetupDependencies,
	options: RemoveOptions,
): Promise<PaseoRemoveResult> {
	const ledger = await readProvenance(deps.paths.provenanceLedger);
	const ownsAnything =
		provenancedProviderKeys(ledger).length > 0 ||
		Object.keys(ledger.seededOrchestrationKeys).length > 0 ||
		(ledger.bridgeEntries?.length ?? 0) > 0;
	if (!ownsAnything) return { outcome: "nothing-to-remove" };

	const removed: string[] = [];
	const remaining: string[] = [];
	let nextLedger = ledger;

	// Step 4 inverse: config.yml registration.
	if (options.unregisterBridgeDirectory) {
		try {
			await options.unregisterBridgeDirectory();
			removed.push("config.yml skills.customDirectories");
		} catch (error) {
			return partial(removed, ["config.yml skills.customDirectories"], {
				failedStep: "config.yml skills.customDirectories",
				detail: error instanceof Error ? error.message : String(error),
				retained: [deps.paths.provenanceLedger],
			});
		}
	}

	// Step 3 inverse: the symlink bridge.
	if (ledger.bridgeEntries && ledger.bridgeEntries.length > 0) {
		try {
			// The ledger once filtered entries through a compiled-in name
			// allowlist; ownership is now proven by the entry itself being a
			// symlink that still resolves into the source directory the ledger
			// recorded when the link was created. A name Paseo no longer ships
			// is still removed, because the record -- not today's source
			// contents -- is what proves GJC created it.
			const bridgeDir = bridgeDirOf(ledger, deps);
			const createdEntries: string[] = [];
			for (const name of ledger.bridgeEntries) {
				if (path.basename(name) !== name || name.includes("/")) continue;
				const destination = path.join(bridgeDir, name);
				const stat = await lstatAllowingAbsent(destination);
				if (stat?.isSymbolicLink() === true) createdEntries.push(name);
			}
			// A recorded source directory is trusted even after it disappears
			// (Paseo uninstalled): link-text verification does not need it on
			// disk, and the links are inside GJC's own bridge directory. A
			// legacy ledger that predates `bridgeSourceDir` falls back to the
			// single location a pre-#4638 install could have linked from, so a
			// machine wedged by #4638 can still be rolled back.
			const sourceDir = ledger.bridgeSourceDir ?? legacyRecordedSourceDir(deps.home ?? "");
			await inverseSkillsBridge(
				deps,
				{
					createdEntries,
					prunedEntries: [],
					adoptedEntries: [],
					bridgeDirCreated: ledger.bridgeDirCreated ?? false,
					sourceDir,
				},
				// Unlink, directory cleanup, and diagnostics all operate on the
				// ledger-recorded directory the entries above were validated in.
				{ bridgeDir },
			);
			removed.push(bridgeDir);
			nextLedger = { ...nextLedger, bridgeEntries: [], bridgeDirCreated: false, bridgeSourceDir: undefined };
		} catch (error) {
			const detail = error instanceof SkillsBridgeError ? error.message : String(error);
			remaining.push(bridgeDirOf(ledger, deps));
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: bridgeDirOf(ledger, deps),
				detail,
				retained: [deps.paths.provenanceLedger],
			});
		}
	}

	// Step 2 inverse: seeded orchestration roles.
	const seededKeys = Object.keys(nextLedger.seededOrchestrationKeys);
	if (seededKeys.length > 0) {
		// Roles live under `providers`, so removal must reach into that map. Deleting
		// a top-level key would clear our provenance while leaving the role pointing
		// at the provider entry we are about to delete.
		const outcome = await revertJson(deps.paths.orchestrationPreferences, options.now, draft =>
			removeSeededRoles(draft, seededKeys, (key, currentValue) =>
				isProvenancedOrchestrationKey(nextLedger, key, currentValue ?? ""),
			),
		);
		if (!outcome.ok) {
			remaining.push(deps.paths.orchestrationPreferences);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: deps.paths.orchestrationPreferences,
				detail: outcome.detail,
				retained: [deps.paths.provenanceLedger],
			});
		}
		removed.push(deps.paths.orchestrationPreferences);
		nextLedger = { ...nextLedger, seededOrchestrationKeys: {} };
	}

	// Step 1 inverse: provider entries, including every earlier `--mpreset` run.
	const providerKeys = provenancedProviderKeys(nextLedger);
	if (providerKeys.length > 0) {
		const survivors: Record<string, string> = {};
		const outcome = await revertJson(deps.paths.configJson, options.now, draft => {
			const providers = providersOf(draft);
			if (!providers) return;
			for (const key of providerKeys) {
				const entry = providers[key];
				if (entry === undefined) continue;
				const hash = providerEntryHash(entry as PaseoProviderEntry);
				if (isProvenancedProvider(nextLedger, key, hash)) delete providers[key];
				else survivors[key] = nextLedger.providerKeys[key] ?? hash;
			}
		});
		if (!outcome.ok) {
			remaining.push(deps.paths.configJson);
			await writeProvenance(deps.paths.provenanceLedger, nextLedger);
			return partial(removed, remaining, {
				failedStep: deps.paths.configJson,
				detail: outcome.detail,
				retained: [deps.paths.provenanceLedger],
			});
		}
		removed.push(deps.paths.configJson);
		nextLedger = { ...nextLedger, providerKeys: survivors };
	}

	const stillOwns =
		Object.keys(nextLedger.providerKeys).length > 0 || Object.keys(nextLedger.seededOrchestrationKeys).length > 0;
	await writeProvenance(deps.paths.provenanceLedger, stillOwns ? nextLedger : EMPTY_LEDGER);
	return { outcome: "removed", removed };
}

function providersOf(draft: Record<string, unknown>): Record<string, unknown> | undefined {
	const agents = draft.agents;
	if (!agents || typeof agents !== "object" || Array.isArray(agents)) return undefined;
	const providers = (agents as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	return providers as Record<string, unknown>;
}

async function revertJson(
	targetPath: string,
	now: Date,
	mutate: (draft: Record<string, unknown>) => void,
): Promise<{ ok: true } | { ok: false; detail: string }> {
	try {
		const current = await readTarget(targetPath);
		if (!current.exists) return { ok: true };
		const plan = planPublish(current, mutate);
		await publishPlan(targetPath, plan, { expectedIdentity: current.identity, backup: true, now });
		return { ok: true };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function partial(
	removed: readonly string[],
	remaining: readonly string[],
	evidence: PartialRemovalEvidence,
): PaseoRemoveResult {
	return { outcome: "partial-removal", removed, remaining, evidence };
}
