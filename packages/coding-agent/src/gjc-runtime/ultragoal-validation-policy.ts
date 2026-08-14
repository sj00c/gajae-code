/**
 * Deterministic Ultragoal validation applicability policy (#4560).
 *
 * The boundary cohort (`cleaner || architect || QA`) and the terminal critic
 * are expensive LLM lanes. They were introduced as unconditional per-boundary
 * ceremony, which inflates token cost and failure surface on low-risk work and
 * makes compaction more likely during long runs (#3473/#3474 moved review from
 * per-subgoal to per-boundary; this policy makes the boundary lanes
 * risk-proportional without removing them for risky work).
 *
 * Selection is runtime-authoritative and deterministic from durable facts
 * (change set, plan shape, ledger receipts) — never free-form model prose.
 * It fails closed: any condition that cannot be proven cheap is treated as
 * high-risk and keeps the full heavyweight cohort. The precedent is
 * `requiresComputerRedTeamSuite`, whose applicability the runtime derives from
 * the computed change set and refuses to let the model self-exempt.
 */
import {
	categorizeComputerChangePath,
	type UltragoalChangeSet,
	type UltragoalChangeSetPath,
} from "./ultragoal-runtime";

export type UltragoalValidationLane = "cleaner" | "architect" | "qa" | "terminal-critic";

export interface UltragoalValidationApplicabilityInput {
	/** Trusted computed change set for the boundary (checkpoint path). */
	changeSet?: UltragoalChangeSet;
	/** Current durable plan. */
	totalGoals?: number;
	completedGoals?: number;
	/** Open review blockers exist (review_blocked goals). */
	hasOpenReviewBlockers?: boolean;
	/** Newest joined cohort sourceHash recorded in the ledger. */
	latestCohortSourceHash?: string;
	/** Current frozen source hash the boundary would review. */
	currentSourceHash?: string;
	/** Ledger evidence of a prior verified boundary generation. */
	priorVerifiedGeneration?: number;
}

export interface UltragoalValidationApplicability {
	/** Lane -> applicability decision with the durable facts that forced it. */
	lanes: Record<UltragoalValidationLane, { applicable: boolean; reasons: string[] }>;
	/** True only when every heavyweight lane is applicable (full cohort). */
	heavyweight: boolean;
	/** Risk classification driving the selection. */
	riskClass: "low" | "high";
	/** True when open review blockers make terminal evidence uncertain. */
	hasOpenReviewBlockers: boolean;
	/** True when an unchanged immutable source basis permits evidence reuse. */
	basisUnchanged: boolean;
	/** Human- and machine-inspectable selection basis, recorded in diagnostics. */
	selection: string[];
}

const HIGH_RISK_PATH_PREFIXES = [
	// Security/auth surfaces
	"packages/coding-agent/src/session/auth",
	"packages/coding-agent/src/auth",
	"crates/pi-natives/src",
	"crates/git-daemon",
	// Public contract / SDK surfaces
	"packages/coding-agent/src/sdk",
	"packages/coding-agent/src/extensibility",
	"packages/coding-agent/src/modes/shared/agent-wire",
	// Shared behavior registries (mirrors the computer-suite conservative rule)
	"packages/coding-agent/src/tools/index.ts",
	"packages/coding-agent/src/tools/renderers.ts",
	"packages/coding-agent/src/config/settings-schema.ts",
] as const;

const MIGRATION_PATH_PREFIXES = [
	"packages/coding-agent/src/gjc-runtime/state-migrations",
	"packages/coding-agent/src/session/session-manager",
	"scripts",
] as const;

function changePaths(changeSet: UltragoalChangeSet | undefined): UltragoalChangeSetPath[] {
	return changeSet?.trusted ? changeSet.paths : [];
}

export function isHighRiskChangePath(row: UltragoalChangeSetPath): boolean {
	const candidates = [row.path, row.oldPath].filter((value): value is string => typeof value === "string");
	for (const candidate of candidates) {
		for (const prefix of HIGH_RISK_PATH_PREFIXES) {
			if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
		}
	}
	return false;
}

export function isMigrationChangePath(row: UltragoalChangeSetPath): boolean {
	const candidates = [row.path, row.oldPath].filter((value): value is string => typeof value === "string");
	for (const candidate of candidates) {
		for (const prefix of MIGRATION_PATH_PREFIXES) {
			if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
		}
	}
	return false;
}

function isComputerControlSurfaceChangePath(row: UltragoalChangeSetPath): boolean {
	const candidates = [row.path, row.oldPath].filter((value): value is string => typeof value === "string");
	return candidates.some(candidate => {
		const category = categorizeComputerChangePath(candidate);
		return category === "code" || category === "tool" || category === "settings-registry";
	});
}

/**
 * Compute the deterministic validation applicability for a boundary.
 *
 * Low-risk eligibility (the only case where redundant lanes may be omitted):
 * trusted change set, single outstanding goal, no open review blockers, no
 * high-risk/migration/computer/public-contract path, complete capture.
 * Everything else — including a missing/untrusted change set — keeps the full
 * heavyweight cohort exactly as today.
 */
export function resolveUltragoalValidationApplicability(
	input: UltragoalValidationApplicabilityInput,
): UltragoalValidationApplicability {
	const selection: string[] = [];
	const paths = changePaths(input.changeSet);
	const highRiskPaths = paths.filter(isHighRiskChangePath);
	const migrationPaths = paths.filter(isMigrationChangePath);
	const computerPaths = paths.filter(isComputerControlSurfaceChangePath);
	const multiGoal = (input.totalGoals ?? 0) - (input.completedGoals ?? 0) > 1;
	const reasons: string[] = [];
	if (!input.changeSet?.trusted) reasons.push("change-set-untrusted-or-missing");
	if (input.changeSet?.captureIncomplete) reasons.push("capture-incomplete");
	if (multiGoal) reasons.push("multiple-outstanding-goals");
	if (input.hasOpenReviewBlockers) reasons.push("open-review-blockers");
	if (highRiskPaths.length > 0) reasons.push("high-risk-paths");
	if (migrationPaths.length > 0) reasons.push("migration-paths");
	if (computerPaths.length > 0) reasons.push("computer-control-surface");
	// Low-risk omission requires proof of exactly one outstanding goal.
	if (input.totalGoals === undefined || input.completedGoals === undefined) reasons.push("progress-unknown");
	const highRisk = reasons.length > 0;
	const heavyweight = highRisk;
	const lane = (applicable: boolean, why: string[]): { applicable: boolean; reasons: string[] } => ({
		applicable,
		reasons: why,
	});
	// Unchanged-basis reuse: only when a prior joined cohort verified the exact
	// frozen source hash this boundary would review, and no blockers reopened.
	const basisUnchanged =
		Boolean(input.latestCohortSourceHash) &&
		input.currentSourceHash === input.latestCohortSourceHash &&
		!input.hasOpenReviewBlockers;
	const lanes: UltragoalValidationApplicability["lanes"] = {
		cleaner: lane(heavyweight, heavyweight ? reasons : ["low-risk-single-goal"]),
		architect: lane(heavyweight, heavyweight ? reasons : ["low-risk-single-goal"]),
		// QA/targeted verification always applies at a boundary; risk selection
		// never removes verification, only redundant review ceremony.
		qa: lane(true, ["mandatory-verification"]),
		"terminal-critic": lane(heavyweight, heavyweight ? reasons : ["low-risk-single-goal"]),
	};
	selection.push(`riskClass=${highRisk ? "high" : "low"}`);
	selection.push(`basisUnchanged=${basisUnchanged}`);
	if (reasons.length > 0) selection.push(`heavyweightReasons=${reasons.join(",")}`);
	return {
		lanes,
		heavyweight,
		riskClass: highRisk ? "high" : "low",
		hasOpenReviewBlockers: Boolean(input.hasOpenReviewBlockers),
		basisUnchanged,
		selection,
	};
}
