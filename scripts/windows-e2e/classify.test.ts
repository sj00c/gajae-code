import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { classifyAttempt, detectionBound, normalizeObservation, type Observation, type Oracles, summarize } from "./classify";

const oracles = (await Bun.file(path.join(import.meta.dir, "oracles.v1.json")).json()) as Oracles;

function step(name: string, exit_code: number | null, text = "", timed_out = false) {
	return { name, kind: "step", exit_code, timed_out, stdout_tail: text, stderr_tail: "" };
}

function obs(overrides: Partial<Observation>): Observation {
	return {
		schema: "gjc.windows-e2e.observation.v1",
		scenario: "U1",
		shell: "pwsh",
		attempt: 1,
		dispatch_run_id: "100",
		updater_build: "pub:v0.21.0",
		target_tag: "v0.21.0",
		expected_version: "0.21.0",
		installer_rev: { source: "main:abc", sha256: "x" },
		steps: [step("install-prev", 0), step("update", 0)],
		marker: null,
		post_kill_record_phase: null,
		lock_observed: null,
		final: { version: "0.21.0", install_dir: [{ name: "gjc.exe", dir: false }], activation_phase: "none", crash_logs: [] },
		unbuildable: null,
		harness_error: null,
		...overrides,
	};
}

describe("oracles.v1.json", () => {
	test("every scenario declares its red and at least one checked step", () => {
		for (const [id, oracle] of Object.entries(oracles.scenarios)) {
			expect(oracle.declaredRed.length, id).toBeGreaterThan(0);
			expect((oracle.checkSteps?.length ?? 0) + (oracle.checkStepPrefixes?.length ?? 0), id).toBeGreaterThan(0);
		}
	});

	test("signature patterns compile", () => {
		for (const rule of oracles.signatures) expect(() => new RegExp(rule.pattern, "i")).not.toThrow();
	});
});

describe("classifyAttempt", () => {
	test("clean update is green", () => {
		expect(classifyAttempt(obs({}), oracles)).toEqual({ verdict: "green" });
	});

	test("failed update maps its output to a declared signature", () => {
		const result = classifyAttempt(obs({ steps: [step("update", 1, "Update failed: Error: target_changed")] }), oracles);
		expect(result).toMatchObject({ verdict: "red", signature: "target_changed" });
	});

	test("PowerShell-wrapped, colored error text still matches its signature", () => {
		const wrapped =
			"\u001b[31;1mThe process cannot access the file 'gjc.exe' because it is being used by another\u001b[0m\r\n\u001b[36;1m     | \u001b[31;1mprocess.";
		expect(classifyAttempt(obs({ steps: [step("update", 1, wrapped)] }), oracles)).toMatchObject({ signature: "sharing_violation" });
		const ps51 = "Copy-Item : The process cannot access the file 'gjc.exe' because it is being used by \r\nanother process.";
		expect(classifyAttempt(obs({ steps: [step("update", 1, ps51)] }), oracles)).toMatchObject({ signature: "sharing_violation" });
	});

	test("gc's missing tmux provider alone does not fail the lock scenario, a lock error still does", () => {
		const l4 = (gcText: string) =>
			obs({ scenario: "L4", lock_observed: true, steps: [step("config-set-r1-1", 0), step("gc-r1", 1, gcText)] });
		expect(classifyAttempt(l4('"message": "gjc_tmux_provider_unavailable — GJC searched"'), oracles).verdict).toBe("green");
		expect(classifyAttempt(l4("EBADF: bad file descriptor; gjc_tmux_provider_unavailable"), oracles)).toMatchObject({
			signature: "ebadf",
		});
	});

	test("unknown failure falls back to an exit-code signature; timeout is red, not a harness defect", () => {
		expect(classifyAttempt(obs({ steps: [step("update", 3, "boom")] }), oracles)).toMatchObject({ signature: "exit:3:update" });
		expect(classifyAttempt(obs({ steps: [step("update", null, "", true)] }), oracles)).toMatchObject({
			verdict: "red",
			signature: "timeout:update",
		});
	});

	test("leftover staging files and a non-terminal activation record are red", () => {
		const leftovers = obs({
			final: { version: "0.21.0", install_dir: [{ name: ".gjc.bak.1234", dir: false }], activation_phase: "none", crash_logs: [] },
		});
		expect(classifyAttempt(leftovers, oracles)).toMatchObject({ signature: "leftover-files" });
		const pending = obs({ final: { version: "0.21.0", install_dir: [], activation_phase: "staged", crash_logs: [] } });
		expect(classifyAttempt(pending, oracles)).toMatchObject({ signature: "activation-phase:staged" });
	});

	test("kill scenarios: a missed marker is a harness defect, an uncounted phase is precondition-invalid", () => {
		const base = { scenario: "U2" };
		expect(classifyAttempt(obs({ ...base, marker: { name: "m", observed: false } }), oracles).verdict).toBe("harness-defect");
		expect(
			classifyAttempt(obs({ ...base, marker: { name: "m", observed: true }, post_kill_record_phase: "verified" }), oracles)
				.verdict,
		).toBe("precondition-invalid");
		expect(
			classifyAttempt(obs({ ...base, marker: { name: "m", observed: true }, post_kill_record_phase: "staged" }), oracles)
				.verdict,
		).toBe("green");
	});

	test("precondition errors and harness errors stay out of product verdicts", () => {
		expect(classifyAttempt(obs({ harness_error: "precondition: installing v0.20.0 failed" }), oracles).verdict).toBe(
			"precondition-invalid",
		);
		expect(classifyAttempt(obs({ harness_error: "Cannot bind argument" }), oracles).verdict).toBe("harness-defect");
	});

	test("lock drivers: documented contention passes, access_denied and crash logs are red, no observed lock is unbuildable", () => {
		const lock = { scenario: "L1", lock_observed: true };
		expect(
			classifyAttempt(obs({ ...lock, steps: [step("config-set-r1-1", 1, "Failed to acquire lock for x after 5000ms")] }), oracles),
		).toEqual({ verdict: "green" });
		expect(classifyAttempt(obs({ ...lock, steps: [step("config-set-r1-1", 1, "access_denied")] }), oracles)).toMatchObject({
			signature: "access_denied",
		});
		expect(
			classifyAttempt(
				obs({
					...lock,
					steps: [step("config-set-r1-1", 0)],
					final: { version: "0.21.0", install_dir: [], activation_phase: "none", crash_logs: [{ path: "gjc-crash.log", tail: "" }] },
				}),
				oracles,
			),
		).toMatchObject({ signature: "crash-log" });
		expect(classifyAttempt(obs({ scenario: "L1", lock_observed: false, steps: [step("config-set-r1-1", 0)] }), oracles).verdict).toBe(
			"unbuildable",
		);
	});

	test("legacy broker lock: public refusal passes, operation_failed is red", () => {
		const l3 = (text: string) => obs({ scenario: "L3", steps: [step("sdk-list-legacy-alive", 1, text), step("sdk-list-legacy-dead", 0)] });
		expect(classifyAttempt(l3('{"ok":false,"error":{"code":"broker_unavailable"}}'), oracles).verdict).toBe("green");
		expect(classifyAttempt(l3('{"error":{"code":"operation_failed"}}'), oracles)).toMatchObject({ signature: "operation_failed" });
	});

	test("concurrent installers: one documented refusal passes, two failures are red", () => {
		const i3 = (a: number, b: number) =>
			obs({
				scenario: "I3",
				expected_version: "0.20.0",
				steps: [step("installer-a", a, a ? "Another GJC installer is already running" : ""), step("installer-b", b, b ? "Another GJC installer is already running" : "")],
				final: { version: "0.20.0", install_dir: [{ name: "gjc.exe", dir: false }], activation_phase: "none", crash_logs: [] },
			});
		expect(classifyAttempt(i3(0, 1), oracles).verdict).toBe("green");
		expect(classifyAttempt(i3(1, 1), oracles)).toMatchObject({ verdict: "red", signature: "all-steps-failed" });
	});
});

describe("normalizeObservation", () => {
	test("accepts PowerShell's collapsed one-element and empty arrays", () => {
		const raw = obs({}) as unknown as Record<string, unknown>;
		raw.final = { version: "0.21.0", install_dir: { name: ".gjc.bak.1", dir: false }, activation_phase: "none", crash_logs: null };
		const normalized = normalizeObservation(raw as unknown as Observation);
		expect(normalized.final?.install_dir).toEqual([{ name: ".gjc.bak.1", dir: false }]);
		expect(normalized.final?.crash_logs).toEqual([]);
		expect(classifyAttempt(normalized, oracles)).toMatchObject({ signature: "leftover-files" });
	});
});

describe("summarize", () => {
	const red = (dispatch: string) => ({
		obs: obs({ dispatch_run_id: dispatch }),
		result: { verdict: "red" as const, signature: "target_changed", detail: "" },
	});
	const green = (dispatch: string) => ({ obs: obs({ dispatch_run_id: dispatch }), result: { verdict: "green" as const } });

	test("the same signature in two dispatches is red; in one dispatch it is inconclusive", () => {
		expect(summarize([red("1"), red("1"), green("2")])[0]).toMatchObject({ verdict: "inconclusive", reds: 2 });
		expect(summarize([red("1"), red("2"), green("2")])[0]).toMatchObject({ verdict: "red", redDispatches: ["1", "2"] });
	});

	test("all-green axes report the 95% detection bound and ignore uncounted attempts", () => {
		const entries = [
			green("1"),
			green("1"),
			{ obs: obs({ dispatch_run_id: "2" }), result: { verdict: "harness-defect" as const, detail: "" } },
		];
		const summary = summarize(entries)[0];
		expect(summary.verdict).toBe("green");
		expect(summary.counted).toBe(2);
		expect(summary.other).toEqual({ "harness-defect": 1 });
		expect(summary.excludedRateAtOrAbove).toBeCloseTo(detectionBound(2));
		expect(detectionBound(10)).toBeCloseTo(0.2589, 3);
	});
});
