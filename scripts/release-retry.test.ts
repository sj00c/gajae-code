import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planAtomicPushRollback, pushReleaseRefsAtomically } from "./release";

const originalCwd = process.cwd();
const tempRoots: string[] = [];

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const result = await $`git -c user.email=release-test@gajae.local -c user.name=release-test ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

interface Fixture {
	root: string;
	origin: string;
	work: string;
	preReleaseCommit: string;
}

async function releaseFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-release-retry-"));
	tempRoots.push(root);
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "work");
	await git(root, ["init", "--bare", "-b", "main", origin]);
	await git(root, ["clone", origin, work]);
	await Bun.write(path.join(work, "file.txt"), "before release\n");
	await git(work, ["add", "file.txt"]);
	await git(work, ["commit", "-m", "pre-release commit"]);
	await git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const preReleaseCommit = (await git(work, ["rev-parse", "HEAD"])).trim();
	// The release transaction: version/changelog commit plus the release tag.
	await Bun.write(path.join(work, "file.txt"), "release bump\n");
	await git(work, ["add", "file.txt"]);
	await git(work, ["commit", "-m", "chore: bump version to 9.9.9"]);
	await git(work, ["tag", "--no-sign", "v9.9.9"]);
	return { root, origin, work, preReleaseCommit };
}

describe("atomic push rollback plan", () => {
	test("maps a version and pre-release commit to the tag and reset target", () => {
		const plan = planAtomicPushRollback("9.9.9", "a".repeat(40));
		expect(plan.tag).toBe("v9.9.9");
		expect(plan.preReleaseCommit).toBe("a".repeat(40));
	});

	test("rejects non-stable versions and malformed commits", () => {
		expect(() => planAtomicPushRollback("9.9.9-rc.1", "a".repeat(40))).toThrow("exact stable");
		expect(() => planAtomicPushRollback("9.9.9", "not-a-sha")).toThrow("pre-release commit");
	});
});

describe("rejected atomic push recovery", () => {
	test("rolls back the complete local release state so the same version can be retried", async () => {
		const { origin, work, preReleaseCommit } = await releaseFixture();

		// A concurrent main update makes the atomic push reject.
		const other = path.join(path.dirname(work), "other");
		await git(path.dirname(work), ["clone", origin, other]);
		await Bun.write(path.join(other, "other.txt"), "concurrent\n");
		await git(other, ["add", "other.txt"]);
		await git(other, ["commit", "-m", "concurrent main update"]);
		await git(other, ["push", "origin", "HEAD:refs/heads/main"]);

		process.chdir(work);
		await expect(pushReleaseRefsAtomically("9.9.9")).rejects.toThrow(/rolled back/u);

		// Full rollback: the tag is gone and HEAD plus the tree are exactly the
		// pre-release state, so retrying re-runs the original transaction.
		const head = (await git(work, ["rev-parse", "HEAD"])).trim();
		expect(head).toBe(preReleaseCommit);
		const tagCheck = await $`git show-ref --verify --quiet refs/tags/v9.9.9`.cwd(work).quiet().nothrow();
		expect(tagCheck.exitCode).not.toBe(0);
		const status = (await git(work, ["status", "--porcelain"])).trim();
		expect(status).toBe("");
		// Nothing reached origin.
		const remoteTag = await $`git ls-remote --tags origin refs/tags/v9.9.9`.cwd(work).quiet().nothrow();
		expect(remoteTag.stdout.toString().trim()).toBe("");
	});

	test("pushes main and the tag atomically when nothing rejects them", async () => {
		const { work, preReleaseCommit } = await releaseFixture();

		process.chdir(work);
		await pushReleaseRefsAtomically("9.9.9");

		const releaseCommit = (await git(work, ["rev-parse", "HEAD"])).trim();
		expect(releaseCommit).not.toBe(preReleaseCommit);
		const remoteMain = (await git(work, ["ls-remote", "origin", "refs/heads/main"])).split("\t")[0]?.trim();
		expect(remoteMain).toBe(releaseCommit);
		const remoteTag = (await git(work, ["ls-remote", "origin", "refs/tags/v9.9.9"])).split("\t")[0]?.trim();
		expect(remoteTag).toBe(releaseCommit);
	});
});
