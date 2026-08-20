/**
 * Cross-process mutation lock for `gjc setup paseo` install/remove.
 *
 * `setup paseo` and `setup paseo --remove` mutate the same intent record,
 * provenance ledger, Paseo config targets, symlink bridge, and GJC settings.
 * Without serialization a concurrent remove can clear the ledger while an
 * install is still creating links and registering the bridge: the live links
 * end up with no provenance, and a later `--remove` reports
 * `nothing-to-remove`. One lock per agent directory covers recovery, target
 * updates, bridge operations, settings registration, and the final provenance
 * write for both commands.
 *
 * The lock file lives inside the same `paseo/` directory as the provenance
 * ledger, so the agent-directory root already scopes it. `withFileLock`
 * serializes contenders across processes (and async contenders inside one
 * process); a crashed holder's lock is reclaimed after its stale window.
 */

import { withFileLock } from "../../config/file-lock";
import type { PaseoSetupDependencies } from "./setup-deps";

/** Stale window for a crashed holder; a healthy install finishes well inside it. */
const STALE_MS = 60_000;

/** Total wait before giving up: a contending run is awaited, never displaced. */
const ACQUIRE_TIMEOUT_MS = 120_000;

const RETRY_DELAY_MS = 100;

export function paseoMutationLockPath(deps: PaseoSetupDependencies): string {
	return `${deps.paths.provenanceLedger}.mutation.lock`;
}

/** Run `operation` holding the per-agent-directory Paseo mutation lock. */
export async function withPaseoMutationLock<T>(deps: PaseoSetupDependencies, operation: () => Promise<T>): Promise<T> {
	const retries = Math.max(1, Math.ceil(ACQUIRE_TIMEOUT_MS / RETRY_DELAY_MS));
	return await withFileLock(paseoMutationLockPath(deps), operation, {
		staleMs: STALE_MS,
		retries,
		retryDelayMs: RETRY_DELAY_MS,
	});
}
