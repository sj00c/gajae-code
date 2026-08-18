import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@gajae-code/coding-agent/cli/args";
import { buildDefaultTmuxLaunchPlan } from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";
import {
	ensureLaunchWorktree,
	parseLaunchWorktreeMode,
	planLaunchWorktree,
	prepareLaunchWorktree,
	resolveWorktreeBucketForPath,
} from "@gajae-code/coding-agent/gjc-runtime/launch-worktree";

const cleanupRoots: string[] = [];
const cleanupPaths: string[] = [];

function run(command: string, args: string[], cwd: string): string {
	const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	throw new Error(result.stderr.toString().trim() || `${command} ${args.join(" ")} failed`);
}

function testSlug(value: string): string {
	const readable = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const prefix = readable || "default";
	const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${prefix}-${digest}`;
}

/** Asserts the exact directory-entry state at `entryPath`: "missing" | "dir" | "symlink". */
async function expectEntryState(entryPath: string, expected: "missing" | "dir" | "symlink"): Promise<void> {
	const stat = await fs.lstat(entryPath).catch(() => null);
	const actual = stat === null ? "missing" : stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "other";
	expect(actual).toBe(expected);
}

/** Runs `body` with the bucket override applied, restoring the caller's environment. */
function withWorktreeBucketDir<T>(value: string, body: () => T): T {
	const previous = process.env.GJC_WORKTREE_DIR;
	process.env.GJC_WORKTREE_DIR = value;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.GJC_WORKTREE_DIR;
		else process.env.GJC_WORKTREE_DIR = previous;
	}
}

async function createRepo(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	run("git", ["init"], root);
	run("git", ["config", "user.email", "test@example.com"], root);
	run("git", ["config", "user.name", "Test User"], root);
	await Bun.write(path.join(root, "README.md"), "hello\n");
	run("git", ["add", "README.md"], root);
	run("git", ["commit", "-m", "init"], root);
	return root;
}

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		const bucket = path.join(path.dirname(root), `${path.basename(root)}.gajae-code-worktrees`);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], root));
		Bun.spawnSync(["git", "worktree", "remove", "--force", path.join(bucket, branchSlug)], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(["git", "worktree", "remove", "--force", path.join(bucket, "feature-demo")], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(bucket, { recursive: true, force: true });
	}
	for (const cleanupPath of cleanupPaths.splice(0)) await fs.rm(cleanupPath, { recursive: true, force: true });
});

describe("default launch worktrees", () => {
	it("parses and strips launch worktree flags", () => {
		expect(parseLaunchWorktreeMode(["--worktree", "feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--worktree", "--", "hello"])).toEqual({
			mode: { enabled: true, detached: true, name: null },
			remainingArgs: ["--", "hello"],
		});
		expect(parseLaunchWorktreeMode(["--worktree", "--model", "opus"]).mode).toEqual({
			enabled: true,
			detached: true,
			name: null,
		});
		expect(parseLaunchWorktreeMode(["--worktree=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w", "feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w", "--", "hello"])).toEqual({
			mode: { enabled: true, detached: true, name: null },
			remainingArgs: ["--", "hello"],
		});
		expect(parseLaunchWorktreeMode(["-w=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--", "--worktree", "feature/demo"])).toEqual({
			mode: { enabled: false },
			remainingArgs: ["--", "--worktree", "feature/demo"],
		});
	});

	it("creates and reuses a detached launch worktree beside the source repo", async () => {
		const repo = await createRepo("gjc-launch-worktree-");
		await fs.mkdir(path.join(repo, "node_modules"));

		const first = prepareLaunchWorktree(repo, ["--worktree", "--", "hello"]);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], repo));
		const expectedPath = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`, branchSlug);

		expect(await fs.realpath(first.cwd)).toBe(await fs.realpath(expectedPath));
		expect(first.args).toEqual(["--", "hello"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		expect(first.worktree.enabled && first.worktree.detached).toBe(true);
		expect(await Bun.file(path.join(expectedPath, ".git")).exists()).toBe(true);
		expect((await fs.lstat(path.join(expectedPath, "node_modules"))).isSymbolicLink()).toBe(true);

		const second = prepareLaunchWorktree(repo, ["--worktree", "--slow", "opus"]);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
	});

	it("creates launch worktrees beside the canonical source repo when launched from an existing worktree", async () => {
		const repo = await fs.realpath(await createRepo("gjc-launch-nested-source-worktree-"));
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		const second = prepareLaunchWorktree(first.cwd, ["--worktree", "feature/nested"]);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.gajae-code-worktrees`,
			testSlug("feature/nested"),
		);

		expect(second.worktree.enabled && second.worktree.repoRoot).toBe(repo);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(
			second.cwd.includes(`.gajae-code-worktrees${path.sep}${path.basename(first.cwd)}.gajae-code-worktrees`),
		).toBe(false);
	});

	it("reports actionable diagnostics when the deterministic detached target is a different branch", async () => {
		const repo = await createRepo("gjc-launch-target-mismatch-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		run("git", ["checkout", "-b", "other-agent-work"], first.cwd);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(
			/worktree_target_mismatch:[\s\S]*already registered for refs\/heads\/other-agent-work[\s\S]*Refusing to delete or reuse the conflicting worktree automatically[\s\S]*git worktree remove/,
		);
	});

	it("updates a clean reused detached launch worktree when source HEAD advances", async () => {
		const repo = await createRepo("gjc-launch-advance-worktree-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "next"], repo);
		const nextHead = run("git", ["rev-parse", "HEAD"], repo);

		const second = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
		expect(run("git", ["rev-parse", "HEAD"], second.cwd)).toBe(nextHead);
	});

	it("rejects dirty detached launch worktrees when source HEAD advances", async () => {
		const repo = await createRepo("gjc-launch-dirty-worktree-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		await Bun.write(path.join(first.cwd, "dirty.txt"), "dirty\n");

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "next"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(/worktree_dirty:/);
	});

	it("creates named worktrees without reusing a dirty detached source-branch worktree", async () => {
		const repo = await createRepo("gjc-launch-dirty-detached-named-worktree-");
		const detached = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(detached.worktree.enabled && detached.worktree.created).toBe(true);
		await Bun.write(path.join(detached.cwd, "dirty.txt"), "dirty\n");

		const named = prepareLaunchWorktree(repo, ["--worktree", "feat/hud-ui-alignment"]);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.gajae-code-worktrees`,
			testSlug("feat/hud-ui-alignment"),
		);

		expect(await fs.realpath(named.cwd)).toBe(await fs.realpath(expectedPath));
		expect(named.worktree.enabled && named.worktree.branchName).toBe("feat/hud-ui-alignment");
		expect(run("git", ["branch", "--show-current"], named.cwd)).toBe("feat/hud-ui-alignment");
	});

	it("reports a private, platform-neutral error for a broken bucket symlink without deleting it", async () => {
		const repo = await createRepo("gjc launch 'broken-bucket-symlink-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const missingTarget = path.join(path.dirname(repo), "private-missing-cold-storage-target");
		await fs.symlink(missingTarget, bucket, process.platform === "win32" ? "junction" : "dir");

		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("worktree_bucket_broken_symlink");
		expect(message).toContain("platform-appropriate filesystem tools");
		expect(message).toContain("GJC did not delete or replace the entry");
		expect(message).not.toContain(missingTarget);
		expect(message).not.toMatch(/`?rm\s/);
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
	});

	it("reclassifies a broken symlink racing the bucket mkdir instead of leaking raw EEXIST", async () => {
		const repo = await createRepo("gjc-launch-bucket-mkdir-race-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const missingTarget = path.join(path.dirname(repo), "racing-missing-bucket-target");
		const mkdirSpy = spyOn(fsSync, "mkdirSync").mockImplementationOnce((targetPath: fsSync.PathLike) => {
			expect(path.resolve(String(targetPath))).toBe(path.resolve(bucket));
			fsSync.symlinkSync(missingTarget, targetPath, process.platform === "win32" ? "junction" : "dir");
			throw Object.assign(new Error("raw mkdir race"), { code: "EEXIST" });
		});

		try {
			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_broken_symlink[\s\S]*GJC did not delete or replace the entry/,
			);
		} finally {
			mkdirSpy.mockRestore();
		}
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
	});

	it("does not treat non-ENOENT bucket inspection failures as a missing directory", async () => {
		const repo = await createRepo("gjc-launch-bucket-inspection-failure-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const lstatSpy = spyOn(fsSync, "lstatSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});

		try {
			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_inspection_failed[\s\S]*EACCES[\s\S]*GJC did not modify the entry/,
			);
		} finally {
			lstatSpy.mockRestore();
		}
		expect(await Bun.file(bucket).exists()).toBe(false);
	});

	it("allows a valid directory symlink or Windows junction as the worktree bucket", async () => {
		const repo = await createRepo("gjc-launch-valid-bucket-symlink-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const target = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-target-"));
		cleanupPaths.push(target);
		await fs.symlink(target, bucket, process.platform === "win32" ? "junction" : "dir");

		const launched = prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		const expectedPath = path.join(target, testSlug("feature/demo"));
		expect(await fs.realpath(launched.cwd)).toBe(await fs.realpath(expectedPath));
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
		expect(launched.worktree.enabled && launched.worktree.created).toBe(true);
		const reused = prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		expect(await fs.realpath(reused.cwd)).toBe(await fs.realpath(expectedPath));
		expect(reused.worktree.enabled && reused.worktree.reused).toBe(true);
	});

	it("reports a symlink to a non-directory target without disclosing or deleting the target", async () => {
		const repo = await createRepo("gjc-launch-bucket-file-symlink-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		const target = path.join(path.dirname(repo), "private-bucket-target-file");
		cleanupPaths.push(target);
		await Bun.write(target, "preserve-me\n");
		await fs.symlink(target, bucket, "file");

		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/worktree_bucket_not_directory[\s\S]*symbolic link whose target is not a directory/);
		expect(message).not.toContain(target);
		expect(await Bun.file(target).text()).toBe("preserve-me\n");
		expect((await fs.lstat(bucket)).isSymbolicLink()).toBe(true);
	});

	it("reports a regular-file bucket without shell text or deletion side effects", async () => {
		const repo = await createRepo("gjc-launch-bucket-not-directory-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
		await Bun.write(bucket, "not-a-directory\n");

		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "feature/demo"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/worktree_bucket_not_directory[\s\S]*not a directory/);
		expect(message).toContain("platform-appropriate filesystem tools");
		expect(message).not.toMatch(/`?rm\s/);
		expect(await Bun.file(bucket).text()).toBe("not-a-directory\n");
	});

	if (process.platform !== "win32") {
		it("reports a FIFO bucket as a non-directory without deleting it", async () => {
			const repo = await createRepo("gjc-launch-bucket-fifo-");
			const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
			const created = Bun.spawnSync(["mkfifo", bucket], { stdout: "pipe", stderr: "pipe" });
			expect(created.exitCode).toBe(0);

			expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
				/worktree_bucket_not_directory[\s\S]*not a directory/,
			);
			expect((await fs.lstat(bucket)).isFIFO()).toBe(true);
		});

		it("reports a Unix socket bucket as a non-directory without deleting it", async () => {
			const repo = await createRepo("gjc-launch-bucket-socket-");
			const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`);
			const server = net.createServer();
			const ready = Promise.withResolvers<void>();
			server.once("error", ready.reject);
			server.listen(bucket, ready.resolve);
			await ready.promise;

			try {
				expect(() => prepareLaunchWorktree(repo, ["--worktree", "feature/demo"])).toThrow(
					/worktree_bucket_not_directory[\s\S]*not a directory/,
				);
				expect((await fs.lstat(bucket)).isSocket()).toBe(true);
			} finally {
				const closed = Promise.withResolvers<void>();
				server.close(error => (error ? closed.reject(error) : closed.resolve()));
				await closed.promise;
			}
		});
	}

	it("creates named launch worktrees from reusable branch names", async () => {
		const repo = await createRepo("gjc-launch-named-worktree-");
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const ensured = ensureLaunchWorktree(planned);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.gajae-code-worktrees`,
			testSlug("feature/demo"),
		);

		expect(ensured.enabled && (await fs.realpath(ensured.worktreePath))).toBe(await fs.realpath(expectedPath));
		expect(ensured.enabled && ensured.branchName).toBe("feature/demo");
		expect(run("git", ["branch", "--show-current"], expectedPath)).toBe("feature/demo");
	});

	it("keeps launch worktree slugs collision-resistant for similar branch names", async () => {
		const repo = await createRepo("gjc-launch-collision-worktree-");
		const slashPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const dashPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature-demo" });
		const casePlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "Feature" });
		const lowerPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature" });
		const unicodePlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "é" });
		const asciiPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "e9" });

		expect(slashPlan.enabled && slashPlan.worktreePath.endsWith(testSlug("feature/demo"))).toBe(true);
		expect(dashPlan.enabled && dashPlan.worktreePath.endsWith(testSlug("feature-demo"))).toBe(true);
		expect(slashPlan.enabled && dashPlan.enabled && slashPlan.worktreePath).not.toBe(
			dashPlan.enabled && dashPlan.worktreePath,
		);
		expect(casePlan.enabled && lowerPlan.enabled && casePlan.worktreePath).not.toBe(
			lowerPlan.enabled && lowerPlan.worktreePath,
		);
		expect(unicodePlan.enabled && asciiPlan.enabled && unicodePlan.worktreePath).not.toBe(
			asciiPlan.enabled && asciiPlan.worktreePath,
		);
	});

	it("adopts an existing sibling bucket named by the GJC_WORKTREE_DIR template", async () => {
		const repo = await createRepo("gjc-launch-bucket-env-");
		const bucket = path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`);
		cleanupPaths.push(bucket);

		const ensured = withWorktreeBucketDir("{repo}.worktrees", () =>
			ensureLaunchWorktree(planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" })),
		);

		expect(ensured.enabled && (await fs.realpath(ensured.worktreePath))).toBe(
			await fs.realpath(path.join(bucket, testSlug("feature/demo"))),
		);
		expect(run("git", ["branch", "--show-current"], path.join(bucket, testSlug("feature/demo")))).toBe(
			"feature/demo",
		);
		expect(fsSync.existsSync(path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`))).toBe(
			false,
		);
	});

	it("keeps the template repo-scoped so two repos never share one worktree path", async () => {
		const first = await createRepo("gjc-launch-bucket-shared-a-");
		const second = await createRepo("gjc-launch-bucket-shared-b-");
		const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-shared-root-"));
		cleanupPaths.push(shared);

		const plans = withWorktreeBucketDir(path.join(shared, "{repo}"), () => [
			planLaunchWorktree(first, { enabled: true, detached: false, name: "feature/demo" }),
			planLaunchWorktree(second, { enabled: true, detached: false, name: "feature/demo" }),
		]);

		expect(plans[0].enabled && path.dirname(plans[0].worktreePath)).toBe(path.join(shared, path.basename(first)));
		expect(plans[1].enabled && path.dirname(plans[1].worktreePath)).toBe(path.join(shared, path.basename(second)));
	});

	it("expands a home-relative override and falls back to the default bucket when unset", async () => {
		const repo = await createRepo("gjc-launch-bucket-home-");
		const homePlan = withWorktreeBucketDir("~/gjc-worktrees", () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);
		const blankPlan = withWorktreeBucketDir("   ", () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);

		expect(homePlan.enabled && path.dirname(homePlan.worktreePath)).toBe(path.join(os.homedir(), "gjc-worktrees"));
		expect(blankPlan.enabled && path.dirname(blankPlan.worktreePath)).toBe(
			path.join(path.dirname(repo), `${path.basename(repo)}.gajae-code-worktrees`),
		);
	});

	it("uses the launch worktree as the generated tmux cwd", async () => {
		const repo = await createRepo("gjc-session-worktree-");
		const launch = prepareLaunchWorktree(repo, ["--worktree"]);
		const parsed = { messages: [], fileArgs: [], unknownFlags: new Map(), tmux: true } satisfies Args;
		const plan = buildDefaultTmuxLaunchPlan({
			parsed,
			rawArgs: launch.args,
			cwd: launch.cwd,
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: true },
			tmuxAvailable: true,
			existingBranchSessionName: null,
		});

		expect(plan?.cwd).toBe(launch.cwd);
		expect(plan?.newSessionArgs).toContain(launch.cwd);
	});
});
describe("launch worktree node_modules isolation (#4620)", () => {
	async function createWorkspaceRepo(prefix: string): Promise<string> {
		const repo = await createRepo(prefix);
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, "\t"),
		);
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await Bun.write(
			path.join(repo, "packages", "app", "package.json"),
			JSON.stringify({ name: "@scope/app", version: "1.0.0" }, null, "\t"),
		);
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "workspace"], repo);
		return repo;
	}

	it("does not share node_modules when workspace self-links resolve into the source repo", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-workspace-");
		const originModules = path.join(repo, "node_modules");
		await fs.mkdir(path.join(originModules, "@scope"), { recursive: true });
		await fs.symlink(path.join(repo, "packages", "app"), path.join(originModules, "@scope", "app"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		// No shared symlink: what exists (if anything) is a worktree-local
		// boundary, never a link to the origin checkout's tree.
		expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(false);
		expect(await fs.realpath(worktreeModules)).toBe(worktreeModules);
		// The worktree-local boundary resolves the worktree's own workspace source.
		const boundaryLink = path.join(worktreeModules, "@scope", "app");
		expect((await fs.lstat(boundaryLink)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(boundaryLink)).toBe(path.join(launched.cwd, "packages", "app"));
		// The origin checkout's install stays untouched.
		expect((await fs.lstat(path.join(originModules, "@scope", "app"))).isSymbolicLink()).toBe(true);
	});

	it("still shares node_modules when links resolve outside the source repo", async () => {
		const repo = await createRepo("gjc-launch-worktree-external-links-");
		const originModules = path.join(repo, "node_modules");
		const external = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-external-store-"));
		cleanupPaths.push(external);
		await fs.mkdir(path.join(originModules, ".store"), { recursive: true });
		await fs.symlink(path.join(external, "pkg"), path.join(originModules, ".store", "pkg"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(worktreeModules)).toBe(await fs.realpath(originModules));
	});

	it("remediates an already-contaminated worktree node_modules symlink", async () => {
		const repo = await createRepo("gjc-launch-worktree-remediate-");
		const originModules = path.join(repo, "node_modules");
		await fs.mkdir(originModules);

		const contaminated = prepareLaunchWorktree(repo, ["--worktree"]);
		expect((await fs.lstat(path.join(contaminated.cwd, "node_modules"))).isSymbolicLink()).toBe(true);

		const remediated = prepareLaunchWorktree(repo, ["--worktree"]);
		await expectEntryState(path.join(remediated.cwd, "node_modules"), "missing");
		// The origin's own node_modules survives remediation.
		expect((await fs.stat(originModules)).isDirectory()).toBe(true);
	});

	it("leaves a real worktree node_modules directory untouched", async () => {
		const repo = await createRepo("gjc-launch-worktree-owned-modules-");
		// No origin node_modules: the worktree never gets a symlink, so the
		// directory below stays genuinely worktree-owned.
		const launched = prepareLaunchWorktree(repo, ["--worktree", "owned-modules"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect(await Bun.file(worktreeModules).exists()).toBe(false);
		await fs.mkdir(worktreeModules, { recursive: true });
		await Bun.write(path.join(worktreeModules, "marker.txt"), "user-owned\n");

		const reused = prepareLaunchWorktree(repo, ["--worktree", "owned-modules"]);
		expect(await Bun.file(path.join(reused.cwd, "node_modules", "marker.txt")).text()).toBe("user-owned\n");
	});

	it("never creates a node_modules symlink when the source repo has none", async () => {
		const repo = await createRepo("gjc-launch-worktree-no-modules-");

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		await expectEntryState(path.join(launched.cwd, "node_modules"), "missing");
	});

	it("detects bun isolated-linker workspace layouts under node_modules/.bun", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-isolated-store-");
		const originModules = path.join(repo, "node_modules");
		const storeModules = path.join(originModules, ".bun", "node_modules", "@scope");
		await fs.mkdir(storeModules, { recursive: true });
		await fs.symlink(path.join(repo, "packages", "app"), path.join(storeModules, "app"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		await expectEntryState(path.join(launched.cwd, "node_modules"), "dir");
	});
	it("detects pnpm scoped workspace layouts at deeper nesting (.pnpm depth 5)", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-pnpm-store-");
		const originModules = path.join(repo, "node_modules");
		const storeModules = path.join(originModules, ".pnpm", "@scope+app@1.0.0", "node_modules", "@scope");
		await fs.mkdir(storeModules, { recursive: true });
		await fs.symlink(path.join(repo, "packages", "app"), path.join(storeModules, "app"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		await expectEntryState(path.join(launched.cwd, "node_modules"), "dir");
	});

	it("detects the origin node_modules root itself linking into the source repo", async () => {
		const repo = await createRepo("gjc-launch-worktree-rootlink-");
		// A vendored node_modules directory inside the repo, with the root
		// node_modules symlink pointing at it.
		const vendored = path.join(repo, ".vendor", "node_modules");
		await fs.mkdir(vendored, { recursive: true });
		await fs.symlink(vendored, path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		// Plain repo (no declaration): nothing is shared and no boundary exists.
		await expectEntryState(path.join(launched.cwd, "node_modules"), "missing");
	});

	it("does not throw when the worktree carries a dangling node_modules symlink", async () => {
		const repo = await createRepo("gjc-launch-worktree-dangling-modules-");
		await fs.mkdir(path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree", "dangling-modules"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		// The launch already created a shared symlink (plain-repo origin); replace
		// it with a dangling one the way a stale cross-checkout link would look.
		await fs.rm(worktreeModules);
		await fs.symlink(path.join(launched.cwd, "does-not-exist"), worktreeModules, "dir");

		// A dangling link's ownership can never be proven, so the launch refuses
		// instead of deleting it or continuing through it; the link is preserved
		// for the user.
		expect(() => prepareLaunchWorktree(repo, ["--worktree", "dangling-modules"])).toThrow(
			/worktree_node_modules_unverified/,
		);
		expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(true);
	});

	it("never shares an origin node_modules symlinked outside the repo (parent workspace hoist)", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-parent-hoist-"));
		cleanupPaths.push(parent);
		const repo = path.join(parent, "repo");
		await fs.mkdir(repo);
		run("git", ["init"], repo);
		run("git", ["config", "user.email", "test@example.com"], repo);
		run("git", ["config", "user.name", "Test User"], repo);
		await Bun.write(path.join(repo, "README.md"), "hello\n");
		run("git", ["add", "README.md"], repo);
		run("git", ["commit", "-m", "init"], repo);
		// Parent workspace hoists its own packages into parent/node_modules.
		await fs.mkdir(path.join(parent, "packages", "app"), { recursive: true });
		await fs.mkdir(path.join(parent, "node_modules", "@scope"), { recursive: true });
		await fs.symlink(path.join(parent, "packages", "app"), path.join(parent, "node_modules", "@scope", "app"));
		// The nested repo borrows the parent's tree.
		await fs.symlink(path.join(parent, "node_modules"), path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect(await Bun.file(worktreeModules).exists()).toBe(false);
	});

	it("fails closed when the scan cannot read a traversal directory", async () => {
		// A plain repo (no workspace declaration): sharing is decided by the
		// origin-tree scan, which is exactly the path this fault exercises.
		const repo = await createRepo("gjc-launch-worktree-unreadable-scan-");
		// The origin tree carries a resolvable workspace-style self-link; the repo
		// itself declares no workspaces, so sharing is decided by the scan.
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		const originModules = path.join(repo, "node_modules");
		// A self-link that the fault-injected scan cannot see past.
		const scoped = path.join(originModules, "@scope");
		await fs.mkdir(scoped, { recursive: true });
		await fs.symlink(path.join(repo, "packages", "app"), path.join(scoped, "app"));

		// Fault-inject EACCES deterministically at the scoped directory only.
		// chmod is unreliable under root, and an untargeted first-call spy would
		// be consumed by the scan's read of the node_modules root before ever
		// reaching the traversal directory the fail-closed branch guards.
		const realReaddir = fsSync.readdirSync.bind(fsSync) as unknown as (...args: unknown[]) => unknown;
		let reachedScopedDir = false;
		const readdirSpy = spyOn(fsSync, "readdirSync").mockImplementation(((
			dir: fsSync.PathLike,
			options?: fsSync.ObjectEncodingOptions & { withFileTypes?: boolean; recursive?: boolean },
		) => {
			if (path.resolve(String(dir)) === scoped) {
				reachedScopedDir = true;
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realReaddir(dir, options);
		}) as unknown as typeof fsSync.readdirSync);
		try {
			const launched = prepareLaunchWorktree(repo, ["--worktree"]);
			expect(reachedScopedDir).toBe(true);
			// The scan failed closed: the origin tree is never shared (a plain
			// repo without a declaration gets no boundary directory at all).
			await expectEntryState(path.join(launched.cwd, "node_modules"), "missing");
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it("refuses the launch for a stale link whose identity cannot be proven (EACCES)", async () => {
		const repo = await createRepo("gjc-launch-worktree-hoist-eacces-");
		await fs.mkdir(path.join(repo, "node_modules"));
		const launched = prepareLaunchWorktree(repo, ["--worktree", "hoist-eacces"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(true);

		// Target the identity-resolution branch specifically: the outer
		// sourceRoot realpath must still succeed, and only the worktree link's
		// resolution fails. Identity is then unprovable — the launcher must
		// refuse the launch rather than delete the link or continue through it.
		const realRealpath = fsSync.realpathSync.bind(fsSync);
		let reachedLinkResolution = false;
		const realpathSpy = spyOn(fsSync, "realpathSync").mockImplementation(((pathArg: fsSync.PathLike) => {
			if (path.resolve(String(pathArg)) === path.resolve(worktreeModules)) {
				reachedLinkResolution = true;
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realRealpath(pathArg);
		}) as unknown as typeof fsSync.realpathSync);
		try {
			expect(() => prepareLaunchWorktree(repo, ["--worktree", "hoist-eacces"])).toThrow(
				/worktree_node_modules_unverified/,
			);
			expect(reachedLinkResolution).toBe(true);
			// The unproven link is preserved for the user to inspect.
			expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(true);
		} finally {
			realpathSpy.mockRestore();
		}
	});

	it("remediates a stale worktree link to a parent-workspace hoist (identity match)", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-stale-hoist-"));
		cleanupPaths.push(parent);
		const repo = path.join(parent, "repo");
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
		);
		await Bun.write(
			path.join(repo, "packages", "app", "package.json"),
			'{"name":"@scope/app","exports":{".":"./src/index.ts"}}\n',
		);
		run("git", ["init"], repo);
		run("git", ["config", "user.email", "test@example.com"], repo);
		run("git", ["config", "user.name", "Test User"], repo);
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "init"], repo);
		// Parent workspace hoist borrowed by the nested repo.
		await fs.mkdir(path.join(parent, "node_modules"), { recursive: true });
		await fs.symlink(path.join(parent, "node_modules"), path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree", "stale-hoist"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		// Not a shared symlink; the worktree owns its boundary directory.
		expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(false);
		// Simulate the pre-fix contaminated state: the worktree's node_modules is a
		// symlink to the repo's (hoisted, outside-sourceRoot) node_modules.
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.symlink(path.join(repo, "node_modules"), worktreeModules);

		const reused = prepareLaunchWorktree(repo, ["--worktree", "stale-hoist"]);
		expect((await fs.lstat(path.join(reused.cwd, "node_modules"))).isSymbolicLink()).toBe(false);
		// The parent's own tree survives remediation.
		expect((await fs.stat(path.join(parent, "node_modules"))).isDirectory()).toBe(true);
	});

	it("keeps the worktree resolving its own workspace sources beside a parent workspace hoist", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-resolve-hoist-"));
		cleanupPaths.push(parent);
		// Parent workspace with its own live (divergent) copy of the package.
		await fs.mkdir(path.join(parent, "packages", "app", "src"), { recursive: true });
		await Bun.write(
			path.join(parent, "packages", "app", "package.json"),
			'{"name":"@scope/app","exports":{".":"./src/index.ts"}}\n',
		);
		await Bun.write(
			path.join(parent, "packages", "app", "src", "index.ts"),
			'export const marker = "parent-live-source";\n',
		);
		await fs.mkdir(path.join(parent, "node_modules", "@scope"), { recursive: true });
		await fs.symlink(path.join(parent, "packages", "app"), path.join(parent, "node_modules", "@scope", "app"));
		// Nested repo inside that parent, with its own workspace member.
		const repo = path.join(parent, "repo");
		await fs.mkdir(path.join(repo, "packages", "app", "src"), { recursive: true });
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
		);
		await Bun.write(
			path.join(repo, "packages", "app", "package.json"),
			'{"name":"@scope/app","exports":{".":"./src/index.ts"}}\n',
		);
		await Bun.write(
			path.join(repo, "packages", "app", "src", "index.ts"),
			'export const marker = "worktree-own-source";\n',
		);
		run("git", ["init"], repo);
		run("git", ["config", "user.email", "test@example.com"], repo);
		run("git", ["config", "user.name", "Test User"], repo);
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "init"], repo);
		// The nested repo borrows the parent's tree — the exact #4620 shape.
		await fs.symlink(path.join(parent, "node_modules"), path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree", "resolve-hoist"]);
		// The worktree is a sibling of repo inside parent, so the parent's
		// node_modules is an ancestor module root. Module resolution inside the
		// worktree must still bind to the worktree's own commit, not the parent's
		// live sources.
		const probe = Bun.spawnSync(["bun", "-e", 'import { marker } from "@scope/app"; process.stdout.write(marker)'], {
			cwd: launched.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(probe.stderr.toString()).toBe("");
		expect(probe.stdout.toString().trim()).toBe("worktree-own-source");
	});

	it("refuses the launch for a user-owned external node_modules link that cannot be resolved", async () => {
		const repo = await createRepo("gjc-launch-worktree-unresolvable-link-");
		const external = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-external-store-"));
		cleanupPaths.push(external);
		await fs.mkdir(path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree", "unresolvable-link"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.symlink(path.join(external, "store"), worktreeModules, "dir");

		// Identity resolution fails only for permission reasons: the link target is
		// a user-owned external store, not the source checkout. The launcher must
		// refuse the launch rather than delete user data or continue through the
		// unproven boundary. A persistent target-aware spy delegates to the real
		// implementation for unrelated paths (the first reuse call resolves
		// sourceRoot) and asserts the target path was reached.
		const realRealpath = fsSync.realpathSync.bind(fsSync);
		let reachedTarget = false;
		const realpathSpy = spyOn(fsSync, "realpathSync").mockImplementation(((pathArg: fsSync.PathLike) => {
			if (path.resolve(String(pathArg)) === path.resolve(worktreeModules)) {
				reachedTarget = true;
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realRealpath(pathArg);
		}) as unknown as typeof fsSync.realpathSync);
		try {
			expect(() => prepareLaunchWorktree(repo, ["--worktree", "unresolvable-link"])).toThrow(
				/worktree_node_modules_unverified/,
			);
			expect(reachedTarget).toBe(true);
			// The user-owned external link is preserved untouched.
			expect(await fs.readlink(worktreeModules)).toBe(path.join(external, "store"));
		} finally {
			realpathSpy.mockRestore();
		}
	});

	it("reconciles the boundary when workspace members change across worktree reuse", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-reconcile-");
		const first = prepareLaunchWorktree(repo, ["--worktree", "reconcile"]);
		const modules = path.join(first.cwd, "node_modules");
		expect((await fs.lstat(path.join(modules, "@scope", "app"))).isSymbolicLink()).toBe(true);

		// Remove the member from the worktree tree (as a new commit would).
		await fs.rm(path.join(first.cwd, "packages", "app"), { recursive: true, force: true });
		// Add a different member.
		await fs.mkdir(path.join(first.cwd, "packages", "newapp"), { recursive: true });
		await Bun.write(path.join(first.cwd, "packages", "newapp", "package.json"), '{"name":"@scope/newapp"}\n');

		const reused = prepareLaunchWorktree(repo, ["--worktree", "reconcile"]);
		const reconciled = path.join(reused.cwd, "node_modules");
		// The stale member link is gone; it cannot resolve through an ancestor.
		expect(await Bun.file(path.join(reconciled, "@scope", "app")).exists()).toBe(false);
		// The new member is linked.
		expect((await fs.lstat(path.join(reconciled, "@scope", "newapp"))).isSymbolicLink()).toBe(true);
	});

	it("builds the boundary from pnpm-workspace.yaml when package.json declares none", async () => {
		const repo = await createRepo("gjc-launch-worktree-pnpm-decl-");
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await Bun.write(path.join(repo, "package.json"), JSON.stringify({ name: "root", private: true }));
		await Bun.write(path.join(repo, "packages", "app", "package.json"), '{"name":"@scope/app"}\n');
		await Bun.write(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "pnpm workspace"], repo);

		const launched = prepareLaunchWorktree(repo, ["--worktree", "pnpm-decl"]);
		const link = path.join(launched.cwd, "node_modules", "@scope", "app");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(link)).toBe(path.join(launched.cwd, "packages", "app"));
	});

	it("builds the boundary from package.json workspace packages declarations", async () => {
		const repo = await createRepo("gjc-launch-worktree-package-decl-");
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: { packages: ["packages/*"] } }),
		);
		await Bun.write(path.join(repo, "packages", "app", "package.json"), '{"name":"@scope/app"}\n');
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "package workspace"], repo);

		const launched = prepareLaunchWorktree(repo, ["--worktree", "package-decl"]);
		const link = path.join(launched.cwd, "node_modules", "@scope", "app");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(link)).toBe(path.join(launched.cwd, "packages", "app"));
	});

	it("refuses traversal workspace patterns instead of writing outside the worktree", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-traversal-");
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["../escape/*"] }),
		);
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "traversal pattern"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(/worktree_workspace_pattern_unsafe/);
	});

	it("refuses member package names outside the npm grammar", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-bad-name-");
		await fs.mkdir(path.join(repo, "packages", "evil"), { recursive: true });
		await Bun.write(path.join(repo, "packages", "evil", "package.json"), '{"name":"../escape"}\n');
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "bad name"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(/worktree_workspace_member_name_invalid/);
	});

	it("refuses malformed member manifests instead of skipping them", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-bad-member-");
		await Bun.write(path.join(repo, "packages", "app", "package.json"), "{ not json");
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "bad member"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(/worktree_workspace_member_invalid/);
	});

	it("leaves a complete user-owned node_modules directory without the marker untouched", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-user-dir-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "user-dir"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		// Replace the launcher boundary with a user-owned install-like directory
		// that still resolves every declared member (a copy of the member).
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.mkdir(path.join(worktreeModules, "@scope", "app"), { recursive: true });
		await Bun.write(path.join(worktreeModules, "@scope", "app", "index.js"), "// installed\n");
		await fs.mkdir(path.join(worktreeModules, "ms"), { recursive: true });
		await Bun.write(path.join(worktreeModules, "ms", "marker.txt"), "user-owned\n");

		const reused = prepareLaunchWorktree(repo, ["--worktree", "user-dir"]);
		expect(await Bun.file(path.join(reused.cwd, "node_modules", "ms", "marker.txt")).text()).toBe("user-owned\n");
		expect(await Bun.file(path.join(reused.cwd, "node_modules", "@scope", "app", "index.js")).text()).toBe(
			"// installed\n",
		);
	});

	it("refuses an incomplete user-owned node_modules directory in a workspace worktree", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-incomplete-dir-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "incomplete-dir"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		// A partial tree: unrelated entries only, the declared member is absent,
		// so it would resolve through an ancestor checkout.
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.mkdir(path.join(worktreeModules, "ms"), { recursive: true });
		await Bun.write(path.join(worktreeModules, "ms", "marker.txt"), "user-owned\n");

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "incomplete-dir"])).toThrow(
			/worktree_node_modules_boundary_incomplete/,
		);
		// Refused, not deleted: the user-owned content survives.
		expect(await Bun.file(path.join(launched.cwd, "node_modules", "ms", "marker.txt")).text()).toBe("user-owned\n");
	});

	it("refuses a user-owned node_modules directory whose member entry resolves outside the worktree", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-outside-dir-");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-outside-member-"));
		cleanupPaths.push(outside);
		const launched = prepareLaunchWorktree(repo, ["--worktree", "outside-dir"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.mkdir(path.join(worktreeModules, "@scope"), { recursive: true });
		await fs.symlink(outside, path.join(worktreeModules, "@scope", "app"));

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "outside-dir"])).toThrow(
			/worktree_node_modules_boundary_incomplete/,
		);
	});
	it("refuses a member entry that loops back to the boundary directory itself", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-selfloop-dir-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "selfloop-dir"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.mkdir(path.join(worktreeModules, "@scope"), { recursive: true });
		await fs.symlink(worktreeModules, path.join(worktreeModules, "@scope", "app"));

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "selfloop-dir"])).toThrow(
			/worktree_node_modules_boundary_incomplete/,
		);
	});

	it("preserves package-manager-installed links inside a marker-owned boundary", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-pkg-replaced-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "pkg-replaced"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(path.join(worktreeModules, "@scope", "app"))).isSymbolicLink()).toBe(true);

		// Simulate a package-manager install replacing the launcher's link with
		// a real installed entry while the marker happens to survive. A real
		// install materializes every workspace member; the unrelated `ms`
		// entry proves the launcher did not prune it.
		await fs.rm(path.join(worktreeModules, "@scope", "app"));
		await fs.mkdir(path.join(worktreeModules, "@scope", "app"), { recursive: true });
		await Bun.write(path.join(worktreeModules, "@scope", "app", "index.js"), "// installed\n");
		await fs.mkdir(path.join(worktreeModules, "ms"), { recursive: true });
		await Bun.write(path.join(worktreeModules, "ms", "index.js"), "// installed\n");

		const reused = prepareLaunchWorktree(repo, ["--worktree", "pkg-replaced"]);
		const reusedModules = path.join(reused.cwd, "node_modules");
		// The installed entry survives; the launcher does not manage the tree.
		expect(await Bun.file(path.join(reusedModules, "ms", "index.js")).text()).toBe("// installed\n");
	});

	it("reconciles a stale boundary to empty after the workspace declaration disappears", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-decl-gone-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "decl-gone"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(path.join(worktreeModules, "@scope", "app"))).isSymbolicLink()).toBe(true);

		// Drop the workspace declaration (workspace -> non-workspace transition).
		await Bun.write(path.join(launched.cwd, "package.json"), '{"name":"root","private":true}\n');

		const reused = prepareLaunchWorktree(repo, ["--worktree", "decl-gone"]);
		const reusedModules = path.join(reused.cwd, "node_modules");
		// Stale member link is pruned and the launcher no longer claims the dir.
		expect(await fs.lstat(path.join(reusedModules, "@scope", "app")).catch(() => null)).toBe(null);
		expect(await fs.lstat(path.join(reusedModules, ".gjc-node-modules-boundary")).catch(() => null)).toBe(null);
	});
	it("never deletes a package-manager entry that replaced a recorded boundary link", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-replaced-recorded-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "replaced-recorded"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(path.join(worktreeModules, "@scope", "app"))).isSymbolicLink()).toBe(true);

		// Replace only the recorded member link with a different identity while
		// the marker and the ownership manifest (which still records the old
		// target) survive — the launcher must not delete the replacement.
		await fs.rm(path.join(worktreeModules, "@scope", "app"));
		const replaced = path.join(launched.cwd, "vendor", "app-copy");
		await fs.mkdir(replaced, { recursive: true });
		await Bun.write(path.join(replaced, "index.js"), "// vendored\n");
		await fs.symlink(replaced, path.join(worktreeModules, "@scope", "app"));

		const reused = prepareLaunchWorktree(repo, ["--worktree", "replaced-recorded"]);
		const reusedModules = path.join(reused.cwd, "node_modules");
		const link = path.join(reusedModules, "@scope", "app");
		// The replacement is preserved untouched; the launcher dropped its
		// stale claim instead of deleting the entry on the manifest's say-so.
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(link)).toBe(replaced);
	});

	it("fails closed on a malformed link-ownership manifest", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-bad-manifest-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "bad-manifest"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");

		await Bun.write(path.join(worktreeModules, ".gjc-node-modules-links.json"), "{ not json");

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "bad-manifest"])).toThrow(
			/worktree_boundary_manifest_invalid/,
		);
	});

	it("fails closed on a link-ownership manifest with traversal entry names", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-traversal-manifest-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "traversal-manifest"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");

		// A crafted manifest key that would escape node_modules if joined.
		await Bun.write(
			path.join(worktreeModules, ".gjc-node-modules-links.json"),
			JSON.stringify({ "../../outside": "/tmp/somewhere" }),
		);

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "traversal-manifest"])).toThrow(
			/worktree_boundary_manifest_invalid/,
		);
	});

	it("fails closed on a non-object link-ownership manifest", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-array-manifest-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "array-manifest"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");

		await Bun.write(path.join(worktreeModules, ".gjc-node-modules-links.json"), '["@scope/app"]');

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "array-manifest"])).toThrow(
			/worktree_boundary_manifest_invalid/,
		);
	});
	it("never reads a link-ownership manifest that is a symlink to an external file", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-manifest-symlink-");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-manifest-escape-"));
		cleanupPaths.push(outside);
		const launched = prepareLaunchWorktree(repo, ["--worktree", "manifest-symlink"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		const outsideTarget = path.join(outside, "secret.txt");
		await Bun.write(outsideTarget, "do-not-touch\n");
		await fs.rm(path.join(worktreeModules, ".gjc-node-modules-links.json"));
		await fs.symlink(outsideTarget, path.join(worktreeModules, ".gjc-node-modules-links.json"));

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "manifest-symlink"])).toThrow(
			/worktree_boundary_manifest_invalid/,
		);
		// The external target is never created or overwritten through the link.
		expect(await Bun.file(outsideTarget).text()).toBe("do-not-touch\n");
	});

	it("fails closed on a dangling link-ownership manifest symlink", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-manifest-dangling-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "manifest-dangling"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(path.join(worktreeModules, ".gjc-node-modules-links.json"));
		await fs.symlink(
			path.join(os.tmpdir(), "gjc-no-such-manifest-target-xyz"),
			path.join(worktreeModules, ".gjc-node-modules-links.json"),
		);

		// A dangling link must be treated as an obstruction, not "absent": the
		// write below it would otherwise create the external target.
		expect(() => prepareLaunchWorktree(repo, ["--worktree", "manifest-dangling"])).toThrow(
			/worktree_boundary_manifest_invalid/,
		);
	});

	it("never treats a symlinked boundary marker as launcher ownership", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-marker-symlink-");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-marker-escape-"));
		cleanupPaths.push(outside);
		const launched = prepareLaunchWorktree(repo, ["--worktree", "marker-symlink"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		const outsideTarget = path.join(outside, "marker.txt");
		await Bun.write(outsideTarget, "marker\n");
		await fs.rm(path.join(worktreeModules, ".gjc-node-modules-boundary"));
		await fs.symlink(outsideTarget, path.join(worktreeModules, ".gjc-node-modules-boundary"));

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "marker-symlink"])).toThrow(
			/worktree_boundary_marker_invalid/,
		);
		expect(await Bun.file(outsideTarget).text()).toBe("marker\n");
	});

	it("excludes members matched by later negated pnpm workspace patterns", async () => {
		const repo = await createRepo("gjc-launch-worktree-negation-");
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await fs.mkdir(path.join(repo, "packages", "legacy"), { recursive: true });
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "!packages/legacy"] }),
		);
		await Bun.write(path.join(repo, "packages", "app", "package.json"), '{"name":"@scope/app"}\n');
		await Bun.write(path.join(repo, "packages", "legacy", "package.json"), '{"name":"@scope/legacy"}\n');
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "negated workspace"], repo);

		const launched = prepareLaunchWorktree(repo, ["--worktree", "negation"]);
		const modules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(path.join(modules, "@scope", "app")).catch(() => null))?.isSymbolicLink()).toBe(true);
		// The negated member is excluded: never linked, so it cannot shadow or
		// be resolved as a workspace member.
		expect(await fs.lstat(path.join(modules, "@scope", "legacy")).catch(() => null)).toBe(null);
	});

	it("reconciles a boundary when a member becomes excluded by a negated pattern", async () => {
		const repo = await createRepo("gjc-launch-worktree-negation-reconcile-");
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await fs.mkdir(path.join(repo, "packages", "legacy"), { recursive: true });
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
		);
		await Bun.write(path.join(repo, "packages", "app", "package.json"), '{"name":"@scope/app"}\n');
		await Bun.write(path.join(repo, "packages", "legacy", "package.json"), '{"name":"@scope/legacy"}\n');
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "workspace"], repo);

		const first = prepareLaunchWorktree(repo, ["--worktree", "negation-reconcile"]);
		const modules = path.join(first.cwd, "node_modules");
		expect((await fs.lstat(path.join(modules, "@scope", "legacy"))).isSymbolicLink()).toBe(true);

		// Exclude the member at a later commit.
		await Bun.write(
			path.join(first.cwd, "package.json"),
			JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "!packages/legacy"] }),
		);
		const reused = prepareLaunchWorktree(repo, ["--worktree", "negation-reconcile"]);
		const reconciled = path.join(reused.cwd, "node_modules");
		expect(await fs.lstat(path.join(reconciled, "@scope", "legacy")).catch(() => null)).toBe(null);
		expect((await fs.lstat(path.join(reconciled, "@scope", "app"))).isSymbolicLink()).toBe(true);
	});
	it("re-includes a member negated earlier when a later positive pattern matches it", async () => {
		const repo = await createRepo("gjc-launch-worktree-reinclude-");
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await fs.mkdir(path.join(repo, "packages", "legacy"), { recursive: true });
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({
				name: "root",
				private: true,
				workspaces: ["packages/*", "!packages/legacy", "packages/legacy"],
			}),
		);
		await Bun.write(path.join(repo, "packages", "app", "package.json"), '{"name":"@scope/app"}\n');
		await Bun.write(path.join(repo, "packages", "legacy", "package.json"), '{"name":"@scope/legacy"}\n');
		run("git", ["add", "-A"], repo);
		run("git", ["commit", "-m", "re-inclusion"], repo);

		const launched = prepareLaunchWorktree(repo, ["--worktree", "reinclude"]);
		const modules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(path.join(modules, "@scope", "app"))).isSymbolicLink()).toBe(true);
		// Ordered semantics: the trailing positive pattern re-includes the member
		// the negation removed, so it gets a local link instead of resolving
		// through an ancestor.
		expect((await fs.lstat(path.join(modules, "@scope", "legacy"))).isSymbolicLink()).toBe(true);
	});

	it("refuses an external node_modules link that is not a complete boundary", async () => {
		// Ancestor workspace whose install graph carries a source-linked member.
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-worktree-external-link-"));
		cleanupPaths.push(parent);
		const ancestorModules = path.join(parent, "node_modules");
		await fs.mkdir(path.join(ancestorModules, "@scope"), { recursive: true });
		await fs.symlink(path.join(parent, "live-app"), path.join(ancestorModules, "@scope", "app"));
		await fs.mkdir(path.join(parent, "live-app"), { recursive: true });

		const repo = await createWorkspaceRepo("gjc-launch-worktree-external-link-repo-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "external-link"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.symlink(ancestorModules, worktreeModules);

		// The ancestor tree does not resolve the worktree's own member (it
		// points at the ancestor's live copy), so accepting it would bind the
		// worktree to the ancestor's sources: refused.
		expect(() => prepareLaunchWorktree(repo, ["--worktree", "external-link"])).toThrow(
			/worktree_node_modules_boundary_incomplete/,
		);
	});

	it("refuses a non-directory node_modules entry in a workspace worktree", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-file-obstruction-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "file-obstruction"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await Bun.write(worktreeModules, "not a directory\n");

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "file-obstruction"])).toThrow(
			/worktree_node_modules_not_a_boundary/,
		);
		// Refused, not deleted.
		expect(await Bun.file(worktreeModules).text()).toBe("not a directory\n");
	});
	it("refuses a marker-owned boundary left incomplete by a damaged replacement", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-partial-reconcile-");
		const launched = prepareLaunchWorktree(repo, ["--worktree", "partial-reconcile"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(path.join(worktreeModules, "@scope", "app"))).isSymbolicLink()).toBe(true);

		// Simulate the crash window of a non-atomic replacement: the member
		// link is gone while the marker and ownership manifest survive.
		await fs.rm(path.join(worktreeModules, "@scope", "app"));

		expect(() => prepareLaunchWorktree(repo, ["--worktree", "partial-reconcile"])).toThrow(
			/worktree_boundary_incomplete_after_reconcile/,
		);
	});

	it("rejects symlinked parents that resolve outside the boundary", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-symlinked-parent-");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-outside-checkout-"));
		cleanupPaths.push(outside);
		const launched = prepareLaunchWorktree(repo, ["--worktree", "symlinked-parent"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		// An attacker-controlled @scope directory that is a symlink outside.
		await fs.rm(path.join(worktreeModules, "@scope"), { recursive: true, force: true });
		await fs.symlink(outside, path.join(worktreeModules, "@scope"));

		// Reconciliation must refuse to create links through the symlinked parent
		// instead of writing into the outside directory.
		let message = "";
		try {
			prepareLaunchWorktree(repo, ["--worktree", "symlinked-parent"]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/worktree_workspace_link_outside|worktree_workspace_member_outside/);
		// The outside sentinel directory was not populated.
		expect(await fs.readdir(outside)).toEqual([]);
	});
});

describe("GJC_WORKTREE_DIR path red-team", () => {
	it("fails closed when a {repo}-less template points two repos at one worktree path", async () => {
		const first = await createRepo("gjc-launch-bucket-collision-a-");
		const second = await createRepo("gjc-launch-bucket-collision-b-");
		const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-collision-root-"));
		cleanupPaths.push(shared);
		const bucket = path.join(shared, "one-bucket-for-everything");

		const ensured = withWorktreeBucketDir(bucket, () =>
			ensureLaunchWorktree(planLaunchWorktree(first, { enabled: true, detached: false, name: "feature/demo" })),
		);
		expect(ensured.enabled && ensured.created).toBe(true);

		// The second repo resolves to the SAME worktree path. Adoption must be refused:
		// the path belongs to a different repository (git-common-dir mismatch), so the
		// launch must fail closed with worktree_path_conflict instead of reusing it.
		expect(() =>
			withWorktreeBucketDir(bucket, () =>
				ensureLaunchWorktree(planLaunchWorktree(second, { enabled: true, detached: false, name: "feature/demo" })),
			),
		).toThrow(/worktree_path_conflict/);
		expect(run("git", ["branch", "--show-current"], ensured.enabled ? ensured.worktreePath : "")).toBe(
			"feature/demo",
		);
	});

	it("fails closed when same-basename repos in different parents share a {repo} root", async () => {
		const parentA = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-twin-a-"));
		const parentB = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-twin-b-"));
		cleanupPaths.push(parentA, parentB);
		const twinA = path.join(parentA, "app");
		const twinB = path.join(parentB, "app");
		for (const twin of [twinA, twinB]) {
			await fs.mkdir(twin);
			run("git", ["init"], twin);
			run("git", ["config", "user.email", "test@example.com"], twin);
			run("git", ["config", "user.name", "Test User"], twin);
			await Bun.write(path.join(twin, "README.md"), "hello\n");
			run("git", ["add", "README.md"], twin);
			run("git", ["commit", "-m", "init"], twin);
		}
		const shared = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-launch-bucket-twin-root-"));
		cleanupPaths.push(shared);

		// {repo} expands to the basename only, so both twins land in <shared>/app/<slug>.
		const template = path.join(shared, "{repo}");
		const ensured = withWorktreeBucketDir(template, () =>
			ensureLaunchWorktree(planLaunchWorktree(twinA, { enabled: true, detached: false, name: "feature/demo" })),
		);
		expect(ensured.enabled && ensured.created).toBe(true);
		expect(() =>
			withWorktreeBucketDir(template, () =>
				ensureLaunchWorktree(planLaunchWorktree(twinB, { enabled: true, detached: false, name: "feature/demo" })),
			),
		).toThrow(/worktree_path_conflict/);
	});

	it("pins the traversal contract: ../ segments resolve against the repository parent", async () => {
		const repo = await createRepo("gjc-launch-bucket-traversal-");
		const plan = withWorktreeBucketDir(path.join("..", "{repo}-wt"), () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);
		expect(plan.enabled && path.dirname(plan.worktreePath)).toBe(
			path.resolve(path.dirname(repo), "..", `${path.basename(repo)}-wt`),
		);
	});

	it("treats a backslash home prefix literally on POSIX", async () => {
		const repo = await createRepo("gjc-launch-bucket-backslash-");
		const plan = withWorktreeBucketDir("~\\gjc-worktrees\\{repo}", () =>
			planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" }),
		);
		// POSIX has no `~\` home form: the value must NOT expand to the home directory
		// and must stay a relative template resolved against the repository parent.
		expect(plan.enabled && plan.worktreePath.startsWith(os.homedir())).toBe(false);
		expect(plan.enabled && path.dirname(plan.worktreePath)).toBe(
			path.join(path.dirname(repo), `~\\gjc-worktrees\\${path.basename(repo)}`),
		);
	});
});

describe("resolveWorktreeBucketForPath Windows semantics", () => {
	const home = "C:\\Users\\kim";
	const repo = "C:\\repos\\app";

	it("expands ~/ and ~\\ against the injected Windows home", () => {
		expect(resolveWorktreeBucketForPath(repo, "~/wt/{repo}", home, path.win32)).toBe("C:\\Users\\kim\\wt\\app");
		expect(resolveWorktreeBucketForPath(repo, "~\\wt\\{repo}", home, path.win32)).toBe("C:\\Users\\kim\\wt\\app");
		expect(resolveWorktreeBucketForPath(repo, "~", home, path.win32)).toBe(home);
	});

	it("honors absolute drive paths and resolves relatives against the repo parent", () => {
		expect(resolveWorktreeBucketForPath(repo, "D:\\wt\\{repo}", home, path.win32)).toBe("D:\\wt\\app");
		expect(resolveWorktreeBucketForPath(repo, "{repo}.worktrees", home, path.win32)).toBe("C:\\repos\\app.worktrees");
		expect(resolveWorktreeBucketForPath(repo, ".worktrees", home, path.win32)).toBe("C:\\repos\\.worktrees");
	});

	it("keeps UNC repos on their share for the default and relative templates", () => {
		const uncRepo = "\\\\server\\share\\app";
		expect(resolveWorktreeBucketForPath(uncRepo, undefined, home, path.win32)).toBe(
			"\\\\server\\share\\app.gajae-code-worktrees",
		);
		expect(resolveWorktreeBucketForPath(uncRepo, "{repo}.worktrees", home, path.win32)).toBe(
			"\\\\server\\share\\app.worktrees",
		);
	});

	it("preserves repo basename case verbatim and treats blanks as the default", () => {
		expect(resolveWorktreeBucketForPath("C:\\repos\\App", "{repo}.worktrees", home, path.win32)).toBe(
			"C:\\repos\\App.worktrees",
		);
		expect(resolveWorktreeBucketForPath(repo, "   ", home, path.win32)).toBe("C:\\repos\\app.gajae-code-worktrees");
	});
});
