/**
 * Handlers for the sole account-management CLI namespace (`gjc accounts`).
 *
 * This surface deliberately consumes AuthStorage's payload-free inventory APIs.
 * Credential payloads are never rendered or copied into settings; persistent pins
 * are written as canonical `id:<row-id>` selectors only.
 */
import {
	type AuthCredentialSelector,
	type AuthStorage,
	type CredentialInventoryRecord,
	type CredentialRemovalTarget,
	OAuthCredentialSelectorError,
	type OAuthPinTarget,
	resolveOAuthStorageProvider,
} from "@gajae-code/ai/core";
import { getAgentDir } from "@gajae-code/utils";
import { ModelRegistry } from "../config/model-registry";
import { type RawSettings, Settings, type SettingsAtomicPatch } from "../config/settings";
import { discoverAuthStorage } from "../sdk/session";
import {
	buildAccountInventorySnapshot,
	checkAccountInventory,
	clearPersistentPinForRemovedRows,
} from "../session/account-inventory";
import { resolveStartupAuthConfig, type StartupAuthConfigSnapshot } from "../session/startup-auth-config";

export const ACCOUNTS_ACTIONS = ["list", "check", "pin", "logout"] as const;
export type AccountsAction = (typeof ACCOUNTS_ACTIONS)[number];

export interface AccountsCommandArgs {
	action: AccountsAction;
	provider?: string;
	selector?: string;
	flags: {
		json?: boolean;
		persistent?: boolean;
		clear?: boolean;
		account?: string;
		all?: boolean;
	};
}

class AccountsCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountsCommandError";
	}
}
export function toAccountsCommandError(error: unknown): AccountsCommandError | undefined {
	if (error instanceof OAuthCredentialSelectorError) return new AccountsCommandError(error.message);
	return undefined;
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: readonly string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function cleanReason(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	let reason = value instanceof Error ? value.message : String(value);
	reason = reason.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	reason = reason.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
	reason = reason.replace(/[\r\n\t ]+/g, " ").trim();
	if (reason.length > 256) reason = `${reason.slice(0, 253)}...`;
	return reason || undefined;
}

function canonicalProvider(provider: string | undefined): string {
	const value = provider?.trim();
	if (!value) throw new AccountsCommandError("A provider is required.");
	if (/[\u0000-\u001f\u007f]/u.test(value))
		throw new AccountsCommandError("Provider contains invalid control characters.");
	return resolveOAuthStorageProvider(value);
}

function selectorFromInput(raw: string | undefined): AuthCredentialSelector {
	const value = raw?.trim() ?? "";
	if (/^id:[1-9]\d*$/.test(value)) return { kind: "id", value: value.slice(3) };
	if (/^email:[^@\s]+@[^@\s]+$/.test(value)) return { kind: "email", value: value.slice(6) };
	if (/^account:\S+$/.test(value)) return { kind: "account", value: value.slice(8) };
	if (/^[^@\s]+@[^@\s]+$/.test(value)) return { kind: "email", value };
	throw new AccountsCommandError(
		"Pin target must be a bare email or an id:<row-id>, email:<email>, or account:<account-id> selector.",
	);
}

function inventoryIdentity(row: CredentialInventoryRecord): string | undefined {
	return typeof row.identityLabel === "string" ? row.identityLabel : undefined;
}

function formatCandidate(row: CredentialInventoryRecord): string {
	const identity = inventoryIdentity(row) ?? "(no identity)";
	return `  id=${row.id} ${identity}${row.disabled ? " [disabled]" : ""}`;
}

async function withAuthStorageAndModels<T>(
	callback: (storage: AuthStorage, modelRegistry: ModelRegistry, startupAuth: StartupAuthConfigSnapshot) => Promise<T>,
): Promise<T> {
	const startupAuth = await resolveStartupAuthConfig();
	const storage = await discoverAuthStorage(getAgentDir(), startupAuth);
	const modelRegistry = new ModelRegistry(storage);
	try {
		await modelRegistry.refresh("offline");
		return await callback(storage, modelRegistry, startupAuth);
	} finally {
		storage.close();
	}
}

async function runList(flags: AccountsCommandArgs["flags"]): Promise<void> {
	await withAuthStorageAndModels(async (storage, modelRegistry) => {
		const snapshot = buildAccountInventorySnapshot({ authStorage: storage, modelRegistry });
		const accounts = snapshot.rows;
		if (flags.json) {
			writeJson({ ok: true, generatedAt: snapshot.generatedAt, generation: snapshot.generation, accounts });
			return;
		}
		if (accounts.length === 0) {
			writeText(["No stored accounts or configured API-key sources."]);
			return;
		}
		writeText(
			accounts.map(account => {
				const identity = account.identityLabel ?? "(no identity)";
				const usage = account.usage?.freshness ?? "unknown";
				const health = account.health.status;
				return `${account.provider}\tid=${account.id}\t${account.credentialKind}\t${identity}\t${account.source}\t${
					account.disabled ? "disabled" : "active"
				}\thealth=${health}\tusage=${usage}`;
			}),
		);
	});
}

async function runCheck(providerArg: string | undefined, flags: AccountsCommandArgs["flags"]): Promise<void> {
	const provider = providerArg ? canonicalProvider(providerArg) : undefined;
	await withAuthStorageAndModels(async (storage, modelRegistry) => {
		const snapshot = await checkAccountInventory({
			authStorage: storage,
			modelRegistry,
			provider,
		});
		const checks = snapshot.rows
			.filter(row => provider === undefined || row.provider === provider)
			.map(row => ({
				id: row.id,
				provider: row.provider,
				kind: row.credentialKind,
				source: row.source,
				...(row.identityLabel ? { identity: row.identityLabel } : {}),
				ok: row.health.status === "ok" ? true : row.health.status === "failed" ? false : null,
				status: row.health.status === "ok" ? "ok" : row.health.status === "failed" ? "failed" : "unknown",
				...(cleanReason(row.health.reason) ? { reason: cleanReason(row.health.reason) } : {}),
			}));
		if (flags.json) {
			writeJson({ ok: true, ...(provider ? { provider } : {}), checks });
		} else if (checks.length === 0) {
			writeText([provider ? `No account sources for ${provider}.` : "No account sources."]);
		} else {
			writeText(
				checks.map(check => {
					const identity = check.identity ?? "(no identity)";
					const reason = check.reason ? ` — ${check.reason}` : "";
					return `${check.provider}\tid=${check.id}\t${check.kind}\t${check.source}\t${identity}\t${check.status}${reason}`;
				}),
			);
		}
		if (checks.some(check => check.ok === false)) process.exitCode = 1;
	});
}

function assertPersistent(flags: AccountsCommandArgs["flags"]): void {
	if (!flags.persistent) {
		throw new AccountsCommandError("Persistent account pinning requires --persistent.");
	}
}

function pinsFromCurrent(current: Readonly<RawSettings>): Record<string, string> {
	const auth = current.auth;
	if (auth === undefined) return {};
	const authRecord = asRecord(auth);
	if (!authRecord) throw new AccountsCommandError("Global auth configuration is malformed; no pin was written.");
	const rawPins = authRecord.credentialPins;
	if (rawPins === undefined) return {};
	const pins = asRecord(rawPins);
	if (!pins || Object.values(pins).some(value => typeof value !== "string")) {
		throw new AccountsCommandError("Global auth.credentialPins is malformed; no pin was written.");
	}
	return Object.fromEntries(Object.entries(pins).map(([key, value]) => [key, String(value).trim()]));
}

async function writePersistentPin(
	provider: string,
	selector: string | undefined,
	clear: boolean,
	credentialStoreIdentity?: string,
): Promise<void> {
	const settings = await Settings.init();
	await settings.commitAtomicBatchWithCurrent(current => {
		const pins = pinsFromCurrent(current);
		const currentAuth = asRecord(current.auth);
		const existingStoreIdentity =
			typeof currentAuth?.credentialPinStoreIdentity === "string"
				? currentAuth.credentialPinStoreIdentity.trim()
				: undefined;
		if (
			Object.values(pins).some(value => value.startsWith("id:")) &&
			credentialStoreIdentity &&
			existingStoreIdentity !== credentialStoreIdentity
		) {
			for (const [pinnedProvider, pinnedSelector] of Object.entries(pins)) {
				if (pinnedSelector.startsWith("id:")) delete pins[pinnedProvider];
			}
		}
		if (clear) delete pins[provider];
		else if (selector) pins[provider] = selector;
		const patches: SettingsAtomicPatch[] = [{ path: "auth.credentialPins", op: "set", value: pins }];
		const hasNumericPins = Object.values(pins).some(value => value.startsWith("id:"));
		if (hasNumericPins) {
			if (credentialStoreIdentity && (!existingStoreIdentity || existingStoreIdentity === credentialStoreIdentity)) {
				patches.push({ path: "auth.credentialPinStoreIdentity", op: "set", value: credentialStoreIdentity });
			} else if (!clear) {
				throw new AccountsCommandError(
					"Numeric persistent pins require a credential-store identity; no pin was written.",
				);
			}
		} else {
			patches.push({ path: "auth.credentialPinStoreIdentity", op: "unset" });
		}
		return patches;
	});
}

async function runPin(
	providerArg: string | undefined,
	selectorArg: string | undefined,
	flags: AccountsCommandArgs["flags"],
): Promise<void> {
	assertPersistent(flags);
	const provider = canonicalProvider(providerArg);
	if (flags.clear && selectorArg) {
		throw new AccountsCommandError("Use either a pin selector or --clear, not both.");
	}
	if (!flags.clear && !selectorArg) {
		throw new AccountsCommandError("Pin requires a selector, or use --clear to remove the persistent pin.");
	}
	if (flags.clear) {
		await writePersistentPin(provider, undefined, true);
		if (flags.json) writeJson({ ok: true, provider, cleared: true });
		else writeText([`Cleared persistent account pin for ${provider}.`]);
		return;
	}

	const selector = selectorFromInput(selectorArg);
	await withAuthStorageAndModels(async (storage, modelRegistry, startupAuth) => {
		if (
			!modelRegistry.getConfiguredProviderIds().includes(provider) &&
			modelRegistry.getAll().every(model => model.provider !== provider)
		) {
			throw new AccountsCommandError(`Provider ${provider} is not configured; no pin was written.`);
		}
		let target: OAuthPinTarget;
		try {
			target = storage.resolveOAuthPinTarget(provider, selector);
		} catch (error) {
			throw toAccountsCommandError(error) ?? error;
		}
		const canonicalSelector = `${target.canonicalSelector.kind}:${target.canonicalSelector.value}`;
		await writePersistentPin(provider, canonicalSelector, false, startupAuth.credentialStoreIdentity);
		if (flags.json) writeJson({ ok: true, provider, selector: canonicalSelector });
		else writeText([`Pinned ${provider} to ${canonicalSelector}.`]);
	});
}

function accountMatches(row: CredentialInventoryRecord, rawAccount: string): boolean {
	const value = rawAccount.trim();
	if (value.length === 0) return false;
	if (/^[1-9]\d*$/.test(value) && row.id === Number(value)) return true;
	const identity = inventoryIdentity(row);
	return identity?.toLowerCase() === value.toLowerCase();
}

function removalCandidates(
	inventory: readonly CredentialInventoryRecord[],
	targets: readonly CredentialRemovalTarget[],
): Array<{ row: CredentialInventoryRecord; target: CredentialRemovalTarget }> {
	const targetById = new Map(targets.map(target => [target.id, target]));
	return inventory
		.filter(row => row.credentialKind === "oauth")
		.map(row => ({ row, target: targetById.get(row.id) }))
		.filter((entry): entry is { row: CredentialInventoryRecord; target: CredentialRemovalTarget } => !!entry.target);
}

function throwLogoutResolutionError(
	provider: string,
	account: string | undefined,
	candidates: readonly { row: CredentialInventoryRecord; target: CredentialRemovalTarget }[],
): never {
	const lines =
		candidates.length > 0
			? ["Safe candidates:", ...candidates.map(candidate => formatCandidate(candidate.row))]
			: ["No OAuth account candidates found."];
	const prefix = account
		? `Account ${JSON.stringify(account)} for ${provider} was missing or ambiguous.`
		: `No removable OAuth accounts found for ${provider}.`;
	throw new AccountsCommandError(`${prefix} No credentials were removed.\n${lines.join("\n")}`);
}

async function runLogout(providerArg: string | undefined, flags: AccountsCommandArgs["flags"]): Promise<void> {
	const provider = canonicalProvider(providerArg);
	if ((flags.all ? 1 : 0) + (flags.account ? 1 : 0) !== 1) {
		throw new AccountsCommandError("Logout requires exactly one of --account <id|email> or --all.");
	}
	const startupAuth = await resolveStartupAuthConfig();
	if (startupAuth.broker) {
		throw new AccountsCommandError(
			"`gjc accounts logout` only mutates local credentials. A broker/gateway is configured; run logout on the broker host with `gjc auth-broker` or unset the broker configuration. No credentials were removed.",
		);
	}
	const storage = await discoverAuthStorage(getAgentDir(), startupAuth);
	try {
		const inventory = storage.listCredentialInventory(provider);
		const targets = removalCandidates(inventory, storage.listCredentialRemovalTargets(provider));
		const selected = flags.all
			? targets
			: targets.filter(candidate => accountMatches(candidate.row, flags.account ?? ""));
		if (selected.length !== 1 && !flags.all) throwLogoutResolutionError(provider, flags.account, targets);
		if (selected.length === 0) throwLogoutResolutionError(provider, flags.account, targets);
		const result = storage.removeAuthCredentialsHard(
			provider,
			selected.map(candidate => candidate.target),
		);
		if (result.kind !== "removed") {
			throw new AccountsCommandError(
				`Account inventory changed before logout; no credentials were removed. Retry and choose from current candidates (ids: ${result.currentIds.join(", ") || "none"}).`,
			);
		}
		const settings = await Settings.init();
		await clearPersistentPinForRemovedRows(settings, provider, inventory, result.ids);
		if (flags.json) writeJson({ ok: true, provider, removedIds: [...result.ids] });
		else
			writeText([
				`Removed ${result.ids.length} OAuth account${result.ids.length === 1 ? "" : "s"} from ${provider}.`,
			]);
	} finally {
		storage.close();
	}
}

function writeJsonFailure(error: unknown): void {
	// Machine contract: exactly one JSON document on stdout, never secrets/stacks.
	if (error instanceof AccountsCommandError) {
		writeJson({ ok: false, error: { code: "accounts-error", message: cleanReason(error) ?? "Command failed." } });
		return;
	}
	writeJson({
		ok: false,
		error: { code: "internal-error", message: "Accounts command failed; see stderr for diagnostics." },
	});
}

export async function runAccountsCommand(cmd: AccountsCommandArgs): Promise<void> {
	try {
		switch (cmd.action) {
			case "list":
				await runList(cmd.flags);
				return;
			case "check":
				await runCheck(cmd.provider, cmd.flags);
				return;
			case "pin":
				await runPin(cmd.provider, cmd.selector, cmd.flags);
				return;
			case "logout":
				await runLogout(cmd.provider, cmd.flags);
				return;
			default: {
				const exhaustive: never = cmd.action;
				throw new AccountsCommandError(`Unknown accounts action: ${String(exhaustive)}`);
			}
		}
	} catch (error) {
		if (cmd.flags.json) {
			if (!(error instanceof AccountsCommandError)) {
				process.stderr.write(`accounts command failed: ${cleanReason(error) ?? "Command failed."}\n`);
			}
			process.exitCode = 1;
			writeJsonFailure(error);
			return;
		}
		if (error instanceof AccountsCommandError) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
}

export { AccountsCommandError };
