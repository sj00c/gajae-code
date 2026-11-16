#!/usr/bin/env bun
/**
 * Applies oracles.v1.json to Windows E2E observations and aggregates verdicts.
 *
 * Usage: bun scripts/windows-e2e/classify.ts --oracles <oracles.json> --out <dir> <obs-dir>...
 *
 * Per attempt: green | red(signature) | precondition-invalid | harness-defect | unbuildable.
 * Per axis (scenario, shell, updater_build, target_tag, installer source):
 *   - red:          the same signature in >= 2 distinct dispatches
 *   - inconclusive: a red signature seen in only one dispatch
 *   - green:        every counted attempt green, reported with its 95% detection bound
 * The script only reads observations; it never re-runs anything.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SignatureRule {
	id: string;
	pattern: string;
}

export interface ScenarioOracle {
	title: string;
	checkSteps?: string[];
	checkStepPrefixes?: string[];
	requireExpectedVersion?: boolean;
	requireCleanInstallDir?: boolean;
	markerRequired?: boolean;
	countedPostKillPhases?: string[];
	allowedFailureSignatures?: string[];
	maxAllowedFailures?: number;
	requireLockObserved?: boolean;
	requireStateParses?: boolean;
	forbidCrashLog?: boolean;
	declaredRed: string;
}

export interface Oracles {
	schema: string;
	leftoverPatterns: string[];
	terminalActivationPhases: string[];
	signatures: SignatureRule[];
	scenarios: Record<string, ScenarioOracle>;
}

export interface StepObservation {
	name: string;
	kind: string;
	exit_code: number | null;
	timed_out: boolean;
	killed?: boolean;
	stdout_tail: string;
	stderr_tail: string;
}

export interface Observation {
	schema: string;
	scenario: string;
	shell: string;
	attempt: number;
	dispatch_run_id: string;
	updater_build: string | null;
	target_tag: string | null;
	expected_version: string | null;
	installer_rev: { source: string; sha256: string | null } | null;
	steps: StepObservation[];
	marker: { name: string; observed: boolean } | null;
	post_kill_record_phase: string | null;
	lock_observed: boolean | null;
	state_files?: Array<{ path: string; parses: boolean }>;
	final: {
		version: string | null;
		install_dir: Array<{ name: string; dir: boolean }>;
		activation_phase: string;
		crash_logs: Array<{ path: string; tail: string }>;
	} | null;
	unbuildable: string | null;
	harness_error: string | null;
}

export type AttemptVerdict =
	| { verdict: "green" }
	| { verdict: "red"; signature: string; detail: string }
	| { verdict: "precondition-invalid"; detail: string }
	| { verdict: "harness-defect"; detail: string }
	| { verdict: "unbuildable"; detail: string };

export function signatureOf(text: string, rules: SignatureRule[]): string | null {
	for (const rule of rules) {
		if (new RegExp(rule.pattern, "i").test(text)) return rule.id;
	}
	return null;
}

function stepSignature(step: StepObservation, rules: SignatureRule[]): string {
	if (step.timed_out) return `timeout:${step.name}`;
	return signatureOf(`${step.stdout_tail}\n${step.stderr_tail}`, rules) ?? `exit:${step.exit_code}:${stepFamily(step.name)}`;
}

/** Collapses numbered driver steps (`config-set-r3-7`) into one family name. */
function stepFamily(name: string): string {
	return name.replace(/-r\d+(-\d+)?$/, "").replace(/-\d+$/, "");
}

function selectSteps(obs: Observation, oracle: ScenarioOracle): StepObservation[] {
	return obs.steps.filter(
		step =>
			oracle.checkSteps?.includes(step.name) === true ||
			oracle.checkStepPrefixes?.some(prefix => step.name.startsWith(prefix)) === true,
	);
}

export function classifyAttempt(obs: Observation, oracles: Oracles): AttemptVerdict {
	const oracle = oracles.scenarios[obs.scenario];
	if (!oracle) return { verdict: "harness-defect", detail: `no oracle for scenario ${obs.scenario}` };
	if (obs.unbuildable) return { verdict: "unbuildable", detail: obs.unbuildable };
	if (obs.harness_error) {
		return obs.harness_error.startsWith("precondition:")
			? { verdict: "precondition-invalid", detail: obs.harness_error }
			: { verdict: "harness-defect", detail: obs.harness_error };
	}
	if (oracle.markerRequired) {
		if (!obs.marker?.observed) return { verdict: "harness-defect", detail: `kill marker ${obs.marker?.name ?? "?"} missed` };
		const counted = oracle.countedPostKillPhases;
		if (counted && !counted.includes(obs.post_kill_record_phase ?? "none")) {
			return { verdict: "precondition-invalid", detail: `post-kill record phase ${obs.post_kill_record_phase}` };
		}
	}
	const steps = selectSteps(obs, oracle);
	if (steps.length === 0) return { verdict: "harness-defect", detail: "no checked step was recorded" };

	const allowed = new Set(oracle.allowedFailureSignatures ?? []);
	const failures = steps.filter(step => step.timed_out || step.exit_code !== 0);
	for (const step of failures) {
		const signature = stepSignature(step, oracles.signatures);
		if (!allowed.has(signature)) return { verdict: "red", signature, detail: `step ${step.name} failed` };
	}
	if (oracle.maxAllowedFailures !== undefined && failures.length > oracle.maxAllowedFailures) {
		return { verdict: "red", signature: "all-steps-failed", detail: `${failures.length} of ${steps.length} checked steps failed` };
	}

	const final = obs.final;
	if (!final) return { verdict: "harness-defect", detail: "final state missing" };
	if (oracle.forbidCrashLog && final.crash_logs.length > 0) {
		return { verdict: "red", signature: "crash-log", detail: final.crash_logs.map(log => log.path).join(", ") };
	}
	if (oracle.requireExpectedVersion && final.version !== obs.expected_version) {
		return { verdict: "red", signature: "wrong-version", detail: `version ${final.version} != expected ${obs.expected_version}` };
	}
	if (oracle.requireCleanInstallDir) {
		const patterns = oracles.leftoverPatterns.map(pattern => new RegExp(pattern));
		const leftovers = final.install_dir.filter(entry => patterns.some(pattern => pattern.test(entry.name)));
		if (leftovers.length > 0) {
			return { verdict: "red", signature: "leftover-files", detail: leftovers.map(entry => entry.name).join(", ") };
		}
		if (!oracles.terminalActivationPhases.includes(final.activation_phase)) {
			return { verdict: "red", signature: `activation-phase:${final.activation_phase}`, detail: "non-terminal activation record left" };
		}
	}
	if (oracle.requireLockObserved && obs.lock_observed !== true) {
		return { verdict: "unbuildable", detail: "driver never produced an observable lock directory" };
	}
	if (oracle.requireStateParses) {
		const files = obs.state_files ?? [];
		if (files.length === 0 || files.some(file => !file.parses)) {
			return { verdict: "red", signature: "state-unparsable", detail: JSON.stringify(files) };
		}
	}
	return { verdict: "green" };
}

export interface AxisSummary {
	axis: string;
	scenario: string;
	verdict: "red" | "inconclusive" | "green" | "no-counted-attempts";
	signature: string | null;
	counted: number;
	reds: number;
	dispatches: string[];
	redDispatches: string[];
	/** 95% upper detection bound: failure rates >= this are excluded when all counted attempts are green. */
	excludedRateAtOrAbove: number | null;
	other: Record<string, number>;
}

export function axisKey(obs: Observation): string {
	return [obs.scenario, obs.shell, obs.updater_build ?? "-", obs.target_tag ?? "-", obs.installer_rev?.source ?? "-"].join(" | ");
}

export function detectionBound(n: number): number {
	return 1 - 0.05 ** (1 / n);
}

export function summarize(entries: Array<{ obs: Observation; result: AttemptVerdict }>): AxisSummary[] {
	const byAxis = new Map<string, Array<{ obs: Observation; result: AttemptVerdict }>>();
	for (const entry of entries) {
		const key = axisKey(entry.obs);
		const list = byAxis.get(key) ?? [];
		list.push(entry);
		byAxis.set(key, list);
	}
	const summaries: AxisSummary[] = [];
	for (const [axis, list] of byAxis) {
		const counted = list.filter(entry => entry.result.verdict === "green" || entry.result.verdict === "red");
		const other: Record<string, number> = {};
		for (const entry of list) {
			if (entry.result.verdict !== "green" && entry.result.verdict !== "red") {
				other[entry.result.verdict] = (other[entry.result.verdict] ?? 0) + 1;
			}
		}
		const dispatchesBySignature = new Map<string, Set<string>>();
		for (const entry of counted) {
			if (entry.result.verdict !== "red") continue;
			const set = dispatchesBySignature.get(entry.result.signature) ?? new Set<string>();
			set.add(entry.obs.dispatch_run_id);
			dispatchesBySignature.set(entry.result.signature, set);
		}
		let best: [string, Set<string>] | null = null;
		for (const pair of dispatchesBySignature) if (!best || pair[1].size > best[1].size) best = pair;
		const reds = counted.filter(entry => entry.result.verdict === "red").length;
		const dispatches = [...new Set(list.map(entry => entry.obs.dispatch_run_id))].sort();
		let verdict: AxisSummary["verdict"];
		if (counted.length === 0) verdict = "no-counted-attempts";
		else if (best && best[1].size >= 2) verdict = "red";
		else if (best) verdict = "inconclusive";
		else verdict = "green";
		summaries.push({
			axis,
			scenario: list[0].obs.scenario,
			verdict,
			signature: best?.[0] ?? null,
			counted: counted.length,
			reds,
			dispatches,
			redDispatches: best ? [...best[1]].sort() : [],
			excludedRateAtOrAbove: verdict === "green" ? detectionBound(counted.length) : null,
			other,
		});
	}
	return summaries.sort((a, b) => a.axis.localeCompare(b.axis));
}

/** PowerShell's ConvertTo-Json writes a one-element array as a bare object and an empty one as null. */
function asArray<T>(value: T | T[] | null | undefined): T[] {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

export function normalizeObservation(raw: Observation): Observation {
	const obs: Observation = { ...raw, steps: asArray(raw.steps) };
	if (raw.state_files !== undefined) obs.state_files = asArray(raw.state_files);
	if (raw.final) {
		obs.final = { ...raw.final, install_dir: asArray(raw.final.install_dir), crash_logs: asArray(raw.final.crash_logs) };
	}
	return obs;
}

async function collectObservations(dir: string): Promise<Observation[]> {
	const out: Observation[] = [];
	for await (const file of new Bun.Glob("**/*.json").scan({ cwd: dir, absolute: true })) {
		const parsed: unknown = await Bun.file(file).json();
		if (typeof parsed === "object" && parsed !== null && (parsed as { schema?: unknown }).schema === "gjc.windows-e2e.observation.v1") {
			out.push(normalizeObservation(parsed as Observation));
		}
	}
	return out;
}

function renderMarkdown(summaries: AxisSummary[]): string {
	const lines = ["# Windows E2E verdicts", "", "| axis | verdict | signature | red/counted | red dispatches | 95% bound | other |", "|---|---|---|---|---|---|---|"];
	for (const s of summaries) {
		const bound = s.excludedRateAtOrAbove === null ? "" : `p >= ${(s.excludedRateAtOrAbove * 100).toFixed(1)}% excluded`;
		const other = Object.entries(s.other).map(([k, v]) => `${k} ${v}`).join(", ");
		lines.push(`| ${s.axis} | ${s.verdict} | ${s.signature ?? ""} | ${s.reds}/${s.counted} | ${s.redDispatches.join(" ")} | ${bound} | ${other} |`);
	}
	return `${lines.join("\n")}\n`;
}

async function main(argv: string[]): Promise<number> {
	let oraclesPath: string | null = null;
	let outDir: string | null = null;
	const inputs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--oracles") oraclesPath = argv[++i] ?? null;
		else if (arg === "--out") outDir = argv[++i] ?? null;
		else inputs.push(arg);
	}
	if (!oraclesPath || !outDir || inputs.length === 0) {
		process.stderr.write("usage: classify.ts --oracles <file> --out <dir> <obs-dir>...\n");
		return 2;
	}
	const oracles = (await Bun.file(oraclesPath).json()) as Oracles;
	const entries: Array<{ obs: Observation; result: AttemptVerdict }> = [];
	for (const dir of inputs) {
		for (const obs of await collectObservations(dir)) entries.push({ obs, result: classifyAttempt(obs, oracles) });
	}
	const summaries = summarize(entries);
	await fs.mkdir(outDir, { recursive: true });
	await Bun.write(
		path.join(outDir, "verdicts.json"),
		JSON.stringify(
			{
				attempts: entries.map(({ obs, result }) => ({ axis: axisKey(obs), attempt: obs.attempt, dispatch: obs.dispatch_run_id, ...result })),
				axes: summaries,
			},
			null,
			2,
		),
	);
	const markdown = renderMarkdown(summaries);
	await Bun.write(path.join(outDir, "verdicts.md"), markdown);
	process.stdout.write(markdown);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
