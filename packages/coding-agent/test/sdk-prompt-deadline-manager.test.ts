import { describe, expect, test } from "bun:test";
import { PromptDeadlineManager } from "../src/sdk/prompt-deadline-manager";

/**
 * Issue #4668 exact-head review (P1): when expiry reconciliation fails, the
 * deadline manager must not drop the deadline lease and pending ownership.
 * Pending ownership is retired only after durable terminal confirmation;
 * otherwise the lease is retained and reconciliation is retried boundedly.
 */

interface FakeReconciliation {
	status: string;
	finalizeFailures: number;
	finalizeCalls: number;
	claimStarted?: () => void;
	claimRelease?: Promise<void>;
	/** When set, a failing finalize still leaves the durable record terminal (lost race). */
	terminalOnFailure?: boolean;
}

function fakeReconciliation(): {
	reconciliation: {
		lookup: () => { status: string };
		claimPendingOutcome: () => Promise<void>;
		finalizeOutcome: () => Promise<void>;
	};
	state: FakeReconciliation;
} {
	const state: FakeReconciliation = { status: "running", finalizeFailures: 0, finalizeCalls: 0 };
	return {
		state,
		reconciliation: {
			lookup: () => ({ status: state.status }),
			claimPendingOutcome: async () => {
				state.claimStarted?.();
				if (state.claimRelease) await state.claimRelease;
			},
			finalizeOutcome: async () => {
				state.finalizeCalls += 1;
				if (state.finalizeCalls <= state.finalizeFailures) {
					// Race simulation: a normal terminal transition won while the
					// expiry finalize was in flight — the record IS terminal, the
					// finalize call itself throws.
					if (state.terminalOnFailure) state.status = "terminal_ok";
					throw new Error("durable write failed");
				}
				state.status = "failed";
			},
		},
	};
}

describe("PromptDeadlineManager expiry reconciliation (#4668)", () => {
	test("retains lease and pending ownership when finalize fails, retires after durable confirmation", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = 1; // first expiry pass fails, the retry succeeds
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-1", turnId: "turn-1" };
		manager.onAccepted(correlation);
		// First deadline pass: finalize throws and the record is NOT terminal, so
		// neither onExpired nor lease cleanup may run.
		await Bun.sleep(120);
		expect(expired).toBe(0);
		expect(manager.has(correlation)).toBe(true);
		// The bounded retry lands the durable terminal outcome: only then is
		// pending ownership retired and the lease cleared.
		await Bun.sleep(2_300);
		expect(state.finalizeCalls).toBeGreaterThanOrEqual(2);
		expect(expired).toBe(1);
		expect(manager.has(correlation)).toBe(false);
		manager.clearAll();
	});

	test("a failed finalize never infers durable terminality from an in-memory lookup", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER; // finalize always throws...
		state.terminalOnFailure = true; // the in-memory map reports a terminal race
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-2", turnId: "turn-2" };
		manager.onAccepted(correlation);
		await Bun.sleep(120);
		// A failed persistence call is not durable confirmation, even if a
		// concurrent in-memory transition appears terminal.
		expect(expired).toBe(0);
		expect(manager.has(correlation)).toBe(true);
		manager.clearAll();
	});

	test("fences late adoption while expiry persistence is suspended", async () => {
		const gate = Promise.withResolvers<void>();
		const { reconciliation, state } = fakeReconciliation();
		state.claimRelease = gate.promise;
		const started = Promise.withResolvers<void>();
		state.claimStarted = () => started.resolve();
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
		});
		const correlation = { commandId: "cmd-fence", turnId: "turn-fence" };
		manager.onAccepted(correlation);
		await started.promise;
		expect(manager.isExpiring(correlation)).toBe(true);
		gate.resolve();
		await Bun.sleep(30);
		manager.clearAll();
	});

	test("the retry budget is bounded: a persistently failing store parks the lease without dropping ownership", async () => {
		const { reconciliation, state } = fakeReconciliation();
		state.finalizeFailures = Number.MAX_SAFE_INTEGER;
		let expired = 0;
		const manager = new PromptDeadlineManager({
			reconciliation: reconciliation as never,
			getLeaseMs: () => 20,
			getMaxMs: () => 60_000,
			onExpired: () => {
				expired += 1;
			},
		});
		const correlation = { commandId: "cmd-3", turnId: "turn-3" };
		manager.onAccepted(correlation);
		// Initial pass + bounded retries (5 x 1s). Ownership is never retired
		// without durable terminal confirmation.
		await Bun.sleep(6_800);
		expect(expired).toBe(0);
		expect(state.finalizeCalls).toBeLessThanOrEqual(7);
		// The lease is retained (recovery path), only the timer is parked.
		expect(manager.has(correlation)).toBe(true);
		const callsAfterPark = state.finalizeCalls;
		await Bun.sleep(1_300);
		expect(state.finalizeCalls).toBe(callsAfterPark);
		manager.clearAll();
	}, 15_000);
});
