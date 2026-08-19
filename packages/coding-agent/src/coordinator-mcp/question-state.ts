import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import {
	appendCoordinatorFile,
	ensureCoordinatorDirectory,
	syncCoordinatorDirectory,
	writeCoordinatorAtomic,
} from "./durability";
import type { PrivateAskGateCodecV1, PublicReason } from "./question-gate-codec";

export type CoordinatorSessionState =
	| "booting"
	/** Live and endpoint-addressable, but withholding readiness until activation. */
	| "prepared"
	| "ready_for_input"
	| "running"
	| "needs_user_input"
	| "completed"
	| "errored"
	| "stale"
	| "unknown";
export interface CanonicalSessionSnapshotV1 {
	schema_version: 1;
	namespace_id: string;
	session_id: string;
	cwd: string;
	created_at: string;
	updated_at: string;
	mpreset: string | null;
	source: string | null;
	model: string | null;
	tmux: { session: string | null; window: string | null; pane: string | null };
	broker: {
		workspace: string | null;
		endpoint_url: string;
		endpoint_generation: number;
		endpoint_incarnation: string;
	};
	ephemeral: boolean;
	visible: boolean;
}
export interface CanonicalTurnSnapshotV1 {
	schema_version: 1;
	turn_id: string;
	session_id: string;
	namespace_id: string;
	status: string;
	prompt: { text: string; created_at: string; source: string };
	delivery: Record<string, unknown>;
	runtime_provenance: RuntimeProvenanceTokenV1 | null;
	question_ids: string[];
	final_response: Record<string, unknown>;
	evidence: Record<string, unknown>[];
	error: Record<string, unknown> | null;
	liveness: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
	terminal_fence: { epoch: number; status: string; reason: PublicReason | null; at: string } | null;
}
export interface CanonicalReportSnapshotV1 {
	schema_version: 1;
	report_id: string;
	operation_id: string;
	session_id: string;
	turn_id: string;
	status: string;
	summary: string;
	blocker: string | null;
	pr_url: string | null;
	evidence_paths: string[];
	created_at: string;
}
export interface RuntimeProvenanceTokenV1 {
	namespace_id: string;
	session_id: string;
	endpoint_incarnation: string;
	coordinator_turn_id: string;
	runtime_turn_id: string;
	gate_created_at: string;
	schema_hash: string;
	stage: string;
	kind: string;
}
export type GateAuthorityEntryV1 = {
	authority: { namespace_id: string; session_id: string; endpoint_incarnation: string; gate_id: string };
	observation:
		| {
				kind: "valid";
				first_provenance: RuntimeProvenanceTokenV1;
		  }
		| {
				kind: "malformed";
				immutable_observation_digest: string;
				malformed: "missing_runtime_turn" | "invalid_runtime_turn" | "invalid_gate_row" | "wrong_session";
		  };
	outcome:
		| { state: "deferred_link"; first_seen_at: string }
		| { state: "pending" | "answered"; turn_id: string; question_id: string }
		| { state: "stale" | "uncertain"; reason: PublicReason; turn_id?: string; question_id?: string }
		| { state: "ownership_unavailable"; reason: "ownership_unavailable" }
		| { state: "ownership_conflict"; reason: "ownership_conflict" };
	first_seen_at: string;
	updated_at: string;
};
export interface PrivateQuestionV1 {
	question_id: string;
	authority_id: string;
	session_id: string;
	turn_id: string;
	endpoint_incarnation: string;
	stage: string;
	kind: string;
	prompt: string;
	status: "pending" | "resolving" | "answered" | "stale" | "uncertain";
	binding_plaintext: string;
	binding_sha256: string;
	codec: PrivateAskGateCodecV1;
	claim_fence_epoch: number | null;
	answer_request_id: string | null;
	created_at: string;
	updated_at: string;
	answered_at: string | null;
	history: Array<{
		at: string;
		status: "pending" | "resolving" | "answered" | "stale" | "uncertain";
		reason: PublicReason | null;
	}>;
}
export interface AnswerRequestV1 {
	request_id: string;
	key_digest: string;
	request_digest: string;
	answer_hash: string;
	answer_binding_sha256: string;
	authority_id: string;
	question_id: string;
	turn_id: string;
	endpoint_incarnation: string;
	sdk_idempotency_key: string;
	claim_fence_epoch: number;
	phase: "claimed" | "remote_started" | "accepted" | "rejected" | "completed" | "uncertain";
	safe_receipt?: {
		status: "accepted" | "rejected";
		answer_hash: string;
		answer_binding_sha256: string;
		authority_id: string;
		turn_id: string;
		endpoint_incarnation: string;
		claim_fence_epoch: number;
		resolved_at: string;
	};
	error_code?: PublicReason | "idempotency_conflict";
	created_at: string;
	updated_at: string;
}
export interface PromptRequestV1 {
	request_id: string;
	key_digest: string;
	request_digest: string;
	operation: "turn.prompt" | "turn.follow_up" | "turn.abort_and_prompt";
	canonical_prompt: { text: string };
	sdk_idempotency_key: string;
	phase: "claimed" | "remote_started" | "accepted" | "linked" | "terminal" | "completed" | "uncertain";
	runtime_receipt?: { accepted: true; command_id: string; turn_id: string };
	coordinator_turn_id?: string;
	safe_response?: Record<string, unknown>;
	error_code?: PublicReason | "idempotency_conflict";
	created_at: string;
	updated_at: string;
}
export interface OperationRequestV1 {
	operation_id: string;
	tool: string;
	key_digest: string;
	request_digest: string;
	local_id: string;
	remote_id?: string;
	phase: "claimed" | "remote_started" | "completed" | "uncertain";
	intent: Record<string, unknown>;
	safe_response?: Record<string, unknown>;
	error_code?: PublicReason | "idempotency_conflict";
	created_at: string;
	updated_at: string;
}
export type PublicDeliveryStateV1 = "pending" | "claimed" | "acknowledged";
export interface PublicDeliveryV1 {
	public_event_id: string;
	state: PublicDeliveryStateV1;
	claim_fence: number | null;
	claim_expires_at: string | null;
	journal_seq: number | null;
	acknowledged_at: string | null;
}
export interface OutboxEventV1 {
	id: string;
	transaction_revision: number;
	kind: string;
	entity: "turn" | "question" | "report" | "session" | "deletion";
	entity_id: string;
	payload: Record<string, string | number | boolean | null>;
	emitted: boolean;
	/** Stable public id; it is independent from journal sequence allocation. */
	public_event_id: string;
	public_delivery: PublicDeliveryV1;
}
function isOutboxEntity(value: unknown): value is OutboxEventV1["entity"] {
	return value === "turn" || value === "question" || value === "report" || value === "session" || value === "deletion";
}
export interface CoordinatorSessionTransactionV1 {
	schema_version: 1;
	namespace_id: string;
	session_id: string;
	revision: number;
	endpoint: { incarnation: string; observed_at: string } | null;
	canonical: {
		session: CanonicalSessionSnapshotV1;
		turns: Record<string, CanonicalTurnSnapshotV1>;
		queue: {
			ordered_turn_ids: string[];
			active_turn_id: string | null;
			selected_promotion: { from_turn_id: string; to_turn_id: string; revision: number } | null;
		};
		desired_session_state: CoordinatorSessionState;
		reports: Record<string, CanonicalReportSnapshotV1>;
		gate_authorities: Record<string, GateAuthorityEntryV1>;
		questions: Record<string, PrivateQuestionV1>;
	};
	requests: {
		prompts: Record<string, PromptRequestV1>;
		answers: Record<string, AnswerRequestV1>;
		operations: Record<string, OperationRequestV1>;
	};
	outbox: Record<string, OutboxEventV1>;
	projection: {
		applied_turns_revision: number;
		applied_reports_revision: number;
		applied_session_revision: number;
		applied_active_revision: number;
		applied_events_revision: number;
		/** Session-WAL-first scheduler repair markers. */
		scheduler_pending_revision?: number;
		scheduler_applied_revision?: number;
		scheduler_digest?: string;
	};
	recovery: { prompt_watermark_at: string | null; last_repaired_at: string | null };
}
export type CanonicalCreateIntentV1 =
	| {
			kind: "register";
			session: CanonicalSessionSnapshotV1;
			initial_state: CoordinatorSessionState;
			initial_events: Record<string, string | number | boolean | null>[];
	  }
	| {
			kind: "start";
			session: CanonicalSessionSnapshotV1;
			remote_create_key: string;
			initial_state: CoordinatorSessionState;
			initial_prompt: { text: string; caller_key_digest: string } | null;
			initial_events: Record<string, string | number | boolean | null>[];
	  }
	| {
			kind: "delegate";
			workflow: "plan" | "execute";
			session: CanonicalSessionSnapshotV1;
			remote_create_key: string;
			initial_state: CoordinatorSessionState;
			initial_prompt: { text: string; caller_key_digest: string };
			initial_events: Record<string, string | number | boolean | null>[];
	  };
export interface CreationRequestV1 {
	key_digest: string;
	request_digest: string;
	tool: string;
	phase: "claimed" | "remote_started" | "wal_committed" | "projected" | "completed" | "uncertain";
	canonical_create_intent: CanonicalCreateIntentV1 | null;
	remote_create_key: string;
	session_id: string | null;
	endpoint_incarnation: string | null;
	wal_revision?: number;
	wal_digest?: string;
	safe_response?: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}
export interface NamespaceDeletionEntryV1 {
	deletion_id: string;
	session_id: string;
	endpoint_incarnation: string;
	operation_id: string;
	key_digest: string;
	request_digest: string;
	close_key: string;
	phase: "intent" | "broker_closed" | "cleanup_pending" | "completed" | "uncertain";
	safe_response?: Record<string, unknown>;
	cleanup: { wal: boolean; turns: boolean; reports: boolean; session: boolean; events: boolean };
	authority_digest: string;
	created_at: string;
	updated_at: string;
}
export interface NamespaceRegistryV1 {
	schema_version: 1;
	namespace_id: string;
	creations: Record<string, CreationRequestV1>;
	deletions: Record<string, NamespaceDeletionEntryV1>;
	/** Durable bounded scheduler hints. Lifecycle authority remains in session WALs. */
	roster?: Record<
		string,
		{ session_id: string; revision: number; digest: string; active: boolean; dirty: boolean; updated_at: string }
	>;
	scheduler_revision?: number;
	scheduler_cursor?: string;
	retained_sessions?: Record<string, { session_id: string; updated_at: string }>;
	delivery_discovery_cursor?: string;
}
export interface CoordinatorStatePaths {
	root: string;
	registry: string;
	registryLock: string;
	journal: string;
	journalLock: string;
	sessions: string;
}
const MAX_NORMAL_BYTES = 1024 * 1024;
const EMERGENCY_BYTES = 128 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_CLAIM_LEASE_MS = 30_000;
export const COORDINATOR_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const lockOptions = (signal?: AbortSignal) => (signal ? { signal } : undefined);

function publicDeliveryFor(event: OutboxEventV1): PublicDeliveryV1 {
	const candidate = event.public_delivery;
	if (
		candidate &&
		(candidate.state === "pending" || candidate.state === "claimed" || candidate.state === "acknowledged") &&
		(typeof candidate.public_event_id === "string" || typeof event.public_event_id === "string")
	) {
		return {
			public_event_id: candidate.public_event_id || event.public_event_id || event.id,
			state: candidate.state,
			claim_fence: Number.isSafeInteger(candidate.claim_fence) ? candidate.claim_fence : null,
			claim_expires_at: typeof candidate.claim_expires_at === "string" ? candidate.claim_expires_at : null,
			journal_seq: Number.isSafeInteger(candidate.journal_seq) ? candidate.journal_seq : null,
			acknowledged_at: typeof candidate.acknowledged_at === "string" ? candidate.acknowledged_at : null,
		};
	}
	return {
		public_event_id: event.public_event_id || event.id,
		state: "pending",
		claim_fence: null,
		claim_expires_at: null,
		journal_seq: null,
		acknowledged_at: null,
	};
}

function normalizeOutbox(transaction: CoordinatorSessionTransactionV1): void {
	for (const event of Object.values(transaction.outbox)) {
		if (!event.public_event_id) event.public_event_id = event.id;
		event.public_delivery = publicDeliveryFor(event);
	}
}
export function coordinatorStatePaths(stateRoot: string, namespaceId: string): CoordinatorStatePaths {
	const root = path.join(stateRoot, "v1", namespaceId);
	return {
		root,
		registry: path.join(root, "namespace-registry.v1.json"),
		registryLock: path.join(root, "namespace-registry.lock"),
		journal: path.join(root, "events", "event-journal.jsonl"),
		journalLock: path.join(root, "events", "event-journal.lock"),
		sessions: path.join(root, "sessions"),
	};
}
function safeSessionId(sessionId: string): string {
	if (!COORDINATOR_SESSION_ID_PATTERN.test(sessionId)) throw new Error("state_corrupt");
	return sessionId;
}
export function transactionPath(paths: CoordinatorStatePaths, sessionId: string): string {
	return path.join(paths.sessions, safeSessionId(sessionId), "transaction.v1.json");
}
export function transactionLockPath(paths: CoordinatorStatePaths, sessionId: string): string {
	return path.join(paths.sessions, safeSessionId(sessionId), "transaction.lock");
}
async function ensureNamespaceParents(paths: CoordinatorStatePaths): Promise<void> {
	await ensureCoordinatorDirectory(paths.root);
}

async function removeCoordinatorStateFile(file: string): Promise<void> {
	try {
		await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			await fs.stat(path.dirname(file));
		} catch (parentError) {
			if ((parentError as NodeJS.ErrnoException).code === "ENOENT") return;
			throw parentError;
		}
		await syncCoordinatorDirectory(path.dirname(file));
		return;
	}
	await fs.rm(file);
	await syncCoordinatorDirectory(path.dirname(file));
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
	await writeCoordinatorAtomic(file, JSON.stringify(value));
}
async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("state_corrupt");
	}
}
function assertTransaction(transaction: CoordinatorSessionTransactionV1, namespaceId: string, sessionId: string): void {
	if (
		transaction.schema_version !== 1 ||
		transaction.namespace_id !== namespaceId ||
		transaction.session_id !== sessionId ||
		transaction.canonical.session.namespace_id !== namespaceId ||
		transaction.canonical.session.session_id !== sessionId ||
		transaction.canonical.session.cwd !== path.resolve(transaction.canonical.session.cwd)
	)
		throw new Error("state_corrupt");
}
export async function initializeCoordinatorNamespace(paths: CoordinatorStatePaths): Promise<void> {
	await ensureNamespaceParents(paths);
	await ensureCoordinatorDirectory(paths.sessions);
	await ensureCoordinatorDirectory(path.dirname(paths.journal));
	await withFileLock(paths.registryLock, async () => {
		const existing = await readJson<NamespaceRegistryV1>(paths.registry);
		if (existing === null)
			await writeAtomic(paths.registry, {
				schema_version: 1,
				namespace_id: path.basename(paths.root),
				creations: {},
				deletions: {},
				roster: {},
				scheduler_revision: 0,
				scheduler_cursor: "",
				retained_sessions: {},
				delivery_discovery_cursor: "@session:",
			});
		else if (existing.schema_version !== 1 || existing.namespace_id !== path.basename(paths.root))
			throw new Error("state_corrupt");
	});
}
export async function withNamespaceRegistry<T>(
	paths: CoordinatorStatePaths,
	operation: (registry: NamespaceRegistryV1) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	await ensureNamespaceParents(paths);
	return await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			registry.roster ??= {};
			registry.scheduler_revision ??= 0;
			registry.scheduler_cursor ??= "";
			registry.retained_sessions ??= {};
			registry.delivery_discovery_cursor ??= "@session:";
			const result = await operation(registry);
			await writeAtomic(paths.registry, registry);
			return result;
		},
		lockOptions(options.signal),
	);
}
export async function ensureSchedulerRoster(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const transaction = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
	if (!transaction) return;
	await withNamespaceRegistry(
		paths,
		async registry => {
			registry.roster ??= {};
			const existing = registry.roster[sessionId];
			registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, transaction.revision);
			registry.roster[sessionId] = {
				session_id: sessionId,
				revision: transaction.revision,
				digest: digest(JSON.stringify(transaction.canonical.queue)),
				active:
					transaction.canonical.queue.active_turn_id !== null ||
					Object.values(transaction.canonical.turns).some(turn =>
						["queued", "delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
					) ||
					transaction.canonical.desired_session_state === "needs_user_input",
				dirty: existing?.dirty ?? false,
				updated_at: new Date().toISOString(),
			};
		},
		options,
	);
}

export async function listCanonicalActiveSessions(
	paths: CoordinatorStatePaths,
	options: { signal?: AbortSignal } = {},
): Promise<string[]> {
	await ensureNamespaceParents(paths);
	const sessionIds = await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (!registry || registry.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return Object.values(registry.roster ?? {})
				.filter(entry => entry.active || entry.dirty)
				.map(entry => entry.session_id)
				.sort();
		},
		lockOptions(options.signal),
	);
	const active: string[] = [];
	for (const sessionId of sessionIds) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		const transaction = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
		if (!transaction) continue;
		assertTransaction(transaction, path.basename(paths.root), sessionId);
		const hasActiveTurn = Object.values(transaction.canonical.turns).some(turn =>
			["queued", "delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
		);
		if (
			hasActiveTurn ||
			transaction.canonical.queue.active_turn_id !== null ||
			transaction.canonical.desired_session_state === "needs_user_input"
		)
			active.push(sessionId);
	}
	return active;
}

export async function readDeliveryDiscoveryCursor(
	paths: CoordinatorStatePaths,
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	await ensureNamespaceParents(paths);
	return await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (!registry || registry.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return registry.delivery_discovery_cursor ?? "";
		},
		lockOptions(options.signal),
	);
}

export async function advanceDeliveryDiscoveryCursor(
	paths: CoordinatorStatePaths,
	cursor: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await withNamespaceRegistry(
		paths,
		async registry => {
			registry.delivery_discovery_cursor = cursor;
		},
		options,
	);
}

export async function readSchedulerRoster(
	paths: CoordinatorStatePaths,
	options: { signal?: AbortSignal } = {},
): Promise<{
	roster: Array<{
		session_id: string;
		revision: number;
		digest: string;
		active: boolean;
		dirty: boolean;
		updated_at: string;
	}>;
	cursor: string;
}> {
	await ensureNamespaceParents(paths);
	return await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (registry?.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return {
				roster: Object.values(registry.roster ?? {}).sort((left, right) =>
					left.session_id.localeCompare(right.session_id),
				),
				cursor: registry.scheduler_cursor ?? "",
			};
		},
		lockOptions(options.signal),
	);
}

export async function advanceSchedulerCursor(
	paths: CoordinatorStatePaths,
	cursor: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await withNamespaceRegistry(
		paths,
		async registry => {
			registry.scheduler_cursor = cursor;
		},
		options,
	);
}

export async function readSessionTransaction(
	paths: CoordinatorStatePaths,
	sessionId: string,
): Promise<CoordinatorSessionTransactionV1 | null> {
	const transaction = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
	if (!transaction) return null;
	assertTransaction(transaction, path.basename(paths.root), sessionId);
	normalizeOutbox(transaction);
	return transaction;
}

export async function withSessionTransaction<T>(
	paths: CoordinatorStatePaths,
	sessionId: string,
	operation: (transaction: CoordinatorSessionTransactionV1) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	const file = transactionPath(paths, sessionId);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	return await withFileLock(
		transactionLockPath(paths, sessionId),
		async () => {
			const transaction = await readJson<CoordinatorSessionTransactionV1>(file);
			if (!transaction) throw new Error("resource_gone");
			assertTransaction(transaction, path.basename(paths.root), sessionId);
			const beforeDigest = digest(JSON.stringify(transaction));
			normalizeOutbox(transaction);
			const result = await operation(transaction);
			normalizeOutbox(transaction);
			compactTransaction(transaction);
			if (digest(JSON.stringify(transaction)) === beforeDigest) return result;
			transaction.projection.scheduler_pending_revision = transaction.revision + 1;
			transaction.projection.scheduler_digest = digest(
				JSON.stringify({
					session_id: transaction.session_id,
					revision: transaction.revision + 1,
					active: transaction.canonical.queue.active_turn_id !== null,
					state: transaction.canonical.desired_session_state,
				}),
			);
			transaction.revision++;
			await writeAtomic(file, transaction);
			return result;
		},
		lockOptions(options.signal),
	);
}

/** Remove a retained-session hint once its WAL has no unacknowledged deliveries. */
async function pruneRetainedSessionIfEmpty(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await withNamespaceRegistry(
		paths,
		async registry =>
			await withFileLock(
				transactionLockPath(paths, sessionId),
				async () => {
					const transaction = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, sessionId));
					if (transaction) normalizeOutbox(transaction);
					if (
						!transaction ||
						!Object.values(transaction.outbox).some(event => event.public_delivery.state !== "acknowledged")
					)
						delete registry.retained_sessions?.[sessionId];
				},
				lockOptions(options.signal),
			),
		options,
	);
}

/** Atomically admits a session close against the canonical WAL and registry. */
export async function admitSessionClose(
	paths: CoordinatorStatePaths,
	entry: NamespaceDeletionEntryV1,
	options: { signal?: AbortSignal } = {},
): Promise<CoordinatorSessionTransactionV1> {
	return await withNamespaceRegistry(
		paths,
		async registry =>
			await withFileLock(
				transactionLockPath(paths, entry.session_id),
				async () => {
					const transaction = await readJson<CoordinatorSessionTransactionV1>(
						transactionPath(paths, entry.session_id),
					);
					if (!transaction) throw new Error("resource_gone");
					assertTransaction(transaction, path.basename(paths.root), entry.session_id);
					const existing = registry.deletions[entry.deletion_id];
					if (
						existing &&
						(existing.key_digest !== entry.key_digest || existing.request_digest !== entry.request_digest)
					)
						throw new Error("idempotency_conflict");
					const active = Object.values(transaction.canonical.turns).find(turn =>
						["delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
					);
					const reservedPrompt = Object.values(transaction.requests.prompts).some(
						request =>
							request.operation !== "turn.follow_up" &&
							["claimed", "remote_started", "accepted"].includes(request.phase),
					);
					if (active || transaction.canonical.queue.active_turn_id !== null || reservedPrompt)
						throw new Error("active_turn_exists");
					registry.deletions[entry.deletion_id] = existing ?? entry;
					return transaction;
				},
				lockOptions(options.signal),
			),
		options,
	);
}

/** Serializes a session mutation with namespace close admission. */
export async function withAdmittedSessionTransaction<T>(
	paths: CoordinatorStatePaths,
	sessionId: string,
	operation: (transaction: CoordinatorSessionTransactionV1) => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	return await withNamespaceRegistry(
		paths,
		async registry => {
			const latest: { value: CoordinatorSessionTransactionV1 | null } = { value: null };
			const result = await withSessionTransaction(
				paths,
				sessionId,
				async transaction => {
					assertCloseAdmission(registry, transaction);
					const value = await operation(transaction);
					latest.value = transaction;
					return value;
				},
				options,
			);
			if (latest.value) {
				registry.roster ??= {};
				registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, latest.value.revision);
				registry.roster[sessionId] = {
					session_id: sessionId,
					revision: latest.value.revision,
					digest: digest(JSON.stringify(latest.value.canonical.queue)),
					active:
						latest.value.canonical.queue.active_turn_id !== null ||
						Object.values(latest.value.canonical.turns).some(turn =>
							["queued", "delivering", "active", "waiting_for_answer", "completing"].includes(turn.status),
						) ||
						latest.value.canonical.desired_session_state === "needs_user_input",
					dirty: true,
					updated_at: new Date().toISOString(),
				};
				registry.retained_sessions ??= {};
				if (Object.values(latest.value.outbox).some(event => event.public_delivery.state !== "acknowledged"))
					registry.retained_sessions[sessionId] = {
						session_id: sessionId,
						updated_at: new Date().toISOString(),
					};
				else delete registry.retained_sessions?.[sessionId];
			}
			return result;
		},
		options,
	);
}

/** Claims a caller-visible creation request before any remote work or projection. */
export async function claimCreationRequest(
	paths: CoordinatorStatePaths,
	input: { key_digest: string; request_digest: string; tool: string },
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const existing = registry.creations[input.key_digest];
		if (existing) {
			if (existing.request_digest !== input.request_digest || existing.tool !== input.tool)
				throw new Error("idempotency_conflict");
			return existing;
		}
		const now = new Date().toISOString();
		const request: CreationRequestV1 = {
			key_digest: input.key_digest,
			request_digest: input.request_digest,
			tool: input.tool,
			phase: "claimed",
			canonical_create_intent: null,
			remote_create_key: `remote_${input.key_digest}`,
			session_id: null,
			endpoint_incarnation: null,
			created_at: now,
			updated_at: now,
		};
		registry.creations[input.key_digest] = request;
		return request;
	});
}

/** Persists the remote result needed to resume a creation after a crash. */
export async function bindCreationRequest(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	intent: CanonicalCreateIntentV1,
): Promise<CreationRequestV1> {
	return await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		const session = intent.session;
		if (
			request.session_id &&
			(request.session_id !== session.session_id ||
				request.endpoint_incarnation !== session.broker.endpoint_incarnation)
		)
			throw new Error("state_corrupt");
		if (
			Object.values(registry.deletions).some(
				entry =>
					entry.session_id === session.session_id &&
					entry.endpoint_incarnation === session.broker.endpoint_incarnation,
			)
		)
			throw new Error("session_closing");
		request.canonical_create_intent = intent;
		request.session_id = session.session_id;
		request.endpoint_incarnation = session.broker.endpoint_incarnation;
		if (request.phase === "claimed") request.phase = "remote_started";
		request.updated_at = new Date().toISOString();
		return request;
	});
}

/** Creates the durable session WAL for an already claimed creation request. */
export async function commitCreationWal(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	intent: CanonicalCreateIntentV1,
): Promise<CoordinatorSessionTransactionV1> {
	await bindCreationRequest(paths, keyDigest, intent);
	return await withNamespaceRegistry(paths, async registry => {
		const session = intent.session;
		return await withFileLock(transactionLockPath(paths, session.session_id), async () => {
			const request = registry.creations[keyDigest];
			if (!request || request.canonical_create_intent === null) throw new Error("state_corrupt");
			let existing = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, session.session_id));
			if (existing) {
				assertTransaction(existing, session.namespace_id, session.session_id);
				if (existing.canonical.session.broker.endpoint_incarnation !== session.broker.endpoint_incarnation) {
					const priorDeleted = Object.values(registry.deletions).some(
						entry =>
							entry.session_id === session.session_id &&
							entry.endpoint_incarnation === existing!.canonical.session.broker.endpoint_incarnation &&
							entry.phase === "completed",
					);
					if (!priorDeleted) throw new Error("session_closing");
					// Keep the session lock held while the new WAL atomically replaces the
					// old-incarnation record. Never unlink the canonical path first: a crash
					// in that gap would expose a missing session and permit a successor to
					// race the replacement.
					existing = null;
				}
				if (existing) {
					request.phase = "wal_committed";
					request.wal_revision = existing.revision;
					request.wal_digest = digest(JSON.stringify(existing));
					request.updated_at = new Date().toISOString();
					return existing;
				}
			}
			const now = new Date().toISOString();
			const transaction: CoordinatorSessionTransactionV1 = {
				schema_version: 1,
				namespace_id: session.namespace_id,
				session_id: session.session_id,
				revision: 1,
				endpoint: { incarnation: session.broker.endpoint_incarnation, observed_at: now },
				canonical: {
					session,
					turns: {},
					queue: { ordered_turn_ids: [], active_turn_id: null, selected_promotion: null },
					desired_session_state: intent.initial_state,
					reports: {},
					gate_authorities: {},
					questions: {},
				},
				requests: { prompts: {}, answers: {}, operations: {} },
				outbox: {},
				projection: {
					applied_turns_revision: 0,
					applied_reports_revision: 0,
					applied_session_revision: 0,
					applied_active_revision: 0,
					applied_events_revision: 0,
					scheduler_pending_revision: 1,
					scheduler_applied_revision: 0,
					scheduler_digest: digest(JSON.stringify({ session_id: session.session_id, revision: 1 })),
				},
				recovery: { prompt_watermark_at: null, last_repaired_at: null },
			};
			await writeAtomic(transactionPath(paths, session.session_id), transaction);
			request.phase = "wal_committed";
			request.wal_revision = transaction.revision;
			request.wal_digest = digest(JSON.stringify(transaction));
			request.updated_at = now;
			registry.roster ??= {};
			registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, transaction.revision);
			registry.roster[session.session_id] = {
				session_id: session.session_id,
				revision: transaction.revision,
				digest: digest(JSON.stringify(transaction.canonical.queue)),
				active: transaction.canonical.queue.active_turn_id !== null,
				dirty: true,
				updated_at: now,
			};
			return transaction;
		});
	});
}
export async function createSessionTransaction(
	paths: CoordinatorStatePaths,
	intent: CanonicalCreateIntentV1,
): Promise<CoordinatorSessionTransactionV1> {
	const session = intent.session;
	return await withNamespaceRegistry(paths, async registry => {
		return await withFileLock(transactionLockPath(paths, session.session_id), async () => {
			const key = digest(`${intent.kind}\0${session.session_id}\0${session.broker.endpoint_incarnation}`);
			if (
				Object.values(registry.deletions).some(
					entry =>
						entry.session_id === session.session_id &&
						entry.endpoint_incarnation === session.broker.endpoint_incarnation,
				)
			)
				throw new Error("session_closing");
			const prior = registry.creations[key];
			const existing = await readJson<CoordinatorSessionTransactionV1>(transactionPath(paths, session.session_id));
			if (existing) {
				assertTransaction(existing, session.namespace_id, session.session_id);
				if (existing.canonical.session.broker.endpoint_incarnation !== session.broker.endpoint_incarnation) {
					const priorDeleted = Object.values(registry.deletions).some(
						entry =>
							entry.session_id === session.session_id &&
							entry.endpoint_incarnation === existing.canonical.session.broker.endpoint_incarnation &&
							entry.phase === "completed",
					);
					if (!priorDeleted) throw new Error("session_closing");
				} else if (
					prior?.phase === "completed" ||
					prior?.phase === "projected" ||
					prior?.phase === "wal_committed"
				) {
					return existing;
				}
			}
			const now = new Date().toISOString();
			registry.creations[key] = {
				key_digest: key,
				request_digest: key,
				tool: intent.kind,
				phase: "claimed",
				canonical_create_intent: intent,
				remote_create_key: `remote_${key}`,
				session_id: session.session_id,
				endpoint_incarnation: session.broker.endpoint_incarnation,
				created_at: now,
				updated_at: now,
			};
			const transaction: CoordinatorSessionTransactionV1 = {
				schema_version: 1,
				namespace_id: session.namespace_id,
				session_id: session.session_id,
				revision: 1,
				endpoint: { incarnation: session.broker.endpoint_incarnation, observed_at: now },
				canonical: {
					session,
					turns: {},
					queue: { ordered_turn_ids: [], active_turn_id: null, selected_promotion: null },
					desired_session_state: intent.initial_state,
					reports: {},
					gate_authorities: {},
					questions: {},
				},
				requests: { prompts: {}, answers: {}, operations: {} },
				outbox: {},
				projection: {
					applied_turns_revision: 0,
					applied_reports_revision: 0,
					applied_session_revision: 0,
					applied_active_revision: 0,
					applied_events_revision: 0,
					scheduler_pending_revision: 1,
					scheduler_applied_revision: 0,
					scheduler_digest: digest(JSON.stringify({ session_id: session.session_id, revision: 1 })),
				},
				recovery: { prompt_watermark_at: null, last_repaired_at: null },
			};
			await writeAtomic(transactionPath(paths, session.session_id), transaction);
			registry.creations[key]!.phase = "wal_committed";
			registry.creations[key]!.wal_revision = transaction.revision;
			registry.creations[key]!.wal_digest = digest(JSON.stringify(transaction));
			registry.creations[key]!.updated_at = now;
			registry.roster ??= {};
			registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, transaction.revision);
			registry.roster[session.session_id] = {
				session_id: session.session_id,
				revision: transaction.revision,
				digest: digest(JSON.stringify(transaction.canonical.queue)),
				active: transaction.canonical.queue.active_turn_id !== null,
				dirty: true,
				updated_at: now,
			};
			return transaction;
		});
	});
}
export function assertCloseAdmission(
	registry: NamespaceRegistryV1,
	transaction: CoordinatorSessionTransactionV1,
): void {
	if (
		Object.values(registry.deletions).some(
			entry =>
				entry.session_id === transaction.session_id &&
				entry.endpoint_incarnation === transaction.endpoint?.incarnation,
		) ||
		Object.values(transaction.requests.operations).some(
			request =>
				(request.intent.kind === "stop" || request.intent.kind === "reap") && request.phase === "remote_started",
		)
	)
		throw new Error("session_closing");
}
export function deterministicOutboxId(
	sessionId: string,
	revision: number,
	kind: string,
	entity: OutboxEventV1["entity"],
	entityId: string,
): string {
	return `txn:${sessionId}:${revision}:${kind}:${entity}:${entityId}`;
}
export async function appendOutboxEvents(
	paths: CoordinatorStatePaths,
	transaction: CoordinatorSessionTransactionV1,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	/*
	 * `emitted` is a private projection marker, not public-delivery acknowledgement.
	 * Public rows are appended by the coordinator event journal exporter after a
	 * canonical claim. Keeping this phase journal-free prevents private payloads from
	 * becoming malformed public JSONL rows and leaves delivery recoverable after a
	 * projection/export crash.
	 */
	normalizeOutbox(transaction);
	void paths;
	void options;
	for (const event of Object.values(transaction.outbox)) event.emitted = true;
	transaction.projection.applied_events_revision = transaction.revision + 1;
}

export interface PublicDeliveryClaimV1 {
	event: OutboxEventV1;
	claim_fence: number;
}

const DELIVERY_REVISION_WIDTH = 20;

function deliveryOrderKey(sessionId: string, event: OutboxEventV1): string {
	return `${sessionId}\0${String(event.transaction_revision).padStart(DELIVERY_REVISION_WIDTH, "0")}\0${event.public_event_id}`;
}

function claimExpired(delivery: PublicDeliveryV1, now: number): boolean {
	return (
		delivery.state === "claimed" &&
		typeof delivery.claim_expires_at === "string" &&
		Date.parse(delivery.claim_expires_at) <= now
	);
}

/** Claim one session's retained public intents; claims are fenced and lease based. */
export async function claimPublicDelivery(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: {
		signal?: AbortSignal;
		limit?: number;
		leaseMs?: number;
		after_order_key?: string;
	} = {},
): Promise<PublicDeliveryClaimV1[]> {
	const limit = Math.max(1, Math.min(options.limit ?? 16, 128));
	const leaseMs = Math.max(1_000, Math.min(options.leaseMs ?? PUBLIC_CLAIM_LEASE_MS, 5 * 60_000));
	const now = Date.now();
	const claims = await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			normalizeOutbox(transaction);
			const claimed: PublicDeliveryClaimV1[] = [];
			for (const event of Object.values(transaction.outbox).sort(
				(a, b) =>
					a.transaction_revision - b.transaction_revision || a.public_event_id.localeCompare(b.public_event_id),
			)) {
				const delivery = event.public_delivery;
				if (delivery.state === "acknowledged") continue;
				if (options.after_order_key && deliveryOrderKey(sessionId, event) <= options.after_order_key) continue;
				if (delivery.state === "claimed" && !claimExpired(delivery, now)) continue;
				const fence = transaction.revision + claimed.length + 1;
				delivery.state = "claimed";
				delivery.claim_fence = fence;
				delivery.claim_expires_at = new Date(now + leaseMs).toISOString();
				claimed.push({ event: structuredClone(event), claim_fence: fence });
				if (claimed.length >= limit) break;
			}
			return claimed;
		},
		options,
	);
	await pruneRetainedSessionIfEmpty(paths, sessionId, options);
	return claims;
}

/** Recover expired claims in-place without changing their stable public id. */
export async function recoverExpiredPublicDelivery(
	paths: CoordinatorStatePaths,
	sessionId: string,
	options: { signal?: AbortSignal } = {},
): Promise<number> {
	const recovered = await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			const now = Date.now();
			let recovered = 0;
			for (const event of Object.values(transaction.outbox)) {
				if (!claimExpired(event.public_delivery, now)) continue;
				event.public_delivery.state = "pending";
				event.public_delivery.claim_fence = null;
				event.public_delivery.claim_expires_at = null;
				recovered++;
			}
			return recovered;
		},
		options,
	);
	await pruneRetainedSessionIfEmpty(paths, sessionId, options);
	return recovered;
}

/** Exact acknowledgement prevents a late exporter from acknowledging a newer claim. */
export async function acknowledgePublicDelivery(
	paths: CoordinatorStatePaths,
	sessionId: string,
	input: { public_event_id: string; claim_fence: number; journal_seq: number },
	options: { signal?: AbortSignal } = {},
): Promise<OutboxEventV1> {
	const acknowledged = await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			const event = Object.values(transaction.outbox).find(item => item.public_event_id === input.public_event_id);
			if (!event) throw new Error("resource_gone");
			if (event.public_delivery.state === "acknowledged") {
				if (event.public_delivery.journal_seq !== input.journal_seq) throw new Error("terminal_uncertain");
				return structuredClone(event);
			}
			if (event.public_delivery.state !== "claimed" || event.public_delivery.claim_fence !== input.claim_fence)
				throw new Error("terminal_uncertain");
			event.public_delivery.state = "acknowledged";
			event.public_delivery.journal_seq = input.journal_seq;
			event.public_delivery.claim_expires_at = null;
			event.public_delivery.acknowledged_at = new Date().toISOString();
			return structuredClone(event);
		},
		options,
	);
	await pruneRetainedSessionIfEmpty(paths, sessionId, options);
	return acknowledged;
}

/** Enumerate retained intents independently of the active session roster. */
export async function enumeratePublicDeliveries(
	paths: CoordinatorStatePaths,
	cursor = "",
	limit = 64,
	options: { signal?: AbortSignal } = {},
): Promise<{
	claims: Array<PublicDeliveryClaimV1 & { session_id: string }>;
	next_cursor: string | null;
}> {
	const boundedLimit = Math.max(1, Math.min(limit, 128));
	const sessions = await withFileLock(
		paths.registryLock,
		async () => {
			const registry = await readJson<NamespaceRegistryV1>(paths.registry);
			if (!registry || registry.schema_version !== 1 || registry.namespace_id !== path.basename(paths.root))
				throw new Error("state_corrupt");
			return [...new Set([...Object.keys(registry.roster ?? {}), ...Object.keys(registry.retained_sessions ?? {})])]
				.filter(name => COORDINATOR_SESSION_ID_PATTERN.test(name))
				.sort();
		},
		lockOptions(options.signal),
	);
	const roundRobin = cursor.startsWith("@session:");
	const roundRobinSession = roundRobin ? cursor.slice("@session:".length) : "";
	const cursorSeparator = cursor.indexOf("\0");
	const cursorSession = cursorSeparator >= 0 ? cursor.slice(0, cursorSeparator) : cursor;
	const cursorOrderKey = cursor || "";
	const orderedSessions = roundRobin
		? (() => {
				const start = sessions.indexOf(roundRobinSession);
				return start < 0 ? sessions : [...sessions.slice(start + 1), ...sessions.slice(0, start + 1)];
			})()
		: sessions;
	const boundedSessions = orderedSessions.slice(0, Math.max(1, boundedLimit * 2));
	const claims: Array<PublicDeliveryClaimV1 & { session_id: string }> = [];
	let lastVisitedSession: string | null = null;
	for (const sessionId of boundedSessions) {
		lastVisitedSession = sessionId;
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		if (cursorSession && sessionId < cursorSession) continue;
		const afterOrderKey = sessionId === cursorSession ? cursorOrderKey : undefined;
		let batch: PublicDeliveryClaimV1[] = [];
		try {
			batch = await claimPublicDelivery(paths, sessionId, {
				...options,
				limit: boundedLimit,
				after_order_key: afterOrderKey,
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "resource_gone") throw error;
		}
		for (const claim of batch) claims.push({ ...claim, session_id: sessionId });
		if (claims.length >= boundedLimit) break;
	}
	const filtered = claims
		.filter(claim => deliveryOrderKey(claim.session_id, claim.event) > cursor)
		.slice(0, boundedLimit);
	const last = filtered.at(-1);
	return {
		claims: filtered,
		next_cursor: roundRobin
			? lastVisitedSession
				? `@session:${lastVisitedSession}`
				: cursor
			: last
				? deliveryOrderKey(last.session_id, last.event)
				: null,
	};
}

export function compactTransaction(transaction: CoordinatorSessionTransactionV1, now = Date.now()): void {
	normalizeOutbox(transaction);
	const old = (time: string): boolean => Date.parse(time) + RETENTION_MS < now;
	for (const [id, event] of Object.entries(transaction.outbox))
		if (
			event.emitted &&
			event.public_delivery.state === "acknowledged" &&
			event.transaction_revision < transaction.revision &&
			old(String(event.payload.created_at ?? ""))
		)
			delete transaction.outbox[id];
	for (const group of [transaction.requests.prompts, transaction.requests.answers, transaction.requests.operations])
		for (const [id, request] of Object.entries(group))
			if (
				request.phase === "completed" &&
				old(request.updated_at) &&
				JSON.stringify(transaction.canonical).includes(id) === false
			)
				delete group[id];
	if (Buffer.byteLength(JSON.stringify(transaction)) > MAX_NORMAL_BYTES + EMERGENCY_BYTES)
		throw new Error("query_unavailable");
}

/** Records projection repair after projecting complete canonical snapshots. */
export async function repairProjections(
	paths: CoordinatorStatePaths,
	sessionId: string,
	project: (canonical: CoordinatorSessionTransactionV1["canonical"]) => Promise<void>,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	let repairedRevision = 0;
	let repairedDigest = "";
	let repairedActive = false;
	await withSessionTransaction(
		paths,
		sessionId,
		async transaction => {
			await project(transaction.canonical);
			await appendOutboxEvents(paths, transaction);
			transaction.projection.applied_turns_revision = transaction.revision + 1;
			transaction.projection.applied_reports_revision = transaction.revision + 1;
			transaction.projection.applied_session_revision = transaction.revision + 1;
			transaction.projection.applied_active_revision = transaction.revision + 1;
			transaction.projection.scheduler_applied_revision = transaction.revision + 1;
			transaction.recovery.last_repaired_at = new Date().toISOString();
			repairedRevision = transaction.revision + 1;
			repairedDigest =
				transaction.projection.scheduler_digest ?? digest(JSON.stringify(transaction.canonical.queue));
			repairedActive = transaction.canonical.queue.active_turn_id !== null;
		},
		options,
	);
	await withNamespaceRegistry(paths, async registry => {
		registry.roster ??= {};
		registry.scheduler_revision = Math.max(registry.scheduler_revision ?? 0, repairedRevision);
		registry.roster[sessionId] = {
			session_id: sessionId,
			revision: repairedRevision,
			digest: repairedDigest,
			active: repairedActive,
			dirty: false,
			updated_at: new Date().toISOString(),
		};
	});
}

/** Advances a creation receipt only after its WAL or projection authority exists. */
export async function advanceCreationReceipt(
	paths: CoordinatorStatePaths,
	keyDigest: string,
	phase: "projected" | "completed" | "uncertain",
	safeResponse?: Record<string, unknown>,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const request = registry.creations[keyDigest];
		if (!request) throw new Error("state_corrupt");
		if (request.phase === phase) return;
		if (phase !== "uncertain" && request.phase !== "wal_committed" && request.phase !== "projected")
			throw new Error("state_corrupt");
		request.phase = phase;
		request.safe_response = safeResponse;
		request.updated_at = new Date().toISOString();
	});
}

export function hasEmergencyCapacity(
	transaction: CoordinatorSessionTransactionV1,
	incomingBytes: number,
	essential: boolean,
): boolean {
	const current = Buffer.byteLength(JSON.stringify(transaction));
	return (
		current + incomingBytes <= MAX_NORMAL_BYTES ||
		(essential && current + incomingBytes <= MAX_NORMAL_BYTES + EMERGENCY_BYTES)
	);
}

export async function recordDeletionIntent(
	paths: CoordinatorStatePaths,
	entry: NamespaceDeletionEntryV1,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const existing = registry.deletions[entry.deletion_id];
		if (existing && (existing.key_digest !== entry.key_digest || existing.request_digest !== entry.request_digest))
			throw new Error("idempotency_conflict");
		registry.deletions[entry.deletion_id] = existing ?? entry;
	});
}

export async function advanceDeletion(
	paths: CoordinatorStatePaths,
	deletionId: string,
	phase: NamespaceDeletionEntryV1["phase"],
	cleanup?: Partial<NamespaceDeletionEntryV1["cleanup"]>,
	safeResponse?: Record<string, unknown>,
): Promise<void> {
	await withNamespaceRegistry(paths, async registry => {
		const entry = registry.deletions[deletionId];
		if (!entry) throw new Error("resource_gone");
		entry.phase = phase;
		entry.cleanup = { ...entry.cleanup, ...cleanup };
		entry.updated_at = new Date().toISOString();
		if (safeResponse) entry.safe_response = safeResponse;
	});
}

/** Remove one incarnation's canonical WAL only after broker close is proven. */
export async function removeSessionTransaction(
	paths: CoordinatorStatePaths,
	sessionId: string,
	endpointIncarnation: string,
): Promise<boolean> {
	return await withNamespaceRegistry(
		paths,
		async registry =>
			await withFileLock(transactionLockPath(paths, sessionId), async () => {
				const file = transactionPath(paths, sessionId);
				const transaction = await readJson<CoordinatorSessionTransactionV1>(file);
				if (!transaction) return false;
				assertTransaction(transaction, path.basename(paths.root), sessionId);
				if (transaction.endpoint?.incarnation !== endpointIncarnation) throw new Error("endpoint_stale");
				await fs.rm(file, { force: true });
				await fsyncDirectory(path.dirname(file));
				delete registry.roster?.[sessionId];
				delete registry.retained_sessions?.[sessionId];
				return true;
			}),
	);
}
