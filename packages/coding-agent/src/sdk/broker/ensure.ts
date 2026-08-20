import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { SdkClient } from "../client/client";
import { type BrokerDiscovery, brokerProcessIncarnation, readBrokerDiscovery } from "./discovery";
import {
	resolveSdkInternalSpawnCommand,
	resolveSdkPackageAuthority,
	type SdkInternalSpawnCommand,
	type SdkPackageAuthority,
} from "./runtime";
import { BrokerStartupError, clearBrokerStartupFailureMarker, readBrokerStartupFailureMarker } from "./startup-failure";
export interface EnsureBrokerSettings {
	agentDir: string;
	heartbeatTtlMs?: number;
	/**
	 * Environment for the spawned detached broker. Defaults to `process.env`; tests
	 * that pre-start an isolated broker pass the same sanitized child env so the
	 * broker and the child that attaches to it share one owned root.
	 */
	env?: NodeJS.ProcessEnv;
	/**
	 * Generation of the package this process would spawn (see runtime.ts). A live
	 * broker publishing a different generation predates the current install — it
	 * loaded its code before the package was replaced — and is retired before a
	 * fresh broker is spawned. Omitted: ensureBroker resolves the current generation.
	 */
	expectedPackageGeneration?: string;
	/** Ordered package identity captured with the expected generation. */
	expectedPackageVersion?: string;
	/** Canonical installation identity captured with the expected generation. */
	expectedInstallationIdentity?: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const FIXTURE_DISCOVERY_TIMEOUT_MS = 30_000;
// Bounded grace windows for reaping a spawned broker on failure, mirroring the
// owned-process teardown convention (SIGTERM -> grace -> SIGKILL -> hard cap).
const REAP_GRACEFUL_MS = 2_000;
const REAP_SIGKILL_CAP_MS = 2_000;

/**
 * Tail of the detached broker's stderr folded into a discovery failure.
 *
 * The broker used to spawn with `stdio: "ignore"`, so a broker that exited
 * cleanly told the caller nothing beyond `code=0` (#3963). Its stderr goes to a
 * file instead of a pipe because the child is detached and outlives this
 * process: a pipe would break under it the moment the parent exits.
 */
export const BROKER_SPAWN_LOG_TAIL_BYTES = 4_096;

export interface BrokerSpawnLog {
	path: string;
	handle: FileHandle;
}

function brokerSpawnLogPath(agentDir: string): string {
	return path.join(agentDir, "sdk", `broker-spawn.${randomUUID()}.log`);
}

/** Opens an isolated, bounded-lifetime diagnostic sink for one broker spawn. */
export async function openBrokerSpawnLog(agentDir: string): Promise<BrokerSpawnLog | undefined> {
	try {
		await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true, mode: 0o700 });
		const spawnLogPath = brokerSpawnLogPath(agentDir);
		return { path: spawnLogPath, handle: await fs.open(spawnLogPath, "w", 0o600) };
	} catch {
		// Diagnostics are never allowed to block a broker spawn.
		return undefined;
	}
}

export async function readBrokerSpawnLogTail(spawnLogPath: string): Promise<string> {
	try {
		const file = Bun.file(spawnLogPath);
		const size = file.size;
		if (!Number.isFinite(size) || size <= 0) return "";
		const tail = size > BROKER_SPAWN_LOG_TAIL_BYTES ? file.slice(size - BROKER_SPAWN_LOG_TAIL_BYTES) : file;
		return (await tail.text()).trim();
	} catch {
		return "";
	}
}

async function removeBrokerSpawnLog(spawnLogPath: string): Promise<void> {
	try {
		await fs.unlink(spawnLogPath);
	} catch {
		// Diagnostics are best-effort and must not affect broker ownership.
	}
}
export interface FixtureBrokerLease {
	/** Backward-compatible fixture cleanup alias for exact child termination. */
	close(): Promise<void>;
}

export interface ExactFixtureBrokerLease extends FixtureBrokerLease {
	/** Observes the retained child only; it never signals a process. */
	waitForExit(timeoutMs: number): Promise<boolean>;
	/** Signals only the retained ChildProcess, never a discovery-derived PID. */
	terminateExactChild(): Promise<void>;
}

export interface FixtureBrokerCommand {
	file: string;
	args: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface StartedFixtureBrokerCommand {
	lease: ExactFixtureBrokerLease;
	control: NodeJS.WritableStream;
}

export interface StartedFixtureBroker {
	discovery: BrokerDiscovery;
	lease: ExactFixtureBrokerLease;
}

interface BrokerOwner {
	stop(): Promise<void>;
	canReuse(discovery: BrokerDiscovery | null): boolean;
	markReady(discovery: BrokerDiscovery): boolean;
}
type EnsureInitiator = "discovery" | "fixture-lease";
type EnsureOutcome =
	| { kind: "external-discovery"; discovery: BrokerDiscovery }
	| { kind: "prior-local-owner"; discovery: BrokerDiscovery; owner: BrokerOwner }
	| { kind: "local-started-discovery"; discovery: BrokerDiscovery }
	| { kind: "local-started-fixture"; discovery: BrokerDiscovery; owner: BrokerOwner; child: ChildProcess };
interface EnsureInFlight {
	initiator: EnsureInitiator;
	expectedPackageGeneration: string;
	expectedPackageVersion: string;
	expectedInstallationIdentity: string;
	promise: Promise<EnsureOutcome>;
	discovery: Promise<BrokerDiscovery>;
}
const owners = new Map<string, BrokerOwner>();
const ensureInFlight = new Map<string, EnsureInFlight>();
const reapErrorGuards = new WeakSet<ChildProcess>();
interface ReapTiming {
	gracefulMs: number;
	killVerifyMs: number;
}
const DEFAULT_REAP_TIMING: ReapTiming = {
	gracefulMs: REAP_GRACEFUL_MS,
	killVerifyMs: REAP_SIGKILL_CAP_MS,
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Terminate and reap a detached broker this process spawned, targeting the exact
 * owned {@link ChildProcess} (never by name). SIGTERM escalates to SIGKILL after
 * a bounded grace window; a child still alive after SIGKILL is surfaced rather
 * than silently orphaned. Reaping is idempotent once the child has exited.
 *
 * Termination is proven only by an observed exit — an `exit`/`close` event or a
 * non-null `exitCode`/`signalCode`. A still-live child can emit `error` during
 * teardown (e.g. a transient signal-delivery failure); that is diagnostic only
 * and never counts as exit, so the escalation cannot be skipped mid-shutdown.
 */
async function reapSpawnedBroker(child: ChildProcess, timing: ReapTiming = DEFAULT_REAP_TIMING): Promise<void> {
	// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
	// undefined and there is nothing to signal or await. The `error` event is the
	// only signal and is diagnostic here — termination trivially holds, so do not
	// run out the TERM/KILL windows or report a stuck child that never existed.
	if (child.pid === undefined) return;
	// Reaping owns repeated teardown diagnostics too. Keep exactly one error
	// listener for the retained child so a later signal-delivery error cannot
	// become an unhandled EventEmitter error after the spawn listener is consumed.
	if (!reapErrorGuards.has(child)) {
		child.on("error", () => {});
		reapErrorGuards.add(child);
	}

	// Awaits an authoritative exit signal, never a transient `error`. Resolves on
	// an `exit`/`close` event or when the codes are already set; the caller
	// re-checks the codes after the race, so resolution alone is never proof.
	const awaitVerifiedExit = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else {
			child.once("exit", () => resolve());
			child.once("close", () => resolve());
		}
		return promise;
	};
	// Observed exit is authoritative: only non-null exit/signal codes prove the
	// child is gone, regardless of which event (if any) resolved the wait.
	const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
	const signal = (sig: NodeJS.Signals): void => {
		if (hasExited()) return;
		try {
			child.kill(sig);
		} catch {
			// already exited between the liveness check and the kill
		}
	};
	if (hasExited()) return;
	signal("SIGTERM");
	await Promise.race([awaitVerifiedExit(), sleep(timing.gracefulMs)]);
	if (hasExited()) return;
	signal("SIGKILL");
	await Promise.race([awaitVerifiedExit(), sleep(timing.killVerifyMs)]);
	if (hasExited()) return;
	// SIGKILL is uninterruptible; a child still alive past this bounded wait is a
	// kernel-level stuck state. Surface it rather than silently orphaning the spawn.
	throw new Error(`Detached SDK broker (pid ${child.pid}) did not exit after SIGKILL during reap.`);
}

function registerBrokerOwner(
	agentDir: string,
	child: ChildProcess,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): BrokerOwner {
	const incarnation = child.pid === undefined ? undefined : brokerProcessIncarnation(child.pid);
	let state: "starting" | "ready" | "cleanup-unverified" = "starting";
	const matches = (discovery: BrokerDiscovery | null): boolean =>
		Boolean(
			discovery &&
				child.pid !== undefined &&
				incarnation &&
				discovery.pid === child.pid &&
				discovery.incarnation === incarnation,
		);
	const owner: BrokerOwner = {
		async stop(): Promise<void> {
			try {
				await reapSpawnedBroker(child, timing);
			} catch (error) {
				state = "cleanup-unverified";
				throw error;
			}
			if (owners.get(agentDir) === owner) owners.delete(agentDir);
		},
		canReuse(discovery): boolean {
			return state === "ready" && matches(discovery);
		},
		markReady(discovery): boolean {
			if (!matches(discovery)) return false;
			state = "ready";
			return true;
		},
	};
	owners.set(agentDir, owner);
	return owner;
}
function brokerSpawnEnvironment(command: SdkInternalSpawnCommand, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...(override ?? command.env) };
	delete environment.BUN_OPTIONS;
	if (command.kind === "bun-source") {
		delete environment.PI_COMPILED;
		delete environment.GJC_COMPILED;
	}
	return environment;
}

function fixtureLeaseUnavailable(): Error {
	return new Error("fixture_broker_lease_unavailable");
}

function createFixtureLeaseFromChild(child: ChildProcess, terminate: () => Promise<void>): ExactFixtureBrokerLease {
	let termination: Promise<void> | undefined;
	const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
	const waitForExit = (timeoutMs: number): Promise<boolean> => {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
			return Promise.reject(new Error("Invalid fixture broker exit timeout."));
		if (hasExited()) return Promise.resolve(true);
		return new Promise(resolve => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onExit = (): void => finish(true);
			const finish = (exited: boolean): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				child.off("exit", onExit);
				child.off("close", onExit);
				resolve(exited && hasExited());
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			child.once("exit", onExit);
			child.once("close", onExit);
			if (hasExited()) finish(true);
		});
	};
	return {
		waitForExit,
		terminateExactChild(): Promise<void> {
			if (!termination) termination = terminate();
			return termination;
		},
		close(): Promise<void> {
			if (!termination) termination = terminate();
			return termination;
		},
	};
}

function createFixtureLease(owner: BrokerOwner, child: ChildProcess): ExactFixtureBrokerLease {
	return createFixtureLeaseFromChild(child, () => owner.stop());
}

/**
 * Grace window for a stale-generation broker to exit after its shutdown request.
 * Kept short: the caller is mid-launch and a wedged broker must degrade to reuse,
 * not block the spawn path.
 */
const STALE_BROKER_SHUTDOWN_TIMEOUT_MS = 2_000;

/** Sends SIGTERM only through an OS process reference bound to the published incarnation. */
function signalExactBroker(pid: number, incarnation: string): boolean {
	try {
		if (pid === process.pid) return false;
		const processRef = nativeProcessBindings().Process.fromPid(pid);
		if (!processRef || processRef.incarnation !== incarnation) return false;
		const signal = os.constants.signals.SIGTERM;
		if (signal === undefined) return false;
		return processRef.signalRoot(signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "EACCES" || code === "EIO") throw error;
		return false;
	}
}

function comparePackageVersions(left: string, right: string): number | undefined {
	const parse = (value: string): { numbers: [number, number, number]; prerelease: string[] } | undefined => {
		const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
		if (!match) return undefined;
		return {
			numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
			prerelease: match[4] ? match[4].split(".") : [],
		};
	};
	const leftParsed = parse(left);
	const rightParsed = parse(right);
	if (!leftParsed || !rightParsed) return undefined;
	for (let index = 0; index < leftParsed.numbers.length; index++) {
		if (leftParsed.numbers[index] !== rightParsed.numbers[index])
			return leftParsed.numbers[index] < rightParsed.numbers[index] ? -1 : 1;
	}
	if (leftParsed.prerelease.length === 0 || rightParsed.prerelease.length === 0) {
		if (leftParsed.prerelease.length === rightParsed.prerelease.length) return 0;
		return leftParsed.prerelease.length === 0 ? 1 : -1;
	}
	for (let index = 0; index < Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length); index++) {
		const leftIdentifier = leftParsed.prerelease[index];
		const rightIdentifier = rightParsed.prerelease[index];
		if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1;
		const leftNumeric = /^\d+$/.test(leftIdentifier);
		const rightNumeric = /^\d+$/.test(rightIdentifier);
		if (leftNumeric && rightNumeric) {
			const leftNumber = Number(leftIdentifier);
			const rightNumber = Number(rightIdentifier);
			if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
		} else if (leftNumeric !== rightNumeric) {
			return leftNumeric ? -1 : 1;
		} else if (leftIdentifier !== rightIdentifier) {
			return leftIdentifier < rightIdentifier ? -1 : 1;
		}
	}
	return 0;
}

function canRetireStaleBroker(stale: BrokerDiscovery, authority: SdkPackageAuthority): boolean {
	if (!stale.packageVersion || !stale.installationIdentity) return false;
	if (stale.installationIdentity !== authority.installationIdentity) return false;
	return comparePackageVersions(stale.packageVersion, authority.packageVersion) === -1;
}

function sameBrokerIdentity(left: BrokerDiscovery, right: BrokerDiscovery): boolean {
	return (
		left.pid === right.pid &&
		left.incarnation === right.incarnation &&
		left.ownerId === right.ownerId &&
		left.token === right.token &&
		left.url === right.url
	);
}

function hasCompletePackageAuthority(discovery: BrokerDiscovery): boolean {
	return typeof discovery.packageVersion === "string" && typeof discovery.installationIdentity === "string";
}

function isAuthorizedBrokerEndpoint(discovery: BrokerDiscovery): boolean {
	try {
		const endpoint = new URL(discovery.url);
		return (
			endpoint.protocol === "ws:" &&
			endpoint.hostname === "127.0.0.1" &&
			endpoint.hostname === discovery.host &&
			endpoint.port === String(discovery.port) &&
			endpoint.username === "" &&
			endpoint.password === "" &&
			endpoint.pathname === "/" &&
			endpoint.search === "" &&
			endpoint.hash === ""
		);
	} catch {
		return false;
	}
}

/**
 * Stop a live broker whose published generation differs from the package this
 * process would spawn. The authenticated `broker.shutdown` op is tried first;
 * brokers that predate the op (or fail transport) take an identity-fenced
 * SIGTERM instead. Retirement is best-effort, but a mismatched discovery that
 * remains published is never returned to a lifecycle caller.
 */
async function retireStaleBroker(
	agentDir: string,
	stale: BrokerDiscovery,
	expectedPackageGeneration: string,
	heartbeatTtlMs?: number,
): Promise<boolean> {
	const preflightAuthority = resolveSdkPackageAuthority({ force: true });
	if (preflightAuthority.generation !== expectedPackageGeneration) return false;
	const legacy = !hasCompletePackageAuthority(stale);
	if (!legacy && !canRetireStaleBroker(stale, preflightAuthority)) return false;
	const currentBeforeConnect = await readBrokerDiscovery(agentDir, heartbeatTtlMs);
	if (!currentBeforeConnect || !sameBrokerIdentity(currentBeforeConnect, stale)) return false;
	if (!isAuthorizedBrokerEndpoint(currentBeforeConnect)) return false;
	try {
		if (legacy) throw new Error("legacy broker discovery requires signal fallback");
		const client = await SdkClient.connect(stale.url, stale.token, {
			timeoutMs: STALE_BROKER_SHUTDOWN_TIMEOUT_MS,
			reconnectAttempts: 0,
		});
		try {
			await client.global("broker.shutdown", {});
		} finally {
			await client.close().catch(() => {});
		}
	} catch {
		// RPC unreachable or unknown_operation (broker predates the shutdown op):
		// Re-read both installation authority and the publication identity immediately
		// before signaling. A replacement or package mutation must never be targeted.
		const currentAuthority = resolveSdkPackageAuthority({ force: true });
		if (currentAuthority.generation !== expectedPackageGeneration) return false;
		if (!legacy && !canRetireStaleBroker(stale, currentAuthority)) return false;
		const current = await readBrokerDiscovery(agentDir, heartbeatTtlMs);
		if (!current) return true;
		if (!sameBrokerIdentity(current, stale)) return true;
		if (!isAuthorizedBrokerEndpoint(current)) return false;
		if (!signalExactBroker(stale.pid, stale.incarnation)) return false;
	}
	const deadline = Date.now() + STALE_BROKER_SHUTDOWN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await readBrokerDiscovery(agentDir, heartbeatTtlMs);
		if (!current || current.pid !== stale.pid || current.incarnation !== stale.incarnation) return true;
		await sleep(50);
	}
	return false;
}

function matchesExpectedPackageGeneration(
	discovery: BrokerDiscovery,
	expectedPackageGeneration: string | undefined,
	expectedPackageVersion: string | undefined,
	expectedInstallationIdentity: string | undefined,
): boolean {
	return (
		expectedPackageGeneration === undefined ||
		(isAuthorizedBrokerEndpoint(discovery) &&
			discovery.packageGeneration === expectedPackageGeneration &&
			(expectedPackageVersion === undefined || discovery.packageVersion === expectedPackageVersion) &&
			(expectedInstallationIdentity === undefined ||
				discovery.installationIdentity === expectedInstallationIdentity))
	);
}

function staleBrokerRetirementUnverified(
	expectedPackageGeneration: string,
	actualPackageGeneration: string | undefined,
): Error {
	return new Error(
		`SDK broker package generation ${actualPackageGeneration ?? "unknown"} does not match expected generation ${expectedPackageGeneration}, and stale broker retirement was not verified.`,
	);
}

async function retireAndReadReplacement(
	settings: EnsureBrokerSettings,
	stale: BrokerDiscovery,
): Promise<BrokerDiscovery | undefined> {
	const expectedPackageGeneration = settings.expectedPackageGeneration;
	if (expectedPackageGeneration === undefined) return stale;
	const authority = resolveSdkPackageAuthority({ force: true });
	if (authority.generation !== expectedPackageGeneration)
		throw new Error(
			`SDK broker package generation changed before retirement: expected ${expectedPackageGeneration}, resolved ${authority.generation}.`,
		);
	if (
		(settings.expectedPackageVersion !== undefined && settings.expectedPackageVersion !== authority.packageVersion) ||
		(settings.expectedInstallationIdentity !== undefined &&
			settings.expectedInstallationIdentity !== authority.installationIdentity)
	)
		throw new Error("SDK broker package installation identity changed before retirement.");
	if (hasCompletePackageAuthority(stale)) {
		if (!canRetireStaleBroker(stale, authority))
			throw staleBrokerRetirementUnverified(authority.generation, stale.packageGeneration);
	} else if (stale.packageGeneration === expectedPackageGeneration) {
		throw staleBrokerRetirementUnverified(authority.generation, stale.packageGeneration);
	}
	const retired = await retireStaleBroker(
		settings.agentDir,
		stale,
		expectedPackageGeneration,
		settings.heartbeatTtlMs,
	);
	if (!retired) throw staleBrokerRetirementUnverified(expectedPackageGeneration, stale.packageGeneration);
	const replacement = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
	if (!replacement) return undefined;
	const currentPackageGeneration = resolveSdkPackageAuthority({ force: true }).generation;
	if (currentPackageGeneration !== expectedPackageGeneration)
		throw new Error(
			`SDK broker package generation changed during retirement: expected ${expectedPackageGeneration}, resolved ${currentPackageGeneration}.`,
		);
	const currentAuthorityAfterRetirement = resolveSdkPackageAuthority({ force: true });
	if (
		matchesExpectedPackageGeneration(
			replacement,
			currentPackageGeneration,
			currentAuthorityAfterRetirement.packageVersion,
			currentAuthorityAfterRetirement.installationIdentity,
		)
	)
		return replacement;
	throw staleBrokerRetirementUnverified(currentPackageGeneration, replacement.packageGeneration);
}

async function ensureBrokerOnce(settings: EnsureBrokerSettings, initiator: EnsureInitiator): Promise<EnsureOutcome> {
	const priorOwner = owners.get(settings.agentDir);
	const existing = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
	if (initiator === "fixture-lease" && (priorOwner || existing)) throw fixtureLeaseUnavailable();
	if (priorOwner) {
		// A retained cleanup failure fences every discovery record. Only a ready
		// record bound to this exact child incarnation may be reused.
		if (
			priorOwner.canReuse(existing) &&
			existing !== null &&
			matchesExpectedPackageGeneration(
				existing,
				settings.expectedPackageGeneration,
				settings.expectedPackageVersion,
				settings.expectedInstallationIdentity,
			)
		)
			return { kind: "prior-local-owner", discovery: existing, owner: priorOwner };
		await priorOwner.stop();
		const discoveredAfterCleanup = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (discoveredAfterCleanup) {
			if (
				matchesExpectedPackageGeneration(
					discoveredAfterCleanup,
					settings.expectedPackageGeneration,
					settings.expectedPackageVersion,
					settings.expectedInstallationIdentity,
				)
			)
				return { kind: "external-discovery", discovery: discoveredAfterCleanup };
			const replacement = await retireAndReadReplacement(settings, discoveredAfterCleanup);
			if (replacement) return { kind: "external-discovery", discovery: replacement };
		}
	} else if (existing) {
		const accepted = matchesExpectedPackageGeneration(
			existing,
			settings.expectedPackageGeneration,
			settings.expectedPackageVersion,
			settings.expectedInstallationIdentity,
		);
		const stale = settings.expectedPackageGeneration !== undefined && !accepted;
		if (!stale) return { kind: "external-discovery", discovery: existing };
		const replacement = await retireAndReadReplacement(settings, existing);
		if (replacement) return { kind: "external-discovery", discovery: replacement };
	}

	const command = resolveSdkInternalSpawnCommand("broker-internal");
	if (settings.expectedPackageGeneration !== undefined && command.generation !== settings.expectedPackageGeneration)
		throw new Error(
			`SDK broker package generation changed during startup: expected ${settings.expectedPackageGeneration}, resolved ${command.generation}.`,
		);
	const spawnLog = await openBrokerSpawnLog(settings.agentDir);
	// A stale marker must never be misattributed to this spawn; clear it first.
	await clearBrokerStartupFailureMarker(settings.agentDir);
	try {
		const environment = brokerSpawnEnvironment(command, settings.env);
		environment.GJC_SDK_PACKAGE_GENERATION = command.generation;
		if (command.packageVersion) environment.GJC_SDK_PACKAGE_VERSION = command.packageVersion;
		if (command.installationIdentity) environment.GJC_SDK_INSTALLATION_IDENTITY = command.installationIdentity;
		const child = spawn(command.file, [...command.args, "--agent-dir", settings.agentDir], {
			detached: true,
			stdio: ["ignore", "ignore", spawnLog ? spawnLog.handle.fd : "ignore"],
			env: environment,
			...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
		});
		// The child holds its own duplicate of the descriptor; this one is done.
		await spawnLog?.handle.close();
		child.unref();
		let spawnError: Error | undefined;
		child.once("error", error => {
			spawnError = error;
		});
		const owner = registerBrokerOwner(settings.agentDir, child);
		const discoveryTimeoutMs = initiator === "fixture-lease" ? FIXTURE_DISCOVERY_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS;
		const deadline = Date.now() + discoveryTimeoutMs;
		let discoveryError: unknown;
		while (Date.now() < deadline) {
			if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
			try {
				const discovered = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
				if (discovered) {
					if (
						!matchesExpectedPackageGeneration(
							discovered,
							settings.expectedPackageGeneration,
							settings.expectedPackageVersion,
							settings.expectedInstallationIdentity,
						)
					) {
						await owner.stop();
						throw staleBrokerRetirementUnverified(
							settings.expectedPackageGeneration!,
							discovered.packageGeneration,
						);
					}
					if (owner.markReady(discovered)) {
						return initiator === "fixture-lease"
							? { kind: "local-started-fixture", discovery: discovered, owner, child }
							: { kind: "local-started-discovery", discovery: discovered };
					}
					await owner.stop();
					return { kind: "external-discovery", discovery: discovered };
				}
			} catch (error) {
				discoveryError = error;
			}
			await sleep(50);
		}
		const exitedBeforeDiscovery = child.exitCode !== null || child.signalCode !== null;
		if (exitedBeforeDiscovery && child.exitCode === 0) {
			// A clean exit means another broker won the ownership lock (two ACP
			// processes racing a cold broker state, e.g. a provider probe and an
			// agent launch). The winner may publish its discovery right after our
			// last poll; reuse it instead of failing the caller. Transient discovery
			// read failures fall through to the common cleanup + failure path below.
			try {
				for (let retry = 0; retry < 20; retry++) {
					const winner = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
					if (winner) {
						if (
							!matchesExpectedPackageGeneration(
								winner,
								settings.expectedPackageGeneration,
								settings.expectedPackageVersion,
								settings.expectedInstallationIdentity,
							)
						)
							throw staleBrokerRetirementUnverified(
								settings.expectedPackageGeneration!,
								winner.packageGeneration,
							);
						await owner.stop();
						return { kind: "external-discovery", discovery: winner };
					}
					await sleep(50);
				}
			} catch {
				// fall through to cleanup + failure
			}
		}
		const spawnLogTail = exitedBeforeDiscovery && spawnLog ? await readBrokerSpawnLogTail(spawnLog.path) : "";
		const marker = await readBrokerStartupFailureMarker(settings.agentDir);
		// A marker only wins over the generic fallback when it was written by the
		// exact child this call just spawned and reaped. The pre-spawn clear
		// already prevents an old marker from surviving to this point, but a
		// concurrent broker (a foreign process racing the same agent dir) could
		// still write a marker between the clear and this read; the pid binding
		// rejects that marker instead of misattributing a foreign failure to this
		// spawn's caller.
		const trustedMarker = marker && child.pid !== undefined && marker.pid === child.pid ? marker : undefined;
		const failure = spawnError
			? new Error(`Failed to spawn detached SDK broker: ${spawnError.message}`)
			: exitedBeforeDiscovery
				? new BrokerStartupError({
						exitCode: child.exitCode,
						signal: child.signalCode,
						reason: trustedMarker?.reason ?? "Detached SDK broker exited before publishing discovery.",
						stderrExcerpt: spawnLogTail.length > 0 ? spawnLogTail : undefined,
					})
				: discoveryError
					? discoveryError
					: new Error("Timed out waiting for detached SDK broker discovery.");
		try {
			await owner.stop();
		} catch (cleanupError) {
			throw new AggregateError(
				[failure, cleanupError],
				"SDK broker discovery and spawned broker cleanup both failed.",
			);
		}
		throw failure;
	} finally {
		if (spawnLog) await removeBrokerSpawnLog(spawnLog.path);
	}
}

function startEnsure(settings: EnsureBrokerSettings, initiator: EnsureInitiator): EnsureInFlight {
	const promise = ensureBrokerOnce(settings, initiator);
	const discovery = promise.then(outcome => outcome.discovery);
	void discovery.catch(() => {});
	const entry = {
		initiator,
		expectedPackageGeneration: settings.expectedPackageGeneration!,
		expectedPackageVersion: settings.expectedPackageVersion!,
		expectedInstallationIdentity: settings.expectedInstallationIdentity!,
		promise,
		discovery,
	};
	ensureInFlight.set(settings.agentDir, entry);
	const clear = (): void => {
		if (ensureInFlight.get(settings.agentDir) === entry) ensureInFlight.delete(settings.agentDir);
	};
	void promise.then(clear, clear);
	return entry;
}

function normalizeEnsureSettings(settings: EnsureBrokerSettings): EnsureBrokerSettings {
	const authority = resolveSdkPackageAuthority();
	return {
		...settings,
		expectedPackageGeneration: settings.expectedPackageGeneration ?? authority.generation,
		expectedPackageVersion: settings.expectedPackageVersion ?? authority.packageVersion,
		expectedInstallationIdentity: settings.expectedInstallationIdentity ?? authority.installationIdentity,
	};
}

/** Starts the detached broker entrypoint when discovery has no live owner. */
export function ensureBroker(settings: EnsureBrokerSettings): Promise<BrokerDiscovery> {
	const normalized = normalizeEnsureSettings(settings);
	const inFlight = ensureInFlight.get(normalized.agentDir) ?? startEnsure(normalized, "discovery");
	if (
		inFlight.expectedPackageGeneration === normalized.expectedPackageGeneration &&
		inFlight.expectedPackageVersion === normalized.expectedPackageVersion &&
		inFlight.expectedInstallationIdentity === normalized.expectedInstallationIdentity
	)
		return inFlight.discovery;
	return inFlight.discovery.then(discovery => {
		if (
			matchesExpectedPackageGeneration(
				discovery,
				normalized.expectedPackageGeneration,
				normalized.expectedPackageVersion,
				normalized.expectedInstallationIdentity,
			)
		)
			return discovery;
		throw staleBrokerRetirementUnverified(normalized.expectedPackageGeneration!, discovery.packageGeneration);
	});
}

/** Starts one fresh fixture broker and returns its sole exact-child close lease. */
export function startFixtureBrokerWithLeaseForTest(settings: EnsureBrokerSettings): Promise<StartedFixtureBroker> {
	const normalized = normalizeEnsureSettings(settings);
	if (ensureInFlight.has(normalized.agentDir)) return Promise.reject(fixtureLeaseUnavailable());
	const inFlight = startEnsure(normalized, "fixture-lease");
	return inFlight.promise.then(outcome => {
		if (outcome.kind !== "local-started-fixture") throw fixtureLeaseUnavailable();
		return { discovery: outcome.discovery, lease: createFixtureLease(outcome.owner, outcome.child) };
	});
}

/**
 * Test-only launch surface for topology fixtures. It accepts an already-resolved
 * command and retains the exact spawned child; no production selection path
 * reaches this function.
 */
export function startFixtureBrokerCommandWithLeaseForTest(command: FixtureBrokerCommand): StartedFixtureBrokerCommand {
	if (!command.file || !Array.isArray(command.args)) throw new Error("Invalid fixture broker command.");
	const child = spawn(command.file, [...command.args], {
		cwd: command.cwd,
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "pipe"],
		env: command.env,
	});
	child.unref();
	let spawnError: Error | undefined;
	child.once("error", error => {
		spawnError = error;
	});
	const control = child.stdio[3];
	if (!control || typeof (control as NodeJS.WritableStream).write !== "function") {
		try {
			if (!child.kill("SIGKILL"))
				throw new Error(
					"Fixture broker fd 3 is unavailable and the exact child could not be synchronously terminated.",
				);
		} catch (reapError) {
			throw new AggregateError(
				[reapError],
				"Fixture broker fd 3 is unavailable and the exact child could not be synchronously terminated.",
			);
		}
		if (spawnError) throw new Error(`Failed to spawn fixture broker: ${spawnError.message}`);
		throw new Error("Fixture broker fd 3 is unavailable.");
	}
	return {
		lease: createFixtureLeaseFromChild(child, async () => {
			await reapSpawnedBroker(child);
			if (spawnError) throw new Error(`Failed to spawn fixture broker: ${spawnError.message}`);
		}),
		control: control as NodeJS.WritableStream,
	};
}

/** Test hook: returns a stop handle for the detached broker this process spawned. */
export function brokerOwnerForTest(agentDir: string): BrokerOwner | undefined {
	return owners.get(agentDir);
}
/** Test hook: exercise the identity-fenced stale-broker signal fallback. */
export function signalExactBrokerForTest(pid: number, incarnation: string): boolean {
	return signalExactBroker(pid, incarnation);
}
/** Test hook: validates ordered same-install retirement authority. */
export function canRetireStaleBrokerForTest(stale: BrokerDiscovery, authority: SdkPackageAuthority): boolean {
	return canRetireStaleBroker(stale, authority);
}
/** Test hook: validates the full authority tuple used for spawned discoveries and race winners. */
export function matchesExpectedBrokerAuthorityForTest(
	discovery: BrokerDiscovery,
	expectedPackageGeneration: string,
	expectedPackageVersion: string,
	expectedInstallationIdentity: string,
): boolean {
	return matchesExpectedPackageGeneration(
		discovery,
		expectedPackageGeneration,
		expectedPackageVersion,
		expectedInstallationIdentity,
	);
}
/** Test hook: drives the detached-broker reap on a controllable child surface. */
export function reapSpawnedBrokerForTest(child: ChildProcess, timing: ReapTiming = DEFAULT_REAP_TIMING): Promise<void> {
	return reapSpawnedBroker(child, timing);
}
/** Test hook: resolves the complete broker environment without spawning. */
export function brokerSpawnEnvironmentForTest(
	command: SdkInternalSpawnCommand,
	override?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return brokerSpawnEnvironment(command, override);
}
/** Test hook: installs an exact controllable owner to exercise replacement fencing. */
export function registerBrokerOwnerForTest(
	agentDir: string,
	child: ChildProcess,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): BrokerOwner {
	return registerBrokerOwner(agentDir, child, timing);
}
