import type { KindAwareReconciliation } from "./bus/kind-aware-reconciliation";
import type { InvocationCorrelation, InvocationReconciliation } from "./host/session-runtime";
import {
	createPromptDeadlineLease,
	isAttributableProgressEventType,
	type PromptDeadlineLease,
	promptDeadlineAt,
	recordAttributableProgress,
} from "./prompt-deadline-lease";

const MAX_EXPIRY_RETRIES = 5;
const EXPIRY_RETRY_DELAY_MS = 1_000;

type DeadlineReconciliation = InvocationReconciliation | KindAwareReconciliation;

export type PromptDeadlineOutcome = {
	kind: "failed";
	code: "prompt_deadline_exceeded";
	message: string;
	provenance: "deadline";
};

function leaseKey(correlation: InvocationCorrelation): string {
	return `${correlation.commandId}:${correlation.turnId}`;
}

export class PromptDeadlineManager {
	readonly #leases = new Map<string, PromptDeadlineLease>();
	readonly #correlations = new Map<string, InvocationCorrelation>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #reconciliation: DeadlineReconciliation;
	readonly #expiryRetries = new Map<string, number>();
	readonly #expiring = new Set<string>();
	readonly #pendingTerminalTransitions = new Set<string>();
	readonly #getLeaseMs: () => number;
	readonly #getMaxMs: () => number;
	readonly #now: () => number;
	readonly #onExpired?: (correlation: InvocationCorrelation) => void;

	constructor(options: {
		reconciliation: DeadlineReconciliation;
		getLeaseMs: () => number;
		getMaxMs: () => number;
		now?: () => number;
		onExpired?: (correlation: InvocationCorrelation) => void;
	}) {
		this.#reconciliation = options.reconciliation;
		this.#getLeaseMs = options.getLeaseMs;
		this.#getMaxMs = options.getMaxMs;
		this.#now = options.now ?? Date.now;
		this.#onExpired = options.onExpired;
	}

	#clearTimer(key: string): void {
		const timer = this.#timers.get(key);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(key);
		}
	}

	#schedule(key: string): void {
		const lease = this.#leases.get(key);
		if (!lease) return;
		this.#clearTimer(key);
		const deadlineAt = promptDeadlineAt(lease);
		const delayMs = Math.max(0, deadlineAt - this.#now());
		const timer = setTimeout(() => {
			void this.#onDeadline(key);
		}, delayMs);
		// Allow process to exit without waiting for deadline timer.
		(timer as unknown as { unref?: () => void }).unref?.();
		this.#timers.set(key, timer);
	}

	async #onDeadline(key: string): Promise<void> {
		const correlation = this.#correlations.get(key);
		const lease = this.#leases.get(key);
		if (!correlation || !lease) return;
		// Re-check deadline still due (monotonic, but handle clock skew).
		if (this.#now() < promptDeadlineAt(lease)) {
			this.#schedule(key);
			return;
		}
		// Fence lifecycle adoption before replaying a real terminal transition.
		// A successor agent_start must not drain this correlation while its
		// durable upgrade is still pending or being retried.
		this.#expiring.add(key);
		if (this.#pendingTerminalTransitions.has(key)) {
			try {
				await this.#reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
				this.#expiryRetries.delete(key);
				this.#onExpired?.(correlation);
				this.clear(correlation);
			} catch {
				this.#retry(key);
			}
			return;
		}
		let lookup: { status: string };
		try {
			lookup = this.#reconciliation.lookup("prompt", correlation) as { status: string };
		} catch {
			this.#retry(key);
			return;
		}
		if (lookup.status === "terminal_ok" || lookup.status === "failed") {
			this.clear(correlation);
			return;
		}
		const generation = lease.generation;
		const outcome: PromptDeadlineOutcome = {
			kind: "failed",
			code: "prompt_deadline_exceeded",
			message: "Prompt deadline exceeded.",
			provenance: "deadline",
		};
		try {
			await this.#reconciliation.claimPendingOutcome("prompt", correlation, outcome);
		} catch {
			// claim may fail if already claimed (e.g., cancellation won); ignore.
		}
		// Re-verify the captured lease is still authoritative after the claim
		// await (exact-head review P2): fresh attributable progress during the
		// claim must cancel this expiry instance instead of surfacing an exceeded
		// outcome for a prompt that is demonstrably alive.
		if (this.#backOffIfSuperseded(key, lease, generation)) return;
		try {
			await this.#reconciliation.finalizeOutcome("prompt", correlation, outcome, () => {
				const current = this.#leases.get(key);
				return current === lease && current.generation === generation;
			});
		} catch {
			// Do not infer durable confirmation from an in-memory lookup after a
			// failed write. The accepted lease and ownership stay recoverable until
			// a later retry observes a successful finalization.
			this.#retry(key);
			return;
		}
		// Finalization is generation-aware too (exact-head review P2): progress
		// observed during the finalize await renews the lease past its deadline,
		// so this expiry pass must not retire the now-live invocation's pending
		// ownership even though the finalize write landed.
		if (this.#backOffIfSuperseded(key, lease, generation)) return;
		// Retire pending ownership ONLY after durable terminal confirmation with
		// no superseding progress (#4668 review P1): retiring earlier strands an
		// accepted/in-flight invocation without an owner, retry, or deadline
		// recovery path.
		try {
			this.#onExpired?.(correlation);
		} catch {}
		this.#expiryRetries.delete(key);
		this.clear(correlation);
	}

	/**
	 * After an awaited reconciliation call, verify the captured lease is still
	 * authoritative. Fresh attributable progress during the await advances the
	 * lease generation and its deadline; when superseded, cancel this expiry
	 * instance (release the expiration fence, clear any retry budget, and
	 * reschedule the deadline) and report it so the caller stops. A cleared or
	 * re-accepted lease is stale by identity too.
	 */
	#backOffIfSuperseded(key: string, lease: PromptDeadlineLease, generation: number): boolean {
		const current = this.#leases.get(key);
		if (current !== lease || current.generation !== generation || this.#now() < promptDeadlineAt(current)) {
			this.#expiring.delete(key);
			this.#expiryRetries.delete(key);
			if (current) this.#schedule(key);
			return true;
		}
		return false;
	}

	#retry(key: string): void {
		const attempts = (this.#expiryRetries.get(key) ?? 0) + 1;
		this.#expiryRetries.set(key, attempts);
		this.#clearTimer(key);
		if (attempts > MAX_EXPIRY_RETRIES) return;
		const timer = setTimeout(() => void this.#onDeadline(key), EXPIRY_RETRY_DELAY_MS);
		(timer as unknown as { unref?: () => void }).unref?.();
		this.#timers.set(key, timer);
	}

	onAccepted(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		if (this.#leases.has(key)) return;
		const now = this.#now();
		const lease = createPromptDeadlineLease({ now, leaseMs: this.#getLeaseMs(), maxMs: this.#getMaxMs() });
		this.#leases.set(key, lease);
		this.#correlations.set(key, correlation);
		this.#schedule(key);
	}

	onProgress(correlation: InvocationCorrelation, now = this.#now()): void {
		const key = leaseKey(correlation);
		const lease = this.#leases.get(key);
		if (!lease) return;
		const beforeDeadline = promptDeadlineAt(lease);
		recordAttributableProgress(lease, now);
		const afterDeadline = promptDeadlineAt(lease);
		if (this.#expiring.delete(key)) this.#expiryRetries.delete(key);
		if (afterDeadline !== beforeDeadline || !this.#expiring.has(key)) this.#schedule(key);
	}

	onAttributableEvent(correlation: InvocationCorrelation, eventType: string, now = this.#now()): void {
		if (!isAttributableProgressEventType(eventType)) return;
		this.onProgress(correlation, now);
	}

	/** Mark a real agent_end before durable reconciliation begins. If its upgrade
	 * write fails, deadline retry replays this event instead of reasserting the
	 * synthetic prompt_deadline_exceeded outcome. */
	noteTerminalTransition(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		if (!this.#leases.has(key)) return;
		this.#pendingTerminalTransitions.add(key);
	}

	clear(correlation: InvocationCorrelation): void {
		const key = leaseKey(correlation);
		this.#clearTimer(key);
		this.#leases.delete(key);
		this.#correlations.delete(key);
		this.#expiryRetries.delete(key);
		this.#expiring.delete(key);
		this.#pendingTerminalTransitions.delete(key);
	}

	clearAll(): void {
		for (const key of [...this.#timers.keys()]) this.#clearTimer(key);
		this.#leases.clear();
		this.#correlations.clear();
		this.#expiryRetries.clear();
		this.#expiring.clear();
		this.#pendingTerminalTransitions.clear();
	}

	/** For tests: current deadline or undefined if no lease. */
	deadlineAt(correlation: InvocationCorrelation): number | undefined {
		const lease = this.#leases.get(leaseKey(correlation));
		return lease ? promptDeadlineAt(lease) : undefined;
	}

	/** For tests: whether a lease exists. */
	has(correlation: InvocationCorrelation): boolean {
		return this.#leases.has(leaseKey(correlation));
	}

	/** Whether expiry has fenced this correlation from late run adoption. */
	isExpiring(correlation: InvocationCorrelation): boolean {
		return this.#expiring.has(leaseKey(correlation));
	}
}
