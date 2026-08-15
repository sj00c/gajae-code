import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	isHighRiskChangePath,
	isMigrationChangePath,
	resolveUltragoalValidationApplicability,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-validation-policy";
import {
	hashWorkflowRecoveryProjection,
	isWorkflowRecoveryStalled,
	projectLatestRalplanRun,
	projectRalplanFinalRun,
	projectUltragoalRun,
	trackWorkflowRecoveryZeroProgress,
	ZERO_PROGRESS_STALL_THRESHOLD,
} from "@gajae-code/coding-agent/gjc-runtime/workflow-recovery-projection";
import { TempDir } from "@gajae-code/utils";

const SESSION_ID = "sess-4560";

function ralplanRunDir(cwd: string, runId: string): string {
	return path.join(cwd, ".gjc", `_session-${SESSION_ID}`, "plans", "ralplan", runId);
}

const FINAL_PLAN = `Fix widget parser performance regression.

## Decision
Use bounded lookahead instead of full-buffer regex.

## Accepted Scope
- parser/lookahead.ts
- parser/bench fixture

## Non-Goals
- Rewriting the tokenizer
- CLI flag changes

## Acceptance Criteria
- bun test parser suite passes
- P95 parse latency improves
`;

function ultragoalDir(cwd: string): string {
	return path.join(cwd, ".gjc", `_session-${SESSION_ID}`, "ultragoal");
}

describe("workflow recovery projection (#4560)", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-4560-recovery-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("projects a ralplan final run with scope, non-goals, AC, and digest", async () => {
		const runDir = ralplanRunDir(tempDir.path(), "run-1");
		const digest = crypto.createHash("sha256").update(FINAL_PLAN).digest("hex");
		await Bun.write(
			path.join(runDir, "index.jsonl"),
			`${JSON.stringify({ stage: "planner", stage_n: 1, path: "stage-01-planner.md", sha256: "aa" })}\n${JSON.stringify({ stage: "final", stage_n: 2, path: "stage-02-final.md", sha256: digest })}\n`,
		);
		await Bun.write(path.join(runDir, "stage-02-final.md"), FINAL_PLAN);
		const projection = await projectRalplanFinalRun({ cwd: tempDir.path(), sessionId: SESSION_ID, runId: "run-1" });
		expect(projection).toBeDefined();
		expect(projection?.skill).toBe("ralplan");
		expect(projection?.objective).toContain("widget parser");
		expect(projection?.scope.some(item => item.kind === "non_goal" && item.text.includes("tokenizer"))).toBe(true);
		expect(projection?.acceptanceCriteria.some(text => text.includes("parser suite"))).toBe(true);
		expect(projection?.provenance.sha256).toMatch(/^sha256:/);
		expect(projection?.zeroProgress.fingerprint).toMatch(/^sha256:/);
		expect(projection?.zeroProgress.stalled).toBe(false);
	});

	it("rejects escaped, non-string, and digest-mismatched ralplan artifacts", async () => {
		const outsidePath = path.join(tempDir.path(), "outside.md");
		await Bun.write(outsidePath, "secret outside contract\n");
		for (const [runId, artifactPath, sha256] of [
			["absolute", outsidePath, undefined],
			["relative", "../../../../../outside.md", undefined],
			["typed", 123, undefined],
			["digest", "stage-01-final.md", "0".repeat(64)],
		] as const) {
			const runDir = ralplanRunDir(tempDir.path(), runId);
			await Bun.write(path.join(runDir, "stage-01-final.md"), FINAL_PLAN);
			await Bun.write(
				path.join(runDir, "index.jsonl"),
				`${JSON.stringify({ stage: "final", stage_n: 1, path: artifactPath, sha256 })}\n`,
			);
			await expect(
				projectRalplanFinalRun({ cwd: tempDir.path(), sessionId: SESSION_ID, runId }),
			).resolves.toBeUndefined();
		}
	});

	it("uses the durable active ralplan run and skips unfinished legacy candidates", async () => {
		const validDir = ralplanRunDir(tempDir.path(), "valid-run");
		await Bun.write(path.join(validDir, "stage-01-final.md"), FINAL_PLAN);
		await Bun.write(
			path.join(validDir, "index.jsonl"),
			`${JSON.stringify({ stage: "final", stage_n: 1, path: "stage-01-final.md" })}\n`,
		);
		const unfinishedDir = ralplanRunDir(tempDir.path(), "unfinished-run");
		await Bun.write(
			path.join(unfinishedDir, "index.jsonl"),
			`${JSON.stringify({ stage: "planner", stage_n: 1, path: "stage-01-planner.md" })}\n`,
		);
		const discovered = await projectLatestRalplanRun({ cwd: tempDir.path(), sessionId: SESSION_ID });
		expect(discovered?.provenance.runId).toBe("valid-run");

		await Bun.write(
			path.join(tempDir.path(), ".gjc", `_session-${SESSION_ID}`, "state", "ralplan-state.json"),
			JSON.stringify({ run_id: "unfinished-run" }),
		);
		const activeUnfinished = await projectLatestRalplanRun({ cwd: tempDir.path(), sessionId: SESSION_ID });
		expect(activeUnfinished).toBeUndefined();
	});

	it("degrades safely for malformed ralplan index (no final row)", async () => {
		const runDir = ralplanRunDir(tempDir.path(), "run-2");
		await Bun.write(path.join(runDir, "index.jsonl"), "not-json\n");
		const projection = await projectRalplanFinalRun({ cwd: tempDir.path(), sessionId: SESSION_ID, runId: "run-2" });
		expect(projection).toBeUndefined();
	});

	it("degrades safely when the final artifact is missing", async () => {
		const runDir = ralplanRunDir(tempDir.path(), "run-3");
		await Bun.write(
			path.join(runDir, "index.jsonl"),
			`${JSON.stringify({ stage: "final", stage_n: 1, path: "missing.md" })}\n`,
		);
		const projection = await projectRalplanFinalRun({ cwd: tempDir.path(), sessionId: SESSION_ID, runId: "run-3" });
		expect(projection).toBeUndefined();
	});

	it("projects ultragoal durable plan with current goal, progress, and next action", async () => {
		const dir = ultragoalDir(tempDir.path());
		const now = new Date().toISOString();
		await Bun.write(
			path.join(dir, "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcGoalMode: "aggregate",
				gjcObjective: "Ship parser fix",
				goals: [
					{
						id: "G001",
						title: "Fix parser",
						objective: "Fix the parser",
						status: "complete",
						createdAt: now,
						updatedAt: now,
						evidence: "tests pass",
					},
					{
						id: "G002",
						title: "Docs",
						objective: "Document it",
						status: "active",
						createdAt: now,
						updatedAt: now,
					},
				],
				createdAt: now,
				updatedAt: now,
			}),
		);
		await Bun.write(
			path.join(dir, "ledger.jsonl"),
			`${JSON.stringify({
				eventId: "e1",
				event: "goal_checkpointed",
				goalId: "G001",
				status: "complete",
				evidence: "parallel executor work joined before boundary review",
				qualityGateJson: {
					iteration: { reviewCohort: { reviewGeneration: 2, sourceHash: "sha256:frozen", joined: true } },
				},
			})}\n`,
		);
		const projection = await projectUltragoalRun({ cwd: tempDir.path(), sessionId: SESSION_ID });
		expect(projection?.skill).toBe("ultragoal");
		expect(projection?.currentGoal?.goalId).toBe("G002");
		expect(projection?.progress.totalGoals).toBe(2);
		expect(projection?.progress.completedGoals).toBe(1);
		expect(projection?.progress.outstandingGoals).toBe(1);
		expect(projection?.progress.latestReviewGeneration).toBe(2);
		expect(projection?.progress.latestCohortSourceHash).toBe("sha256:frozen");
		expect(projection?.nextAction.actionClass).toBe("continue-current-goal");
		expect(projection?.nextAction.goalId).toBe("G002");
	});

	it("recovers blocker-fix re-review as the exact next action", async () => {
		const dir = ultragoalDir(tempDir.path());
		const now = new Date().toISOString();
		await Bun.write(
			path.join(dir, "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcGoalMode: "aggregate",
				gjcObjective: "Ship recovery",
				goals: [
					{
						id: "G001",
						title: "Ship",
						objective: "Ship",
						status: "review_blocked",
						createdAt: now,
						updatedAt: now,
						evidence: "joined cohort found a blocker",
					},
				],
				createdAt: now,
				updatedAt: now,
			}),
		);
		const projection = await projectUltragoalRun({ cwd: tempDir.path(), sessionId: SESSION_ID });
		expect(projection?.nextAction).toMatchObject({ actionClass: "resolve-review-blockers", goalId: "G001" });
		expect(projection?.unresolved).toContain("review blockers open on G001");
	});

	it("degrades safely for tampered ultragoal plan", async () => {
		const dir = ultragoalDir(tempDir.path());
		await Bun.write(path.join(dir, "goals.json"), "{not json");
		const projection = await projectUltragoalRun({ cwd: tempDir.path(), sessionId: SESSION_ID });
		expect(projection).toBeUndefined();
	});

	it("degrades safely for a truncated ultragoal ledger", async () => {
		const dir = ultragoalDir(tempDir.path());
		const now = new Date().toISOString();
		await Bun.write(
			path.join(dir, "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcGoalMode: "aggregate",
				gjcObjective: "Ship parser fix",
				goals: [{ id: "G001", title: "Fix", objective: "Fix", status: "active", createdAt: now, updatedAt: now }],
				createdAt: now,
				updatedAt: now,
			}),
		);
		await Bun.write(path.join(dir, "ledger.jsonl"), '{"event":"goal_started"}\n{"event":');
		await expect(projectUltragoalRun({ cwd: tempDir.path(), sessionId: SESSION_ID })).resolves.toBeUndefined();
	});

	it("bounds zero-progress cycles by durable fingerprint", () => {
		const runDirBasis = {
			objective: "same",
			scope: [],
			acceptanceCriteria: [],
			unresolved: [],
			provenance: {},
			progress: { totalGoals: 2, completedGoals: 1 },
			nextAction: { actionClass: "continue-current-goal" as const },
			skill: "ultragoal" as const,
			source: "ultragoal-plan" as const,
		};
		const progressed = { ...runDirBasis, progress: { totalGoals: 2, completedGoals: 2 } };
		const a = { ...runDirBasis, zeroProgress: { fingerprint: "f1", unchangedObservations: 0, stalled: false } };
		const unchanged = trackWorkflowRecoveryZeroProgress(
			{ lastFingerprint: hashWorkflowRecoveryProjection(a), unchangedObservations: 0 },
			a,
		);
		expect(unchanged.unchangedObservations).toBe(1);
		const stalledMemory = trackWorkflowRecoveryZeroProgress(unchanged, a);
		expect(stalledMemory.unchangedObservations).toBe(ZERO_PROGRESS_STALL_THRESHOLD);
		expect(isWorkflowRecoveryStalled(stalledMemory)).toBe(true);
		const recovered = trackWorkflowRecoveryZeroProgress(stalledMemory, { ...a, ...progressed } as typeof a);
		expect(recovered.unchangedObservations).toBe(0);
		expect(isWorkflowRecoveryStalled(recovered)).toBe(false);
	});
});

describe("ultragoal validation applicability policy (#4560)", () => {
	const lowRiskChangeSet = {
		source: "checkpoint-git" as const,
		paths: [{ path: "packages/coding-agent/src/widgets/parse.ts", status: "modified" as const }],
		trusted: true as const,
	};

	it("selects low risk for a single-goal trusted low-risk change set", () => {
		const applicability = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			totalGoals: 1,
			completedGoals: 0,
			authoritativeSourceHash: "sha256:current",
		});
		expect(applicability.riskClass).toBe("low");
		expect(applicability.lanes.qa.applicable).toBe(true);
		expect(applicability.lanes.cleaner.applicable).toBe(false);
		expect(applicability.lanes.architect.applicable).toBe(false);
		expect(applicability.lanes["terminal-critic"].applicable).toBe(false);
	});

	it("keeps the full heavyweight cohort for high-risk paths", () => {
		const applicability = resolveUltragoalValidationApplicability({
			changeSet: {
				...lowRiskChangeSet,
				paths: [{ path: "packages/coding-agent/src/sdk/session.ts", status: "modified" as const }],
			},
			totalGoals: 1,
			completedGoals: 0,
		});
		expect(applicability.riskClass).toBe("high");
		expect(applicability.heavyweight).toBe(true);
		expect(applicability.lanes.cleaner.applicable).toBe(true);
		expect(applicability.lanes.architect.applicable).toBe(true);
		expect(applicability.lanes.qa.applicable).toBe(true);
	});

	it("keeps heavyweight for computer/shared-registry and migration paths", () => {
		const computer = resolveUltragoalValidationApplicability({
			changeSet: {
				...lowRiskChangeSet,
				paths: [{ path: "packages/coding-agent/src/tools/index.ts", status: "modified" as const }],
			},
			totalGoals: 1,
			completedGoals: 0,
		});
		expect(computer.riskClass).toBe("high");
		const migration = resolveUltragoalValidationApplicability({
			changeSet: {
				...lowRiskChangeSet,
				paths: [
					{ path: "packages/coding-agent/src/gjc-runtime/state-migrations/index.ts", status: "modified" as const },
				],
			},
			totalGoals: 1,
			completedGoals: 0,
		});
		expect(migration.riskClass).toBe("high");
		expect(
			isHighRiskChangePath({ path: "packages/coding-agent/src/session/auth-storage.ts", status: "modified" }),
		).toBe(true);
		expect(
			isHighRiskChangePath({
				path: "./packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts",
				status: "modified",
			}),
		).toBe(true);
		expect(
			isMigrationChangePath({
				path: "packages\\coding-agent\\src\\session\\session-manager.ts",
				status: "modified",
			}),
		).toBe(true);
	});

	it("fails closed on missing/untrusted change set and multi-goal runs", () => {
		const missing = resolveUltragoalValidationApplicability({ totalGoals: 1, completedGoals: 0 });
		expect(missing.riskClass).toBe("high");
		expect(missing.selection.some(line => line.includes("change-set-untrusted-or-missing"))).toBe(true);
		const multi = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			totalGoals: 3,
			completedGoals: 1,
		});
		expect(multi.riskClass).toBe("high");
	});

	it("permits unchanged-basis reuse only when the frozen hash matches and no blockers reopened", () => {
		const unchanged = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			totalGoals: 1,
			completedGoals: 0,
			latestCohortSourceHash: "sha256:abc",
			currentSourceHash: "sha256:abc",
			authoritativeSourceHash: "sha256:abc",
		});
		expect(unchanged.basisUnchanged).toBe(true);
		const changed = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			totalGoals: 1,
			completedGoals: 0,
			latestCohortSourceHash: "sha256:abc",
			currentSourceHash: "sha256:xyz",
			authoritativeSourceHash: "sha256:xyz",
		});
		expect(changed.basisUnchanged).toBe(false);
		const blocked = resolveUltragoalValidationApplicability({
			changeSet: lowRiskChangeSet,
			totalGoals: 1,
			completedGoals: 0,
			latestCohortSourceHash: "sha256:abc",
			currentSourceHash: "sha256:abc",
			authoritativeSourceHash: "sha256:abc",
			hasOpenReviewBlockers: true,
		});
		expect(blocked.basisUnchanged).toBe(false);
		expect(blocked.riskClass).toBe("high");
	});

	it("classifies high-risk and migration paths deterministically", () => {
		expect(isHighRiskChangePath({ path: "packages/coding-agent/src/sdk/protocol/x.ts", status: "modified" })).toBe(
			true,
		);
		expect(isHighRiskChangePath({ path: "packages/utils/src/x.ts", status: "modified" })).toBe(false);
		expect(isMigrationChangePath({ path: "scripts/release.ts", status: "modified" })).toBe(true);
		expect(isMigrationChangePath({ path: "packages/utils/src/x.ts", status: "modified" })).toBe(false);
	});
});
