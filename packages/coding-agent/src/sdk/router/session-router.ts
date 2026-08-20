import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, resolveEquivalentPath } from "@gajae-code/utils";
import {
	SessionIndex as DefaultSessionIndex,
	type IndexedSession,
	isSessionAuthorityEligible,
	type SessionIndex,
} from "../broker/session-index";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { SdkClient } from "../client/client";
import { readSdkBrokerDiscovery, readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";
import {
	type ActivatedPreparedSession,
	type PreparedSessionActivationClient,
	requestPreparedSessionActivation,
	SessionActivationError,
} from "../session-activation";
import { ACP_SESSION_RECONNECT, SESSION_REQUEST_TIMEOUT_MS } from "../session-reconnect";

/**
 * Exact identity of one attached SDK session endpoint. Providers persist it next to
 * their conversation state and re-prove it before every resume, so it must be derived
 * in exactly one place: a caller that recomputes the digest by hand silently stops
 * matching the moment the bound fields change.
 */
export function sessionAttachmentAuthorityId(input: {
	sessionId: string;
	generation: number;
	pid: number;
	endpointMtimeMs: number | undefined;
	url: string;
	token: string;
}): string {
	const endpointAuthorityDigest = crypto
		.createHash("sha256")
		.update(JSON.stringify({ url: input.url, token: input.token }))
		.digest("hex");
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
				endpointAuthorityDigest,
			}),
		)
		.digest("hex");
}

/** The only capability a provider may retain for an attached SDK session. */
export interface SessionAttachment {
	readonly sessionId: string;
	readonly authorityId?: string;
	/** Current Router-owned transport identity for this exact attachment's reverse leases. */
	readonly connectionId?: string;
	readonly generation: number;
	isCurrent(): boolean;
	send(frame: Record<string, unknown>): unknown;
	/** Revoke this exact capability after provider admission or replay fails closed. */
	retire?(): Promise<void>;
}

/**
 * Provider-local notification capability. This is deliberately not an
 * attachment lease: it carries no endpoint, connection, generation, or
 * authority identity and its cancellation can only stop this subscription.
 */
export interface NotificationSubscription {
	readonly sessionId: string;
	readonly subscriptionId: string;
	readonly cursor: { readonly generation: number; readonly seq: number };
	readonly isActive: () => boolean;
	readonly send: (frame: Record<string, unknown>) => unknown;
	readonly advanceCursor: (generation: number, seq: number) => void;
	readonly cancel: (reason?: string) => void;
}

export type NotificationCleanupState = "pending" | "failed" | "completed";

export interface NotificationCleanupReceipt {
	readonly subscriptionId: string;
	readonly sessionId: string;
	readonly state: NotificationCleanupState;
	readonly reason?: string;
}

/** The transport surface Router keeps private behind its attachment capabilities. */
export interface SessionRouterClient {
	onFrame(handler: (frame: Record<string, unknown>) => void): () => void;
	onReconnect?(handler: () => void): () => void;
	connect?(): Promise<void>;
	request(frame: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
	/** Current private transport connection identity, surfaced only through its exact attachment. */
	readonly connectionId?: string;

	close(): Promise<void>;
	send(frame: Record<string, unknown>): void;
}

/** One frame after the caller's envelope/payload identity correlation. */
export interface SessionRouterFrame {
	readonly body: Record<string, unknown>;
	readonly name: string | undefined;
	readonly sessionId: string | undefined;
	readonly generation: number | undefined;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly publicationId?: string;
	readonly seq?: number;
}

export type SessionRouterFrameCorrelator = (frame: Record<string, unknown>) => SessionRouterFrame | undefined;

export interface SessionRouterDeps {
	createClient?: (authority: {
		readonly sessionId: string;
		readonly generation: number;
		readonly pid: number;
		readonly endpointMtimeMs: number;
	}) => Promise<SessionRouterClient>;
	createIndex?: (agentDir: string) => SessionIndex;
	createBrokerClient?: () => Promise<SessionRouterClient>;
	/** Receives only an opaque capability and correlated provider-neutral frames. */
	onFrame?: (attachment: SessionAttachment, frame: SessionRouterFrame) => Promise<void> | void;
	/** Test/runtime observer invoked after a frame's delivery and cursor update settle. */
	onFrameSettled?: (attachment: SessionAttachment, frame: SessionRouterFrame) => void;
	onAttachment?: (attachment: SessionAttachment) => Promise<void> | void;
	/** Called only after the opaque capability becomes externally current. */
	onAttachmentReady?: (attachment: SessionAttachment) => Promise<void> | void;
	/** Called when the Broker index no longer reports an attached session as live. */
	onSessionRemoved?: (
		attachment: SessionAttachment,
		reason?: "removed" | "replaced" | "replaced_same_generation",
	) => Promise<void> | void;
	/** Narrow provider surface for notification consumers such as Telegram. */
	onNotificationSubscription?: (subscription: NotificationSubscription) => Promise<void> | void;
	onNotificationSubscriptionReady?: (subscription: NotificationSubscription) => Promise<void> | void;
	onNotificationFrame?: (subscription: NotificationSubscription, frame: SessionRouterFrame) => Promise<void> | void;
	onNotificationSubscriptionRemoved?: (
		subscription: NotificationSubscription,
		reason?: "removed" | "replaced" | "replaced_same_generation" | "cancelled",
	) => Promise<void> | void;
	onReconciled?: () => void;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
}

export type SessionRouterProviderDeps = Pick<
	SessionRouterDeps,
	| "createClient"
	| "createIndex"
	| "createBrokerClient"
	| "setInterval"
	| "clearInterval"
	| "setTimeout"
	| "clearTimeout"
	| "onReconciled"
>;

export interface SessionRouterOptions {
	agentDir: string;
	deps?: SessionRouterDeps;
	/** Runtime-specific identity validation; Router supplies a conservative fallback. */
	correlateFrame?: SessionRouterFrameCorrelator;
}

export type SessionRouterErrorPhase = "pre_send" | "ambiguous";

export class SessionRouterError extends Error {
	constructor(
		readonly phase: SessionRouterErrorPhase,
		message = "SDK session attachment is unavailable.",
	) {
		super(message);
		this.name = "SessionRouterError";
	}
}

/**
 * One directly attached session. The stub-and-preserve extraction (issue #4530)
 * removed the #4098 broker-index authority machinery (replay barriers, generation
 * and endpoint-mtime fencing, adoption deferral, retirement versioning, delivery
 * concession bookkeeping); an attachment is now exactly a Router-owned client plus
 * the opaque provider capabilities derived from it.
 */
type AttachedSession = {
	readonly sessionId: string;
	readonly endpoint: SdkSessionEndpoint;
	readonly generation: number;
	readonly pid: number;
	readonly endpointMtimeMs: number;
	readonly source: "index" | "adopted";
	readonly client: SessionRouterClient;
	readonly capability: SessionAttachment;
	readonly notificationSubscription: NotificationSubscription;
	notificationCancelled: boolean;
	readonly notificationCursor: { generation: number; seq: number };
	readonly cursor: { seq: number };
	published: boolean;
	frameTail: Promise<void>;
	/**
	 * Replay runs here, not on `frameTail`. A stalled provider publication must not be
	 * able to hold the catch-up replay hostage: the barrier (`replaying`) preserves
	 * ordering, so the two tails can progress independently (#4527).
	 */
	readyTail: Promise<void>;
	disposed: boolean;
	barrierFailed: boolean;
	replaying: boolean;
	held: Array<{ seq: number; frame: Record<string, unknown> }> | undefined;
	dispose: () => void;
};
const DELIVERY_ATTEMPT_LIMIT = 3;
const REPLAY_BARRIER_LIMIT = 1024;
const REPLAY_RETRY_ATTEMPTS = 3;
const REPLAY_RETRY_BACKOFF_MS = 100;

const ATTACH_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Client-message types the native session server authorizes with the
 * per-session endpoint token (`tokens_match` in crates/gjc-sdk server.rs).
 * Frames of these types without a matching `token` are dropped silently.
 */
const TOKEN_AUTHORIZED_FRAME_TYPES = new Set([
	"user_message",
	"reply",
	"ephemeral_turn",
	"ephemeral_turn_cancel",
	"config_command",
	"control_command",
]);

function readGeneration(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readEndpointMtime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readSequence(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
function readReplayGap(
	value: unknown,
):
	| Readonly<{ kind: "generation_reset"; toGeneration: number }>
	| Readonly<{ kind: "sequence_gap"; fromSeq: number; toSeq: number }>
	| undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const gap = value as Record<string, unknown>;
	if (gap.kind === "generation_reset") {
		const toGeneration = readGeneration(gap.toGeneration);
		return toGeneration === undefined ? undefined : { kind: "generation_reset", toGeneration };
	}
	if (gap.kind !== "sequence_gap") return undefined;
	const fromSeq = readSequence(gap.fromSeq);
	const toSeq = readSequence(gap.toSeq);
	if (fromSeq === undefined || toSeq === undefined || toSeq < fromSeq) return undefined;
	return { kind: "sequence_gap", fromSeq, toSeq };
}

function fallbackCorrelation(frame: Record<string, unknown>): SessionRouterFrame | undefined {
	const payload =
		frame.type === "event" && frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
			? (frame.payload as Record<string, unknown>)
			: undefined;
	const readSession = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	const readName = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
	const readCorrelation = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	const outerSession = frame.sessionId;
	const innerSession = payload?.sessionId;
	const outerGeneration = frame.generation;
	const innerGeneration = payload?.generation;
	if (outerSession !== undefined && innerSession !== undefined && outerSession !== innerSession) return undefined;
	if (outerGeneration !== undefined && innerGeneration !== undefined && outerGeneration !== innerGeneration)
		return undefined;
	const sessionClaim = outerSession !== undefined ? outerSession : innerSession;
	const generationClaim = outerGeneration !== undefined ? outerGeneration : innerGeneration;
	const sessionId = readSession(sessionClaim);
	const generation = readGeneration(generationClaim);
	if (sessionClaim !== undefined && sessionId === undefined) return undefined;
	if (generationClaim !== undefined && generation === undefined) return undefined;
	const body = payload ?? frame;
	const nestedEvent = payload
		? payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)
			? (payload.event as Record<string, unknown>)
			: undefined
		: undefined;
	const commandId =
		readCorrelation(frame.commandId) ??
		readCorrelation(payload?.commandId) ??
		readCorrelation(nestedEvent?.commandId);
	const turnId =
		readCorrelation(frame.turnId) ?? readCorrelation(payload?.turnId) ?? readCorrelation(nestedEvent?.turnId);
	return {
		body,
		name: readName(frame.name) ?? readName(frame.kind) ?? readName(body.type),
		sessionId,
		generation,
		commandId,
		turnId,
		seq: readSequence(frame.seq) ?? readSequence(payload?.seq),
	};
}

/**
 * Direct-attachment SDK session router. Providers receive only opaque attachment
 * capabilities; endpoint records and SDK clients remain here. This is the
 * stub-and-preserve replacement for the removed #4098 broker-index attachment
 * authority (issue #4530): attachments are established directly from the session
 * index or an ingested lifecycle result, frames are correlated and delivered in
 * arrival order, and revocation is a plain client close. The coherent #4098
 * authority implementation is preserved on the owner-controlled extraction refs.
 */
export class SessionRouter {
	readonly #agentDir: string;
	readonly #deps: SessionRouterDeps;
	readonly #correlateFrame: SessionRouterFrameCorrelator;
	readonly #index: SessionIndex;
	readonly #sessions = new Map<string, AttachedSession>();
	readonly #notificationReceipts = new Map<string, NotificationCleanupReceipt>();
	readonly #undelivered = new Map<string, { generation: number; seq: number; attempts: number }>();
	readonly #recoveredFrames = new Map<
		string,
		{ generation: number; frames: Array<{ seq: number; frame: Record<string, unknown> }> }
	>();
	readonly #resumeCursor = new Map<string, { generation: number; seq: number }>();
	#stopTimer: (() => void) | undefined;
	#scanTail: Promise<void> = Promise.resolve();
	#ready = false;
	#started = false;
	#runEpoch = 0;

	constructor(options: SessionRouterOptions) {
		this.#agentDir = options.agentDir;
		this.#deps = options.deps ?? {};
		this.#correlateFrame = options.correlateFrame ?? fallbackCorrelation;
		this.#index = this.#deps.createIndex?.(options.agentDir) ?? new DefaultSessionIndex(options.agentDir);
	}

	/** Provider-local cleanup outcomes; core routing never depends on these. */
	notificationCleanupReceipts(): NotificationCleanupReceipt[] {
		return [...this.#notificationReceipts.values()].map(receipt => ({ ...receipt }));
	}

	isReady(): boolean {
		return this.#ready;
	}

	#running(runEpoch: number): boolean {
		return this.#started && runEpoch === this.#runEpoch;
	}

	async #scanSerialized(): Promise<void> {
		if (!this.#started) return;
		const task = this.#scanTail.catch(() => undefined).then(() => this.#scan());
		this.#scanTail = task;
		await task;
	}

	async #joinAttachmentTails(): Promise<void> {
		await Promise.all(
			[...this.#sessions.values()].flatMap(attached => [
				attached.readyTail.catch(() => undefined),
				attached.frameTail.catch(() => undefined),
			]),
		);
	}

	/** Attaches the currently indexed live sessions and keeps watching for changes. */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		const runEpoch = ++this.#runEpoch;
		try {
			await this.#scanSerialized();
			if (!this.#running(runEpoch)) return;
			await this.#joinAttachmentTails();
			if (!this.#running(runEpoch)) return;
			const timer = (this.#deps.setInterval ?? setInterval)(() => {
				void this.#scanSerialized().catch(error =>
					logger.warn(`SDK session scan failed: ${error instanceof Error ? error.message : String(error)}`),
				);
			}, 2_000);
			this.#stopTimer = () => (this.#deps.clearInterval ?? clearInterval)(timer);
		} catch (error) {
			if (this.#running(runEpoch)) await this.stop();
			throw error;
		}
	}

	/**
	 * Re-scans the session index once, attaching new live sessions and retiring gone ones.
	 * Explicit callers still join each attachment's replay tail after the scan; the
	 * periodic timer uses `#scanSerialized` only so a wedged `event_replay` cannot
	 * freeze fleet convergence (#4527).
	 *
	 * `waitForReplay: false` returns as soon as the index scan has settled, without
	 * joining the per-attachment replay tails. Deterministic callers use it to observe
	 * attachment/retirement bookkeeping without blocking on an in-flight `event_replay`.
	 */
	async reconcile(options: { waitForReplay?: boolean } = {}): Promise<void> {
		if (!this.#started) return;
		await this.#scanSerialized();
		if (options.waitForReplay === false) return;
		await this.#joinAttachmentTails();
	}

	/** Ingests a credential-bearing Broker lifecycle result directly into Router custody. */
	async adoptLifecycleResult(
		value: unknown,
		fallback: { sessionId: string; cwd: string },
	): Promise<SessionAttachment> {
		if (!this.#started) throw new SessionRouterError("pre_send", "SDK session router is stopped.");
		const outer =
			value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		const result =
			outer.result !== null && typeof outer.result === "object" && !Array.isArray(outer.result)
				? (outer.result as Record<string, unknown>)
				: outer;
		const endpointValue = result.endpoint;
		const endpointRecord =
			endpointValue !== null && typeof endpointValue === "object" && !Array.isArray(endpointValue)
				? (endpointValue as Record<string, unknown>)
				: result;
		const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
		const endpointGeneration = readPositiveInteger(result.endpointGeneration);
		const pid = readPositiveInteger(result.pid);
		const endpointMtimeMs = readEndpointMtime(result.endpointMtimeMs);
		if (
			sessionId !== fallback.sessionId ||
			endpointGeneration === undefined ||
			pid === undefined ||
			endpointMtimeMs === undefined ||
			endpointRecord.sessionId !== sessionId ||
			endpointRecord.pid !== pid ||
			typeof endpointRecord.url !== "string" ||
			typeof endpointRecord.token !== "string"
		)
			throw new SessionRouterError(
				"pre_send",
				"Broker lifecycle result omitted an exact session endpoint authority.",
			);
		const endpoint: SdkSessionEndpoint = {
			sessionId,
			url: endpointRecord.url,
			token: endpointRecord.token,
			pid,
			path: path.join(path.resolve(fallback.cwd), ".gjc", "state", "sdk", `${sessionId}.json`),
		};
		return await this.#attachDirect({
			sessionId,
			generation: endpointGeneration,
			pid,
			endpointMtimeMs,
			endpoint,
			source: "adopted",
		});
	}

	async stop(): Promise<void> {
		if (this.#stopTimer) this.#stopTimer();
		this.#stopTimer = undefined;
		this.#runEpoch++;
		this.#started = false;
		this.#ready = false;
		const attached = [...this.#sessions.values()];
		this.#sessions.clear();
		const errors: unknown[] = [];
		for (const session of attached) {
			session.dispose();
			this.#detachNotification(session, "removed");
			try {
				await session.client.close();
			} catch (error) {
				errors.push(error);
			}
			void Promise.resolve(this.#deps.onSessionRemoved?.(session.capability, "removed")).catch(error =>
				logger.warn(`SDK provider cleanup failed during router stop: ${String(error)}`),
			);
		}
		await this.#scanTail.catch(() => undefined);
		if (errors.length > 0) throw new AggregateError(errors, "SessionRouter shutdown failed.");
	}

	/** Returns an opaque lease only while the exact attachment generation is live. */
	attachment(sessionId: string, expectedGeneration?: number): SessionAttachment | null {
		const attached = this.#sessions.get(sessionId);
		if (!attached || attached.disposed) return null;
		if (expectedGeneration !== undefined && expectedGeneration !== attached.generation) return null;
		return attached.capability;
	}

	#prepareFrame(attached: AttachedSession, frame: Record<string, unknown>): Record<string, unknown> {
		// The native session server authorizes these client-message types with
		// the per-session endpoint token and silently drops frames whose token
		// is missing or wrong. Providers only hold opaque capabilities (the
		// endpoint record lives here), so the router must stamp the token —
		// omitting it made every daemon-origin injection (Telegram → session)
		// vanish after the daemon had already ACKed the user's message.
		const withToken =
			typeof frame.type === "string" && TOKEN_AUTHORIZED_FRAME_TYPES.has(frame.type) && frame.token === undefined
				? { ...frame, token: attached.endpoint.token }
				: frame;
		const connectionId = attached.client.connectionId;
		if (connectionId === undefined) return withToken;
		if (withToken.connectionId !== undefined && withToken.connectionId !== connectionId)
			throw new SessionRouterError("pre_send", "SDK session transport identity changed before command dispatch.");
		return { ...withToken, connectionId };
	}

	/** Sends an SDK command through the current attachment without exposing its client. */
	async request(
		sessionId: string,
		frame: Record<string, unknown>,
		expectedGeneration?: number,
		expectedAttachment?: SessionAttachment,
		options?: { timeoutMs?: number },
	): Promise<Record<string, unknown>> {
		const publishing = this.#sessions.get(sessionId);
		const callerPinnedCurrent =
			!!publishing &&
			!publishing.disposed &&
			((expectedGeneration !== undefined && expectedGeneration === publishing.generation) ||
				(expectedAttachment !== undefined && expectedAttachment === publishing.capability));
		if (!callerPinnedCurrent) await this.#scanSerialized();
		const attached = this.#sessions.get(sessionId);
		if (!attached || attached.disposed)
			throw new SessionRouterError("pre_send", "SDK session attachment is unavailable: session not attached.");
		if (expectedGeneration !== undefined && expectedGeneration !== attached.generation)
			throw new SessionRouterError("pre_send", "SDK session endpoint changed before command dispatch.");
		if (expectedAttachment !== undefined && attached.capability !== expectedAttachment)
			throw new SessionRouterError("pre_send", "SDK session attachment changed before command dispatch.");
		if (attached.barrierFailed) {
			await this.#scanSerialized();
			const rebuilt = this.#sessions.get(sessionId);
			if (!rebuilt || rebuilt.disposed)
				throw new SessionRouterError("pre_send", "SDK session attachment is unavailable: session not attached.");
		}
		const live = this.#sessions.get(sessionId);
		if (!live || live.disposed)
			throw new SessionRouterError("pre_send", "SDK session attachment is unavailable: session not attached.");
		if (!callerPinnedCurrent) {
			const proved = await this.#proveAttachedEndpoint(live);
			if (!proved) {
				await this.#retire(live, "replaced_same_generation");
				throw new SessionRouterError("pre_send", "SDK session attachment changed during publication.");
			}
		}
		// A caller that sized its own budget keeps it; everything else gets the
		// long-lived session budget instead of the transport's one-shot default,
		// which a cold host's first credential-collecting query outruns (#4258).
		const response = await live.client.request(this.#prepareFrame(live, frame), {
			...options,
			timeoutMs: options?.timeoutMs ?? SESSION_REQUEST_TIMEOUT_MS,
		});
		if (
			this.#sessions.get(sessionId) !== live ||
			live.disposed ||
			(expectedGeneration !== undefined && live.generation !== expectedGeneration) ||
			(expectedAttachment !== undefined && live.capability !== expectedAttachment)
		)
			throw new SessionRouterError("ambiguous", "SDK session attachment changed while awaiting command response.");
		return response;
	}

	/** Resolves the provider-neutral binding authority for an attached session. */
	async bindingAuthority(sessionId: string): Promise<{ sessionId: string; endpointGeneration: number } | undefined> {
		const attached = this.#sessions.get(sessionId);
		if (!attached || attached.disposed || attached.barrierFailed) return undefined;
		if (!(await this.#proveAttachedEndpoint(attached))) return undefined;
		return { sessionId, endpointGeneration: attached.generation };
	}

	/** Activates a prepared session through one Router-owned, one-shot SDK client. */
	async activatePreparedSession(sessionId: string): Promise<ActivatedPreparedSession> {
		const indexed = await this.#indexedLiveSession(sessionId);
		if (
			!indexed ||
			indexed.pid === undefined ||
			indexed.endpointMtimeMs === undefined ||
			!Number.isFinite(indexed.endpointMtimeMs)
		)
			throw new SessionActivationError(
				"session_not_live",
				"Session activation requires an exact live session endpoint.",
			);
		const endpoint = await this.#readEndpoint(indexed);
		if (!endpoint?.url || !endpoint.token)
			throw new SessionActivationError(
				"session_not_live",
				"Session activation requires a readable session discovery endpoint.",
			);

		let client: PreparedSessionActivationClient;
		try {
			client = await (this.#deps.createClient
				? this.#deps.createClient({
						sessionId: indexed.sessionId,
						generation: indexed.endpointGeneration,
						pid: indexed.pid,
						endpointMtimeMs: indexed.endpointMtimeMs,
					})
				: connectPreparedSession(endpoint));
		} catch {
			throw new SessionActivationError("activation_unavailable", "The session endpoint could not be reached.");
		}
		try {
			return await requestPreparedSessionActivation(client, sessionId, indexed.endpointGeneration);
		} finally {
			await client.close().catch(() => undefined);
		}
	}

	/** Lists saved sessions through Router-owned Broker discovery without exposing credentials or mutation authority. */
	async listBrokerSessions(input: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
		const operation = "session.list";
		const discovery = await readSdkBrokerDiscovery(this.#agentDir);
		if (!discovery) throw new SessionRouterError("pre_send", "SDK broker discovery is unavailable.");
		let client: SessionRouterClient;
		try {
			client = this.#deps.createBrokerClient
				? await this.#deps.createBrokerClient()
				: await SdkClient.connect(discovery.url, discovery.token);
		} catch {
			throw new SessionRouterError("pre_send", "SDK broker connection failed.");
		}
		try {
			const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
			return await client.request(
				{ type: "broker_request", operation, input, idempotencyKey },
				timeoutMs === undefined ? undefined : { timeoutMs },
			);
		} finally {
			await client.close().catch(error => {
				logger.warn(`SDK Broker session.list transport cleanup failed (${String(error)}).`);
			});
		}
	}

	async #indexedLiveSession(sessionId: string): Promise<IndexedSession | undefined> {
		try {
			await this.#index.open();
			await this.#index.refresh();
			const listing = this.#index.listSessions();
			if (listing.warnings.length > 0) return undefined;
			const indexed = listing.sessions.find(candidate => candidate.sessionId === sessionId);
			if (
				!indexed?.live ||
				!isSessionAuthorityEligible(indexed) ||
				indexed.terminalUncertain ||
				!Number.isSafeInteger(indexed.endpointGeneration) ||
				indexed.endpointGeneration <= 0
			)
				return undefined;
			return indexed;
		} catch {
			return undefined;
		}
	}

	/**
	 * Reads the discovery endpoint for an indexed session. The scope test compares
	 * path identity, not spelling, so symlinked cwds (macOS /var -> /private/var)
	 * keep resolving (#4645).
	 */
	async #readEndpoint(indexed: IndexedSession): Promise<SdkSessionEndpoint | null> {
		if (indexed.pid === undefined) return null;
		const repo = path.resolve(indexed.locator.repo);
		const defaultStateRoot = path.join(repo, ".gjc", "state");
		const indexedStateRoot = resolveEquivalentPath(indexed.locator.stateRoot);
		const scope =
			indexedStateRoot === resolveEquivalentPath(defaultStateRoot)
				? "default"
				: indexedStateRoot === resolveEquivalentPath(path.join(defaultStateRoot, "chat"))
					? "chat"
					: undefined;
		if (!scope) return null;
		if (indexed.endpointMtimeMs === undefined || !Number.isFinite(indexed.endpointMtimeMs)) return null;
		const endpoint = await readSdkSessionEndpoint(repo, indexed.sessionId, scope).catch(() => null);
		if (!endpoint || endpoint.stale || endpoint.pid !== indexed.pid) return null;
		// A discovery record rewritten after broker registration is not the indexed
		// authority: the file's mtime must match the indexed endpoint mtime exactly,
		// including a post-read re-stat so a rewrite during the first stat is refused.
		const endpointStat = await fs.stat(endpoint.path).catch(() => undefined);
		if (!endpointStat || endpointStat.mtimeMs !== indexed.endpointMtimeMs) return null;
		let raw: Record<string, unknown>;
		try {
			const parsed = JSON.parse(await Bun.file(endpoint.path).text());
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			raw = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
		if (
			raw.sessionId !== indexed.sessionId ||
			raw.pid !== indexed.pid ||
			raw.stale === true ||
			raw.url !== endpoint.url ||
			raw.token !== endpoint.token
		)
			return null;
		const endpointStatAfterRead = await fs.stat(endpoint.path).catch(() => undefined);
		if (!endpointStatAfterRead || endpointStatAfterRead.mtimeMs !== indexed.endpointMtimeMs) return null;
		return endpoint;
	}

	async #scan(): Promise<void> {
		const runEpoch = this.#runEpoch;
		if (!this.#running(runEpoch)) return;
		let live: IndexedSession[] = [];
		try {
			await this.#index.open();
			await this.#index.refresh();
			if (!this.#running(runEpoch)) return;
			const listing = this.#index.listSessions();
			if (listing.warnings.length === 0)
				live = listing.sessions.filter(
					session => session.live && isSessionAuthorityEligible(session) && !session.terminalUncertain,
				);
		} catch (error) {
			this.#ready = false;
			throw error;
		}
		if (!this.#running(runEpoch)) return;
		const liveIds = new Set(live.map(session => session.sessionId));
		for (const session of live) {
			if (!this.#running(runEpoch)) return;
			const existing = this.#sessions.get(session.sessionId);
			if (
				existing &&
				!existing.disposed &&
				!existing.barrierFailed &&
				existing.generation === session.endpointGeneration &&
				existing.pid === session.pid &&
				existing.endpointMtimeMs === session.endpointMtimeMs
			) {
				// An unchanged index tuple is not enough: the discovery endpoint the
				// attachment was built from may have been removed or rewritten since.
				// Re-prove it and revoke the attachment when it no longer resolves.
				if (await this.#readEndpoint(session)) {
					this.#reviveTransport(existing);
					continue;
				}
				await this.#retire(existing, "removed");
				continue;
			}
			if (session.endpointMtimeMs === undefined || session.pid === undefined) {
				if (existing && !existing.disposed) await this.#retire(existing, "replaced");
				continue;
			}
			const endpoint = await this.#readEndpoint(session);
			if (existing && !existing.disposed)
				// `replaced_same_generation` is reserved for a *rotation in place*: the generation
				// did not move but the endpoint identity did (pid, endpoint mtime, URL or token).
				// Predecessor route retirement is destructive to in-flight provider effects, so a
				// same-generation rebuild that keeps the identical endpoint identity — a barrier
				// rebuild after a refused publication — must report plain `replaced` and leave the
				// undelivered effect current for re-service.
				await this.#retire(
					existing,
					existing.generation === session.endpointGeneration &&
						endpoint != null &&
						(existing.endpoint.url !== endpoint.url ||
							existing.endpoint.token !== endpoint.token ||
							existing.pid !== session.pid ||
							existing.endpointMtimeMs !== session.endpointMtimeMs)
						? "replaced_same_generation"
						: "replaced",
				);
			if (!this.#running(runEpoch) || !endpoint) continue;
			try {
				await this.#attachDirect({
					sessionId: session.sessionId,
					generation: session.endpointGeneration,
					pid: session.pid,
					endpointMtimeMs: session.endpointMtimeMs,
					endpoint,
					source: "index",
				});
			} catch (error) {
				logger.warn(
					`SDK session attachment failed for indexed session ${session.sessionId} at generation ${session.endpointGeneration}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		for (const [sessionId, attached] of [...this.#sessions]) {
			if (liveIds.has(sessionId) || attached.disposed) continue;
			await this.#retire(attached, "removed");
		}
		if (!this.#running(runEpoch)) return;
		this.#ready = true;
		this.#deps.onReconciled?.();
	}

	async #attachDirect(input: {
		sessionId: string;
		generation: number;
		pid: number;
		endpointMtimeMs: number;
		endpoint: SdkSessionEndpoint;
		source: "index" | "adopted";
	}): Promise<SessionAttachment> {
		const runEpoch = this.#runEpoch;
		if (!this.#running(runEpoch)) throw new SessionRouterError("pre_send", "SDK session router is stopped.");
		const existing = this.#sessions.get(input.sessionId);
		if (existing && !existing.disposed) await this.#retire(existing, "replaced");
		const client = await this.#createClient(input);
		if (!this.#running(runEpoch)) {
			await client.close().catch(() => undefined);
			throw new SessionRouterError("pre_send", "SDK session router is stopped.");
		}
		let attached: AttachedSession | undefined;
		const capability: SessionAttachment = Object.freeze({
			authorityId: sessionAttachmentAuthorityId({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
				url: input.endpoint.url,
				token: input.endpoint.token,
			}),
			sessionId: input.sessionId,
			generation: input.generation,
			get connectionId(): string | undefined {
				return attached?.client.connectionId;
			},
			isCurrent: () =>
				attached !== undefined && !attached.disposed && this.#sessions.get(input.sessionId) === attached,
			send: async (frame: Record<string, unknown>) => {
				if (!attached || attached.disposed || this.#sessions.get(input.sessionId) !== attached)
					throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
				attached.client.send(this.#prepareFrame(attached, frame));
			},
			retire: async () => {
				if (attached && !attached.disposed) await this.#retire(attached);
			},
		});
		const undelivered = this.#undelivered.get(input.sessionId);
		const saved = this.#resumeCursor.get(input.sessionId);
		let resumeSeq = 0;
		if (undelivered?.generation === input.generation) resumeSeq = Math.max(resumeSeq, undelivered.seq - 1);
		if (saved?.generation === input.generation) resumeSeq = Math.max(resumeSeq, saved.seq);
		const notificationCursor = { generation: input.generation, seq: resumeSeq };
		const notificationSubscription: NotificationSubscription = Object.freeze({
			sessionId: input.sessionId,
			subscriptionId: `notification:${input.sessionId}:${crypto.randomUUID()}`,
			cursor: notificationCursor,
			isActive: () =>
				attached !== undefined &&
				!attached.disposed &&
				!attached.notificationCancelled &&
				this.#sessions.get(input.sessionId) === attached,
			send: (frame: Record<string, unknown>) => {
				if (!attached || attached.disposed || attached.notificationCancelled)
					throw new SessionRouterError("pre_send", "Notification subscription is cancelled.");
				attached.client.send(this.#prepareFrame(attached, frame));
			},
			advanceCursor: (generation: number, seq: number) => {
				if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(seq) || seq < 0) return;
				if (
					generation > notificationCursor.generation ||
					(generation === notificationCursor.generation && seq > notificationCursor.seq)
				) {
					notificationCursor.generation = generation;
					notificationCursor.seq = seq;
				}
			},
			cancel: (reason?: string) => {
				if (attached && !attached.notificationCancelled) this.#detachNotification(attached, "cancelled");
				if (reason) this.#recordNotificationReceipt(notificationSubscription, "pending", reason);
			},
		});
		const disposeFrames = client.onFrame(frame => {
			const current = attached;
			if (!current || current.disposed || current.barrierFailed) return;
			if (current.replaying) {
				const seq = readSequence(frame.seq) ?? 0;
				current.held ??= [];
				if (current.held.length >= REPLAY_BARRIER_LIMIT) {
					this.#failBarrier(current, `hold buffer overflowed at ${REPLAY_BARRIER_LIMIT} frames`);
					return;
				}
				current.held.push({ seq, frame });
				return;
			}
			current.frameTail = current.frameTail.catch(() => undefined).then(() => this.#deliverFrame(current, frame));
			void current.frameTail;
		});
		const disposeReconnect = client.onReconnect?.(() => {
			const current = attached;
			if (!current || current.disposed) return;
			// The provider handshake is re-run before the catch-up replay, and both run on
			// the isolated ready tail. The barrier is raised synchronously here so live frames
			// emitted during the reconnect are held and ordered behind the replay without a
			// stalled publication delaying the replay request itself. A rejecting handshake
			// revokes the attachment, exactly like initial publication.
			current.replaying = true;
			current.held ??= [];
			current.readyTail = current.readyTail
				.catch(() => undefined)
				.then(async () => {
					if (current.disposed || this.#sessions.get(input.sessionId) !== current) return;
					await Promise.resolve()
						.then(() => this.#deps.onNotificationSubscriptionReady?.(current.notificationSubscription))
						.catch(error => {
							this.#detachNotification(current, "cancelled");
							logger.warn(
								`SDK notification subscription reconnect hook failed locally: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						});
					try {
						await this.#deps.onAttachmentReady?.(capability);
					} catch (error) {
						logger.warn(
							`SDK provider reconnect hook failed; revoking the attachment: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
						await this.#retire(current);
						return;
					}
					await this.#replayAttached(current);
				});
			void current.frameTail;
		});
		attached = {
			sessionId: input.sessionId,
			endpoint: input.endpoint,
			generation: input.generation,
			pid: input.pid,
			endpointMtimeMs: input.endpointMtimeMs,
			source: input.source,
			client,
			capability,
			notificationSubscription,
			notificationCancelled: false,
			notificationCursor,
			cursor: { seq: resumeSeq },
			published: false,
			frameTail: Promise.resolve(),
			readyTail: Promise.resolve(),
			disposed: false,
			barrierFailed: false,
			replaying: false,
			held: undefined,
			dispose: () => {
				if (!attached || attached.disposed) return;
				attached.disposed = true;
				disposeFrames();
				disposeReconnect?.();
			},
		};
		this.#sessions.set(input.sessionId, attached);
		try {
			await this.#deps.onAttachment?.(capability);
			this.#recordNotificationReceipt(notificationSubscription, "pending");
			await Promise.resolve()
				.then(() => this.#deps.onNotificationSubscription?.(notificationSubscription))
				.catch(error => {
					if (attached) this.#detachNotification(attached, "cancelled");
					logger.warn(
						`SDK notification subscription admission failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			await Promise.resolve()
				.then(() => this.#deps.onNotificationSubscriptionReady?.(notificationSubscription))
				.catch(error => {
					if (attached) this.#detachNotification(attached, "cancelled");
					logger.warn(
						`SDK notification subscription ready hook failed locally: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
			await this.#deps.onAttachmentReady?.(capability);
		} catch (error) {
			if (this.#sessions.get(input.sessionId) === attached) this.#sessions.delete(input.sessionId);
			attached.dispose();
			await client.close().catch(() => undefined);
			void Promise.resolve(this.#deps.onSessionRemoved?.(capability, "removed")).catch(() => undefined);
			throw error;
		}
		attached.published = true;
		// Raise the barrier synchronously: every live frame from this point is held for the
		// replay to order, even though the replay itself runs on the isolated ready tail.
		attached.replaying = true;
		attached.held ??= [];
		// Initial event_replay runs on the attachment's ready tail, not its frame tail, so a
		// stalled in-flight publication cannot delay the catch-up request. Publication does
		// not await it: start() still joins it for bootstrap callers, while periodic
		// scan/request stay off the wedged-replay path (#4527).
		attached.readyTail = attached.readyTail.catch(() => undefined).then(() => this.#replayAttached(attached));
		void attached.readyTail;
		return capability;
	}

	async #replayAttached(attached: AttachedSession): Promise<void> {
		if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached) return;
		attached.replaying = true;
		attached.held ??= [];
		const held = attached.held;
		const sinceSeq = attached.cursor.seq;
		try {
			let replay: Record<string, unknown> | undefined;
			for (let attempt = 0; ; attempt++) {
				try {
					replay = await attached.client.request({
						type: "event_replay",
						sinceGeneration: attached.generation,
						sinceSeq,
					});
					break;
				} catch (error) {
					if (attempt >= REPLAY_RETRY_ATTEMPTS) {
						this.#failBarrier(attached, "replay went unanswered");
						return;
					}
					logger.warn(`SDK session ${attached.sessionId} event replay failed; retrying (${String(error)}).`);
					await Bun.sleep(REPLAY_RETRY_BACKOFF_MS * 2 ** attempt);
					if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached)
						return;
				}
			}
			if (!replay) return;
			if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached) return;
			if (!(await this.#deliverRecoveredFrames(attached))) return;
			const heldReplay = held.find(entry => entry.frame.type === "event_replay_result");
			const rawEvents = Array.isArray(replay.events)
				? replay.events
				: Array.isArray(heldReplay?.frame.events)
					? heldReplay.frame.events
					: [];
			const events = rawEvents.filter(
				(event): event is Record<string, unknown> => !!event && typeof event === "object" && !Array.isArray(event),
			);
			const gapValue = replay.gap ?? heldReplay?.frame.gap;
			if (gapValue !== undefined) {
				const gap = readReplayGap(gapValue);
				if (!gap) {
					this.#failBarrier(attached, "replay reported a gap it did not state");
					return;
				}
				if (gap.kind === "generation_reset") {
					this.#failBarrier(attached, `replay reported a generation reset to ${gap.toGeneration}`);
					return;
				}
				if (gap.fromSeq !== sinceSeq + 1) {
					this.#failBarrier(
						attached,
						`replay conceded sequences ${gap.fromSeq}-${gap.toSeq} for a request that resumed from seq ${sinceSeq}`,
					);
					return;
				}
				const retained = events
					.map(event => readSequence(event.seq))
					.find(seq => seq !== undefined && seq <= gap.toSeq);
				if (retained !== undefined) {
					this.#failBarrier(
						attached,
						`replay conceded sequences ${gap.fromSeq}-${gap.toSeq} while returning seq ${retained}`,
					);
					return;
				}
				// Only sequenced frames this attachment owns can recover a conceded sequence.
				// Unsequenced traffic (seq 0) and the replay answer itself are not evidence that
				// live delivery carried anything, so they must not inflate the recovered count
				// or be re-published as if they filled the gap.
				const recovered = held
					.filter(
						entry => entry.seq > sinceSeq && entry.seq <= gap.toSeq && entry.frame.type !== "event_replay_result",
					)
					.sort((left, right) => left.seq - right.seq);
				const carried = held.filter(entry => entry.seq > gap.toSeq);
				held.splice(0, held.length, ...carried);
				const recoveredNote =
					recovered.length > 0 ? `, ${recovered.length} of them recovered from live delivery` : "";
				logger.warn(
					`chat daemon replay conceded a retention gap (sequences ${gap.fromSeq}-${gap.toSeq} are gone from the host${recoveredNote}); session ${attached.sessionId} generation ${attached.generation} resumes at seq ${gap.toSeq + 1}.`,
				);
				for (const entry of recovered) this.#rememberRecoveredFrame(attached, entry.seq, entry.frame);
				const recoveredDelivered = await this.#deliverRecoveredFrames(attached);
				// The conceded range is gone from the host and can never be re-served, so the
				// cursor moves past it even when publishing a recovered copy was refused. A
				// refusal is already retained by #failDelivery for re-service from the recovered
				// store; leaving the cursor below the concession would make every later replay
				// concede the same range again instead of making progress.
				if (gap.toSeq > attached.cursor.seq) attached.cursor.seq = gap.toSeq;
				if (!recoveredDelivered) return;
			}
			for (const event of events) {
				if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached)
					return;
				await this.#deliverFrame(attached, event);
			}
			// Drain owned batches: take each batch out of the live buffer *before* awaiting
			// publication, so frames the live callback appends while we are suspended stay in
			// `held` and are picked up by the next batch instead of being erased by a trailing
			// clear. The barrier stays raised until the buffer is observed empty.
			while (held.length > 0) {
				if (attached.disposed || attached.barrierFailed) return;
				const batch = held.splice(0, held.length);
				for (const entry of batch) {
					if (attached.disposed || attached.barrierFailed) return;
					if (entry.frame.type === "event_replay_result") continue;
					await this.#deliverFrame(attached, entry.frame);
				}
			}
		} finally {
			attached.replaying = false;
			if (attached.held === held) attached.held = undefined;
		}
	}

	async #createClient(input: {
		sessionId: string;
		generation: number;
		pid: number;
		endpointMtimeMs: number;
		endpoint: SdkSessionEndpoint;
	}): Promise<SessionRouterClient> {
		const createClient = this.#deps.createClient;
		if (createClient)
			return await createClient({
				sessionId: input.sessionId,
				generation: input.generation,
				pid: input.pid,
				endpointMtimeMs: input.endpointMtimeMs,
			});
		const client = new SdkClient(input.endpoint.url, input.endpoint.token, { ...ACP_SESSION_RECONNECT });
		const timeout = Promise.withResolvers<never>();
		const timer = (this.#deps.setTimeout ?? setTimeout)(
			() => timeout.reject(new SessionRouterError("pre_send", "SDK session attachment connection timed out.")),
			ATTACH_CONNECT_TIMEOUT_MS,
		);
		timer.unref?.();
		try {
			await Promise.race([client.connect(), timeout.promise]);
			return client;
		} catch (error) {
			void client.close().catch(() => undefined);
			throw error;
		} finally {
			(this.#deps.clearTimeout ?? clearTimeout)(timer);
		}
	}

	/**
	 * `force` re-serves a sequence the cursor has already passed. It is used only for a
	 * frame retained by a refused publication whose sequence a retention concession has
	 * since carried the cursor over: the host can no longer serve it, so the retained copy
	 * is the last surviving evidence of the event and the cursor check must not drop it.
	 */
	async #deliverFrame(attached: AttachedSession, frame: Record<string, unknown>, force = false): Promise<void> {
		if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached) return;
		if (!attached.published) return;
		const correlated = this.#correlateFrame(frame);
		if (!correlated) return;
		if (correlated.sessionId !== undefined && correlated.sessionId !== attached.sessionId) return;
		if (correlated.generation !== undefined && correlated.generation !== attached.generation) return;
		const seq = correlated.seq ?? readSequence(frame.seq);
		if (seq !== undefined) {
			if (correlated.generation === undefined && readGeneration(frame.generation) === undefined) return;
			if (
				!force &&
				seq <= attached.cursor.seq &&
				(correlated.generation === undefined || correlated.generation === attached.generation)
			)
				return;
		}
		const ownsSequence =
			seq !== undefined &&
			(correlated.generation === attached.generation || correlated.generation === undefined) &&
			(correlated.sessionId === undefined || correlated.sessionId === attached.sessionId);
		const publicationId =
			seq !== undefined && ownsSequence ? `${attached.sessionId}:${attached.generation}:${seq}` : undefined;
		const delivered = publicationId === undefined ? correlated : { ...correlated, publicationId };
		this.#dispatchNotificationFrame(attached, delivered);
		try {
			await this.#deps.onFrame?.(attached.capability, delivered);
		} catch (error) {
			if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached) return;
			if (seq === undefined || !ownsSequence) throw error;
			this.#failDelivery(attached, seq, error, frame);
			this.#deps.onFrameSettled?.(attached.capability, { ...correlated, seq });
			return;
		}
		if (attached.disposed || attached.barrierFailed || this.#sessions.get(attached.sessionId) !== attached) return;
		if (seq !== undefined && ownsSequence) {
			this.#undelivered.delete(attached.sessionId);
			this.#removeRecoveredFrame(attached.sessionId, attached.generation, seq);
			if (seq > attached.cursor.seq) attached.cursor.seq = seq;
			this.#deps.onFrameSettled?.(attached.capability, { ...delivered, seq });
		}
	}

	#failBarrier(attached: AttachedSession, reason: string): void {
		if (attached.disposed || attached.barrierFailed) return;
		attached.barrierFailed = true;
		attached.held = undefined;
		logger.warn(
			`chat daemon replay barrier failed (${reason}); rebuilding session ${attached.sessionId} at generation ${attached.generation} from seq ${attached.cursor.seq}.`,
		);
	}

	#failDelivery(attached: AttachedSession, seq: number, error: unknown, frame: Record<string, unknown>): void {
		const previous = this.#undelivered.get(attached.sessionId);
		const attempts = previous?.generation === attached.generation && previous.seq === seq ? previous.attempts + 1 : 1;
		const reason = error instanceof Error ? error.message : String(error);
		if (attempts >= DELIVERY_ATTEMPT_LIMIT) {
			this.#undelivered.delete(attached.sessionId);
			this.#removeRecoveredFrame(attached.sessionId, attached.generation, seq);
			attached.cursor.seq = seq;
			logger.warn(
				`chat daemon conceded seq ${seq} of session ${attached.sessionId} at generation ${attached.generation} after ${attempts} refused publications (${reason}); delivery resumes above it.`,
			);
			return;
		}
		this.#undelivered.set(attached.sessionId, { generation: attached.generation, seq, attempts });
		this.#rememberRecoveredFrame(attached, seq, frame);
		this.#failBarrier(attached, `publication failed at seq ${seq} (${reason})`);
	}

	#rememberRecoveredFrame(attached: AttachedSession, seq: number, frame: Record<string, unknown>): void {
		let pending = this.#recoveredFrames.get(attached.sessionId);
		if (!pending || pending.generation !== attached.generation) {
			pending = { generation: attached.generation, frames: [] };
			this.#recoveredFrames.set(attached.sessionId, pending);
		}
		const existing = pending.frames.find(item => item.seq === seq);
		if (existing) existing.frame = frame;
		else {
			pending.frames.push({ seq, frame });
			pending.frames.sort((left, right) => left.seq - right.seq);
		}
	}

	#removeRecoveredFrame(sessionId: string, generation: number, seq: number): void {
		const pending = this.#recoveredFrames.get(sessionId);
		if (!pending || pending.generation !== generation) return;
		pending.frames = pending.frames.filter(item => item.seq !== seq);
		if (pending.frames.length === 0) this.#recoveredFrames.delete(sessionId);
	}

	async #deliverRecoveredFrames(attached: AttachedSession): Promise<boolean> {
		const pending = this.#recoveredFrames.get(attached.sessionId);
		if (!pending || pending.generation !== attached.generation) return true;
		const undelivered = this.#undelivered.get(attached.sessionId);
		for (const item of [...pending.frames]) {
			// A frame below the cursor is normally already accounted for. The exception is the
			// sequence a refused publication is still retaining: a conceded retention gap moves
			// the cursor over a range the host can no longer serve, so dropping the retained
			// copy here would lose the only surviving evidence of that event.
			const retained =
				undelivered !== undefined && undelivered.generation === attached.generation && undelivered.seq === item.seq;
			if (item.seq <= attached.cursor.seq && !retained) {
				this.#removeRecoveredFrame(attached.sessionId, attached.generation, item.seq);
				continue;
			}
			await this.#deliverFrame(attached, item.frame, retained && item.seq <= attached.cursor.seq);
			if (attached.barrierFailed || attached.disposed) return false;
		}
		return true;
	}

	async #proveAttachedEndpoint(attached: AttachedSession): Promise<boolean> {
		if (attached.source === "adopted") {
			const indexed = await this.#indexedLiveSession(attached.sessionId);
			if (!indexed) return false;
			return (
				indexed.endpointGeneration === attached.generation &&
				indexed.pid === attached.pid &&
				indexed.endpointMtimeMs === attached.endpointMtimeMs
			);
		}
		const indexed = await this.#indexedLiveSession(attached.sessionId);
		if (!indexed) return false;
		const endpoint = await this.#readEndpoint(indexed);
		return (
			!!endpoint &&
			endpoint.url === attached.endpoint.url &&
			endpoint.token === attached.endpoint.token &&
			endpoint.pid === attached.pid
		);
	}

	#recordNotificationReceipt(
		subscription: NotificationSubscription,
		state: NotificationCleanupState,
		reason?: string,
	): void {
		this.#notificationReceipts.set(subscription.subscriptionId, {
			subscriptionId: subscription.subscriptionId,
			sessionId: subscription.sessionId,
			state,
			...(reason ? { reason: reason.slice(0, 256) } : {}),
		});
	}

	#detachNotification(
		attached: AttachedSession,
		reason: "removed" | "replaced" | "replaced_same_generation" | "cancelled",
	): void {
		if (attached.notificationCancelled) return;
		attached.notificationCancelled = true;
		this.#recordNotificationReceipt(attached.notificationSubscription, "pending", reason);
		void Promise.resolve()
			.then(() => this.#deps.onNotificationSubscriptionRemoved?.(attached.notificationSubscription, reason))
			.then(
				() => this.#recordNotificationReceipt(attached.notificationSubscription, "completed", reason),
				(error: unknown) =>
					this.#recordNotificationReceipt(
						attached.notificationSubscription,
						"failed",
						error instanceof Error ? error.message : String(error),
					),
			);
	}

	#dispatchNotificationFrame(attached: AttachedSession, frame: SessionRouterFrame): void {
		if (attached.notificationCancelled || attached.disposed) return;
		const callback = this.#deps.onNotificationFrame;
		if (!callback) return;
		void Promise.resolve()
			.then(() => callback(attached.notificationSubscription, frame))
			.then(() => {
				if (frame.seq !== undefined)
					attached.notificationSubscription.advanceCursor(frame.generation ?? attached.generation, frame.seq);
			})
			.catch((error: unknown) => {
				if (!attached.disposed) this.#detachNotification(attached, "cancelled");
				logger.warn(
					`SDK notification subscription ${attached.notificationSubscription.subscriptionId} failed locally: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	}

	readonly #reviving = new Set<string>();

	/**
	 * Re-establishes a dropped transport in the background. `connect()` is a
	 * no-op on a healthy client and triggers the client's reconnect hook on a
	 * dropped one; concurrent revivals for the same attachment are coalesced.
	 */
	#reviveTransport(attached: AttachedSession): void {
		const connect = attached.client.connect?.bind(attached.client);
		if (!connect || this.#reviving.has(attached.capability.authorityId ?? attached.sessionId)) return;
		this.#reviving.add(attached.capability.authorityId ?? attached.sessionId);
		void connect()
			.catch(() => undefined)
			.finally(() => this.#reviving.delete(attached.capability.authorityId ?? attached.sessionId));
	}

	async #retire(
		attached: AttachedSession,
		reason: "removed" | "replaced" | "replaced_same_generation" = "removed",
	): Promise<void> {
		this.#resumeCursor.set(attached.sessionId, {
			generation: attached.generation,
			seq: attached.cursor.seq,
		});
		if (this.#sessions.get(attached.sessionId) === attached) this.#sessions.delete(attached.sessionId);
		if (attached.disposed) return;
		attached.dispose();
		this.#detachNotification(attached, reason);
		void Promise.resolve(this.#deps.onSessionRemoved?.(attached.capability, reason)).catch(error =>
			logger.warn(`SDK provider cleanup failed after attachment revocation: ${String(error)}`),
		);
		await attached.client
			.close()
			.catch(error =>
				logger.warn(
					`SDK session transport cleanup failed for ${attached.sessionId}; authority remains revoked (${String(error)}).`,
				),
			);
	}
}

async function connectPreparedSession(endpoint: {
	url: string;
	token: string;
}): Promise<PreparedSessionActivationClient> {
	const client = await SdkClient.connect(endpoint.url, endpoint.token, { reconnectAttempts: 0 });
	return {
		request: async frame => (await client.request(frame)) as Record<string, unknown>,
		close: async () => await client.close(),
	};
}
