#!/usr/bin/env bun
/**
 * Derives GitHub Release notes for a release range in the historical
 * `## What's Changed` / `## New Contributors` / `**Full Changelog**` shape.
 *
 * `generate_release_notes: true` cannot describe a curated release. GitHub
 * derives its notes from pull requests merged into the target branch, so a
 * release assembled by cherry-picking onto `main` produces an empty body with
 * nothing but a compare link (v0.14.1 shipped exactly that).
 *
 * Attribution here is deliberately conservative, because the naive lookups are
 * actively misleading on a curated release:
 *
 *   - `GET /commits/{sha}/pulls` returns *every* pull request whose branch
 *     contains the commit. On 0.14.1 that credited shipped fixes to the
 *     32-commit `feat(autoresearch)!` workflow swap the release deliberately
 *     excluded, and to the promotion PR that carried everything.
 *   - Picking the smallest candidate is not enough either: a huge excluded PR
 *     can still be the only candidate.
 *
 * So a candidate pull request is accepted only when this release actually
 * ships it (see `SHIPPED_COVERAGE_THRESHOLD`); otherwise the entry falls back
 * to a commit link, which can never advertise unshipped work.
 *
 * Usage:
 *   bun scripts/release-notes.ts --base <tag> --head <rev> --repo <owner/name> --out <path>
 *   bun scripts/release-notes.ts --base v0.14.0 --head HEAD --repo o/n   # stdout
 */

import { $ } from "bun";

/** A pull request must land this share of its commits to be credited. */
export const SHIPPED_COVERAGE_THRESHOLD = 0.5;

const SUBJECT_PR_REF = /\s\(#(\d{1,7})\)$/u;
const BUMP_SUBJECT = /^chore: bump version to /u;

export interface ReleaseCommit {
	sha: string;
	subject: string;
	/** GitHub login to credit when no pull request is attributed. */
	author: string;
}

export interface CandidatePullRequest {
	number: number;
	title: string;
	author: string;
	/** Subjects of every commit the pull request contains. */
	commitSubjects: readonly string[];
}

export type Attribution =
	| { kind: "pull-request"; pullRequest: CandidatePullRequest }
	| { kind: "commit"; commit: ReleaseCommit };

export interface ReleaseNotesInput {
	repo: string;
	baseTag: string;
	headTag: string;
	commits: readonly ReleaseCommit[];
	/** Candidate pull requests keyed by commit sha. */
	candidatesBySha: ReadonlyMap<string, readonly CandidatePullRequest[]>;
	/** Every pull request this run knows about, keyed by number. */
	pullRequestsByNumber: ReadonlyMap<number, CandidatePullRequest>;
	/** Earliest merged pull request number per author login. */
	firstMergedPullRequestByAuthor: ReadonlyMap<string, number>;
}

/** Strips a trailing `(#1234)` so squashed and branch subjects compare equal. */
export function normalizeSubject(subject: string): string {
	return subject.replace(SUBJECT_PR_REF, "").trim();
}

export function parseSubjectPullRequestRef(subject: string): number | undefined {
	const match = subject.match(SUBJECT_PR_REF);
	return match ? Number(match[1]) : undefined;
}

/** Share of `pullRequest`'s commits present in `shippedSubjects`. */
export function shippedCoverage(pullRequest: CandidatePullRequest, shippedSubjects: ReadonlySet<string>): number {
	if (pullRequest.commitSubjects.length === 0) return 0;
	let shipped = 0;
	for (const subject of pullRequest.commitSubjects) {
		if (shippedSubjects.has(normalizeSubject(subject))) shipped++;
	}
	return shipped / pullRequest.commitSubjects.length;
}

/**
 * A subject-embedded `(#N)` is authoritative: the merge that produced the
 * commit wrote it. Otherwise the smallest candidate this release actually
 * ships wins, and an unshipped candidate is rejected outright.
 */
export function attributeCommit(
	commit: ReleaseCommit,
	input: Pick<ReleaseNotesInput, "candidatesBySha" | "pullRequestsByNumber">,
	shippedSubjects: ReadonlySet<string>,
): Attribution {
	const referenced = parseSubjectPullRequestRef(commit.subject);
	if (referenced !== undefined) {
		const pullRequest = input.pullRequestsByNumber.get(referenced);
		if (pullRequest) return { kind: "pull-request", pullRequest };
	}

	const normalized = normalizeSubject(commit.subject);
	const accepted = (input.candidatesBySha.get(commit.sha) ?? [])
		.filter(candidate => candidate.commitSubjects.some(subject => normalizeSubject(subject) === normalized))
		.filter(candidate => shippedCoverage(candidate, shippedSubjects) >= SHIPPED_COVERAGE_THRESHOLD)
		.sort((left, right) => left.commitSubjects.length - right.commitSubjects.length || left.number - right.number);

	const smallest = accepted[0];
	return smallest ? { kind: "pull-request", pullRequest: smallest } : { kind: "commit", commit };
}

export function buildReleaseNotes(input: ReleaseNotesInput): string {
	const repoUrl = `https://github.com/${input.repo}`;
	const shippedSubjects = new Set(input.commits.map(commit => normalizeSubject(commit.subject)));

	const lines: string[] = [];
	const credited = new Set<number>();
	for (const commit of input.commits) {
		const attribution = attributeCommit(commit, input, shippedSubjects);
		if (attribution.kind === "pull-request") {
			const { number, title, author } = attribution.pullRequest;
			if (credited.has(number)) continue;
			credited.add(number);
			lines.push(`* ${title} by @${author} in ${repoUrl}/pull/${number}`);
			continue;
		}
		const { sha, subject, author } = attribution.commit;
		lines.push(`* ${subject} by @${author} in ${repoUrl}/commit/${sha.slice(0, 10)}`);
	}

	// A contributor is new when the release contains the earliest pull request
	// they ever merged. Ordered by that pull request so the list is stable.
	const newContributors = [...input.firstMergedPullRequestByAuthor]
		.filter(([, first]) => credited.has(first))
		.sort((left, right) => left[1] - right[1]);

	const sections = [`## What's Changed`, ...lines];
	if (newContributors.length > 0) {
		sections.push("", "## New Contributors");
		for (const [author, first] of newContributors) {
			sections.push(`* @${author} made their first contribution in ${repoUrl}/pull/${first}`);
		}
	}
	sections.push("", `**Full Changelog**: ${repoUrl}/compare/${input.baseTag}...${input.headTag}`, "");
	return sections.join("\n");
}

async function git(args: readonly string[]): Promise<string> {
	const result = await $`git ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

async function gh(args: readonly string[]): Promise<string> {
	const result = await $`gh ${args}`.quiet().nothrow();
	// A commit with no associated pull request is normal, not a failure.
	return result.exitCode === 0 ? result.stdout.toString() : "";
}

async function collectCommits(baseTag: string, head: string): Promise<ReleaseCommit[]> {
	const raw = await git(["log", "--no-merges", "--reverse", "--format=%H%x1f%s%x1f%an", `${baseTag}..${head}`]);
	const commits: ReleaseCommit[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const [sha, subject, author] = line.split("\x1f");
		if (sha === undefined || subject === undefined || author === undefined) continue;
		// The release script's own version bump is machinery, not a change.
		if (BUMP_SUBJECT.test(subject)) continue;
		commits.push({ sha, subject, author });
	}
	return commits;
}

async function cherryPickOrigin(sha: string): Promise<string> {
	const body = await git(["show", "-s", "--format=%b", sha]);
	return body.match(/cherry picked from commit ([0-9a-f]{40})/u)?.[1] ?? sha;
}

async function loadPullRequest(repo: string, number: number): Promise<CandidatePullRequest | undefined> {
	const raw = await gh(["pr", "view", String(number), "--repo", repo, "--json", "number,title,author,commits"]);
	if (raw.trim() === "") return undefined;
	const parsed = JSON.parse(raw) as {
		number: number;
		title: string;
		author: { login: string };
		commits: { messageHeadline: string }[];
	};
	return {
		number: parsed.number,
		title: parsed.title,
		author: parsed.author.login,
		commitSubjects: parsed.commits.map(commit => commit.messageHeadline),
	};
}

async function candidateNumbers(repo: string, sha: string): Promise<number[]> {
	const raw = await gh(["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", "[.[]|select(.merged_at!=null)|.number]"]);
	if (raw.trim() === "") return [];
	return JSON.parse(raw) as number[];
}

async function firstMergedPullRequest(repo: string, author: string): Promise<number | undefined> {
	const raw = await gh([
		"search", "prs", "--repo", repo, "--author", author, "--merged",
		"--sort", "created", "--order", "asc", "--limit", "1", "--json", "number",
	]);
	if (raw.trim() === "") return undefined;
	return (JSON.parse(raw) as { number: number }[])[0]?.number;
}

export async function deriveReleaseNotes(repo: string, baseTag: string, head: string, headTag: string): Promise<string> {
	const commits = await collectCommits(baseTag, head);
	const pullRequestsByNumber = new Map<number, CandidatePullRequest>();
	const candidatesBySha = new Map<string, readonly CandidatePullRequest[]>();

	const ensure = async (number: number): Promise<CandidatePullRequest | undefined> => {
		const cached = pullRequestsByNumber.get(number);
		if (cached) return cached;
		const loaded = await loadPullRequest(repo, number);
		if (loaded) pullRequestsByNumber.set(number, loaded);
		return loaded;
	};

	for (const commit of commits) {
		const referenced = parseSubjectPullRequestRef(commit.subject);
		if (referenced !== undefined && (await ensure(referenced))) continue;
		const candidates: CandidatePullRequest[] = [];
		for (const number of await candidateNumbers(repo, await cherryPickOrigin(commit.sha))) {
			const loaded = await ensure(number);
			if (loaded) candidates.push(loaded);
		}
		candidatesBySha.set(commit.sha, candidates);
	}

	const shippedSubjects = new Set(commits.map(commit => normalizeSubject(commit.subject)));
	const firstMergedPullRequestByAuthor = new Map<string, number>();
	for (const commit of commits) {
		const attribution = attributeCommit(commit, { candidatesBySha, pullRequestsByNumber }, shippedSubjects);
		if (attribution.kind !== "pull-request") continue;
		const { author } = attribution.pullRequest;
		if (firstMergedPullRequestByAuthor.has(author)) continue;
		const first = await firstMergedPullRequest(repo, author);
		if (first !== undefined) firstMergedPullRequestByAuthor.set(author, first);
	}

	return buildReleaseNotes({
		repo,
		baseTag,
		headTag,
		commits,
		candidatesBySha,
		pullRequestsByNumber,
		firstMergedPullRequestByAuthor,
	});
}

export interface ReleaseNotesCli {
	repo: string;
	base: string;
	head: string;
	headTag: string;
	out?: string;
}

export function parseReleaseNotesCli(argv: readonly string[]): ReleaseNotesCli {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === undefined || !flag.startsWith("--") || value === undefined) {
			throw new Error("Usage: release-notes.ts --base <tag> --head <rev> --repo <owner/name> [--head-tag <tag>] [--out <path>]");
		}
		values.set(flag.slice(2), value);
	}
	const repo = values.get("repo");
	const base = values.get("base");
	if (repo === undefined || base === undefined) throw new Error("--repo and --base are required");
	const head = values.get("head") ?? "HEAD";
	return { repo, base, head, headTag: values.get("head-tag") ?? head, out: values.get("out") };
}

if (import.meta.main) {
	try {
		const cli = parseReleaseNotesCli(process.argv.slice(2));
		const notes = await deriveReleaseNotes(cli.repo, cli.base, cli.head, cli.headTag);
		if (cli.out === undefined) process.stdout.write(notes);
		else await Bun.write(cli.out, notes);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
