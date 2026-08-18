import { describe, expect, test } from "bun:test";
import {
	type CandidatePullRequest,
	type ReleaseCommit,
	SHIPPED_COVERAGE_THRESHOLD,
	attributeCommit,
	buildReleaseNotes,
	isExplicitEmptyGhResult,
	normalizeSubject,
	parseReleaseNotesCli,
	parseSubjectPullRequestRef,
	shippedCoverage,
} from "./release-notes";

const repo = "Yeachan-Heo/gajae-code";

function commit(sha: string, subject: string, author = "Yeachan-Heo"): ReleaseCommit {
	return { sha, subject, author };
}

function pullRequest(
	number: number,
	title: string,
	commitSubjects: readonly string[],
	author = "Yeachan-Heo",
): CandidatePullRequest {
	return { number, title, author, commitSubjects };
}

function notes(input: {
	commits: readonly ReleaseCommit[];
	candidatesBySha?: ReadonlyMap<string, readonly CandidatePullRequest[]>;
	pullRequestsByNumber?: ReadonlyMap<number, CandidatePullRequest>;
	firstMergedPullRequestByAuthor?: ReadonlyMap<string, number>;
}): string {
	return buildReleaseNotes({
		repo,
		baseTag: "v0.14.0",
		headTag: "v0.14.1",
		commits: input.commits,
		candidatesBySha: input.candidatesBySha ?? new Map(),
		pullRequestsByNumber: input.pullRequestsByNumber ?? new Map(),
		firstMergedPullRequestByAuthor: input.firstMergedPullRequestByAuthor ?? new Map(),
	});
}

describe("subject parsing", () => {
	test("reads and strips a trailing pull request reference", () => {
		expect(parseSubjectPullRequestRef("fix(ai): bound the connect phase (#4666)")).toBe(4666);
		expect(normalizeSubject("fix(ai): bound the connect phase (#4666)")).toBe("fix(ai): bound the connect phase");
	});

	test("ignores issue references that are not a trailing pull request suffix", () => {
		expect(parseSubjectPullRequestRef("docs(changelog): record the fix from #4606")).toBeUndefined();
		expect(parseSubjectPullRequestRef("fix(natives): stop the AVX2 probe (#4652) flashing")).toBeUndefined();
	});

	test("normalizing is idempotent so squashed and branch subjects compare equal", () => {
		const squashed = normalizeSubject("feat(provider): add oMLX profiles (#4607)");
		expect(normalizeSubject(squashed)).toBe(squashed);
		expect(squashed).toBe(normalizeSubject("feat(provider): add oMLX profiles"));
	});
});

describe("shipped coverage", () => {
	test("measures the share of a pull request the release carries", () => {
		const pr = pullRequest(4607, "feat(provider): add oMLX profiles", ["a", "b", "c", "d"]);
		expect(shippedCoverage(pr, new Set(["a", "b", "c", "d"]))).toBe(1);
		expect(shippedCoverage(pr, new Set(["a", "b"]))).toBe(0.5);
		expect(shippedCoverage(pr, new Set(["a"]))).toBe(0.25);
	});

	test("treats a pull request with no commits as unshipped instead of dividing by zero", () => {
		expect(shippedCoverage(pullRequest(1, "empty", []), new Set(["a"]))).toBe(0);
	});
});

describe("attribution", () => {
	test("a subject reference wins over any candidate", () => {
		const referenced = pullRequest(4666, "fix(ai): bound the Anthropic connect phase", ["fix(ai): bound the Anthropic connect phase"]);
		const contained = pullRequest(4430, "feat(autoresearch)!: replace the team workflow", ["fix(ai): bound the connect phase (#4666)"]);
		const subject = "fix(ai): bound the connect phase (#4666)";

		const attribution = attributeCommit(
			commit("aaa", subject),
			{ candidatesBySha: new Map([["aaa", [contained]]]), pullRequestsByNumber: new Map([[4666, referenced]]) },
			new Set([normalizeSubject(subject)]),
		);

		expect(attribution).toEqual({ kind: "pull-request", pullRequest: referenced });
	});

	test("rejects a containing pull request the release does not ship", () => {
		// The 0.14.1 case: the autoresearch swap contained two shipped test
		// commits, but the release excluded the swap itself.
		const swap = pullRequest(
			4430,
			"feat(autoresearch)!: replace the team workflow",
			["test(computer): add a red-team suite", ...Array.from({ length: 31 }, (_, index) => `unshipped ${index}`)],
		);
		const shipped = commit("bbb", "test(computer): add a red-team suite");

		const attribution = attributeCommit(
			shipped,
			{ candidatesBySha: new Map([["bbb", [swap]]]), pullRequestsByNumber: new Map() },
			new Set([shipped.subject]),
		);

		expect(attribution).toEqual({ kind: "commit", commit: shipped });
	});

	test("prefers the smallest fully shipped pull request over a larger one", () => {
		const subject = "feat(provider): add oMLX profiles";
		const promotion = pullRequest(4676, "release: promote blockers to main", [subject, "second"]);
		const owner = pullRequest(4607, "feat(provider): add built-in oMLX profiles", [subject]);

		const attribution = attributeCommit(
			commit("ccc", subject),
			{ candidatesBySha: new Map([["ccc", [promotion, owner]]]), pullRequestsByNumber: new Map() },
			new Set([subject, "second"]),
		);

		expect(attribution).toEqual({ kind: "pull-request", pullRequest: owner });
	});

	test("a candidate that does not contain the commit never wins", () => {
		const unrelated = pullRequest(4000, "unrelated", ["something else"]);
		const orphan = commit("ddd", "fix(x): orphan change");

		expect(
			attributeCommit(
				orphan,
				{ candidatesBySha: new Map([["ddd", [unrelated]]]), pullRequestsByNumber: new Map() },
				new Set([orphan.subject, "something else"]),
			),
		).toEqual({ kind: "commit", commit: orphan });
	});

	test("coverage exactly at the threshold is accepted", () => {
		const subject = "fix(a): half";
		const half = pullRequest(10, "half shipped", [subject, "unshipped"]);
		expect(shippedCoverage(half, new Set([subject]))).toBe(SHIPPED_COVERAGE_THRESHOLD);
		expect(
			attributeCommit(
				commit("eee", subject),
				{ candidatesBySha: new Map([["eee", [half]]]), pullRequestsByNumber: new Map() },
				new Set([subject]),
			),
		).toEqual({ kind: "pull-request", pullRequest: half });
	});
});

describe("notes body", () => {
	test("keeps the historical section order and compare link", () => {
		const body = notes({ commits: [commit("fff", "fix(x): direct push")] });
		expect(body.startsWith("## What's Changed\n")).toBe(true);
		// No resolved login: the Git display name renders without an `@` mention.
		expect(body).toContain(`* fix(x): direct push by Yeachan-Heo in https://github.com/${repo}/commit/fff`);
		expect(body).not.toContain("@Yeachan-Heo");
		expect(body.trimEnd().endsWith(`**Full Changelog**: https://github.com/${repo}/compare/v0.14.0...v0.14.1`)).toBe(true);
	});

	test("credits the resolved GitHub login for fallback commits, never a display-name mention", () => {
		const withLogin: ReleaseCommit = { sha: "abc", subject: "fix(y): direct push", author: "Yeachan Heo", githubLogin: "Yeachan-Heo" };
		const withoutLogin: ReleaseCommit = { sha: "def", subject: "fix(z): direct push", author: "Some Display Name" };
		const body = notes({ commits: [withLogin, withoutLogin] });

		expect(body).toContain(`* fix(y): direct push by @Yeachan-Heo in https://github.com/${repo}/commit/abc`);
		expect(body).toContain(`* fix(z): direct push by Some Display Name in https://github.com/${repo}/commit/def`);
		expect(body).not.toContain("@Some Display Name");
	});

	test("credits a pull request once even when several of its commits ship", () => {
		const pr = pullRequest(4607, "feat(provider): add oMLX profiles", ["first (#4607)", "second (#4607)"]);
		const body = notes({
			commits: [commit("a1", "first (#4607)"), commit("a2", "second (#4607)")],
			pullRequestsByNumber: new Map([[4607, pr]]),
		});

		expect(body.match(/pull\/4607/gu)).toHaveLength(1);
		expect(body).not.toContain("/commit/a2");
	});

	test("omits the contributors section when nobody is new", () => {
		const pr = pullRequest(4666, "fix(ai): bound the connect phase", ["fix(ai): bound the connect phase (#4666)"]);
		const body = notes({
			commits: [commit("b1", "fix(ai): bound the connect phase (#4666)")],
			pullRequestsByNumber: new Map([[4666, pr]]),
			firstMergedPullRequestByAuthor: new Map([["Yeachan-Heo", 1]]),
		});

		expect(body).not.toContain("New Contributors");
	});

	test("lists a contributor whose first merged pull request is in this release", () => {
		const first = pullRequest(4635, "fix(usage): preserve probe limits", ["fix(usage): preserve probe limits (#4635)"], "asdfqwerzxcc");
		const repeat = pullRequest(4666, "fix(ai): bound the connect phase", ["fix(ai): bound the connect phase (#4666)"]);
		const body = notes({
			commits: [commit("c1", "fix(usage): preserve probe limits (#4635)"), commit("c2", "fix(ai): bound the connect phase (#4666)")],
			pullRequestsByNumber: new Map([
				[4635, first],
				[4666, repeat],
			]),
			firstMergedPullRequestByAuthor: new Map([
				["asdfqwerzxcc", 4635],
				["Yeachan-Heo", 1],
			]),
		});

		expect(body).toContain(`* @asdfqwerzxcc made their first contribution in https://github.com/${repo}/pull/4635`);
		expect(body).not.toContain("@Yeachan-Heo made their first contribution");
	});
});

describe("cli", () => {
	test("requires repo and base", () => {
		expect(() => parseReleaseNotesCli(["--base", "v0.14.0"])).toThrow("--repo and --base are required");
		expect(() => parseReleaseNotesCli(["--repo", "o/n"])).toThrow("--repo and --base are required");
	});

	test("defaults head and head tag, and reads the output path", () => {
		expect(parseReleaseNotesCli(["--repo", "o/n", "--base", "v0.14.0"])).toEqual({
			repo: "o/n",
			base: "v0.14.0",
			head: "HEAD",
			headTag: "HEAD",
			out: undefined,
		});
		expect(parseReleaseNotesCli(["--repo", "o/n", "--base", "v0.14.0", "--head-tag", "v0.14.1", "--out", "/tmp/n.md"])).toEqual({
			repo: "o/n",
			base: "v0.14.0",
			head: "HEAD",
			headTag: "v0.14.1",
			out: "/tmp/n.md",
		});
	});

	test("rejects a dangling flag instead of silently dropping it", () => {
		expect(() => parseReleaseNotesCli(["--repo", "o/n", "--base"])).toThrow("Usage");
	});
});

describe("fail-closed gh result classification", () => {
	test("treats success and explicit not-found as empty, everything else as failure", () => {
		// Explicit success and explicit no-result responses are the only empty outcomes.
		expect(isExplicitEmptyGhResult(0, "")).toBe(true);
		expect(isExplicitEmptyGhResult(1, "GraphQL: Could not resolve to a PullRequest with the number of 999999.")).toBe(true);
		expect(isExplicitEmptyGhResult(1, "no pull requests found")).toBe(true);
	});

	test("fails closed on auth, transport, and API errors", () => {
		expect(isExplicitEmptyGhResult(1, "gh: To authenticate, please run `gh auth login`.")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "HTTP 403: Resource not accessible by integration")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "HTTP 500: Internal Server Error")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "dial tcp: lookup api.github.com: no such host")).toBe(false);
		expect(isExplicitEmptyGhResult(1, "API rate limit exceeded")).toBe(false);
		// A bare/unknown failure must never be mistaken for an explicit empty.
		expect(isExplicitEmptyGhResult(1, "")).toBe(false);
		expect(isExplicitEmptyGhResult(128, "fatal: something else")).toBe(false);
	});
});
