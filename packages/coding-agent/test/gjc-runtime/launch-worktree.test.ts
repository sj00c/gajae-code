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
		expect(await Bun.file(path.join(remediated.cwd, "node_modules")).exists()).toBe(false);
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
		expect(await Bun.file(path.join(launched.cwd, "node_modules")).exists()).toBe(false);
	});

	it("detects bun isolated-linker workspace layouts under node_modules/.bun", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-isolated-store-");
		const originModules = path.join(repo, "node_modules");
		const storeModules = path.join(originModules, ".bun", "node_modules", "@scope");
		await fs.mkdir(storeModules, { recursive: true });
		await fs.symlink(path.join(repo, "packages", "app"), path.join(storeModules, "app"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(await Bun.file(path.join(launched.cwd, "node_modules")).exists()).toBe(false);
	});
	it("detects pnpm scoped workspace layouts at deeper nesting (.pnpm depth 5)", async () => {
		const repo = await createWorkspaceRepo("gjc-launch-worktree-pnpm-store-");
		const originModules = path.join(repo, "node_modules");
		const storeModules = path.join(originModules, ".pnpm", "@scope+app@1.0.0", "node_modules", "@scope");
		await fs.mkdir(storeModules, { recursive: true });
		await fs.symlink(path.join(repo, "packages", "app"), path.join(storeModules, "app"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(await Bun.file(path.join(launched.cwd, "node_modules")).exists()).toBe(false);
	});

	it("detects the origin node_modules root itself linking into the source repo", async () => {
		const repo = await createRepo("gjc-launch-worktree-rootlink-");
		// A vendored node_modules directory inside the repo, with the root
		// node_modules symlink pointing at it.
		const vendored = path.join(repo, ".vendor", "node_modules");
		await fs.mkdir(vendored, { recursive: true });
		await fs.symlink(vendored, path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(await Bun.file(path.join(launched.cwd, "node_modules")).exists()).toBe(false);
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

		// A dangling link occupies the name without existing; the launch must not
		// crash trying to create a symlink over it (EEXIST) and must not follow it.
		const reused = prepareLaunchWorktree(repo, ["--worktree", "dangling-modules"]);
		expect((await fs.lstat(path.join(reused.cwd, "node_modules"))).isSymbolicLink()).toBe(true);
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
		const repo = await createWorkspaceRepo("gjc-launch-worktree-unreadable-scan-");
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
			const worktreeModules = path.join(launched.cwd, "node_modules");
			// The scan failed closed: no shared symlink exists.
			expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(false);
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it("keeps an unprovable stale link present instead of deleting it (identity EACCES)", async () => {
		const repo = await createRepo("gjc-launch-worktree-hoist-eacces-");
		await fs.mkdir(path.join(repo, "node_modules"));
		const launched = prepareLaunchWorktree(repo, ["--worktree", "hoist-eacces"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(true);

		// Target the identity-resolution branch specifically: the outer
		// sourceRoot realpath must still succeed, and only the worktree link's
		// resolution fails. Identity is then unprovable — the launcher must not
		// delete a possibly user-owned link on an unproven identity.
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
			const reused = prepareLaunchWorktree(repo, ["--worktree", "hoist-eacces"]);
			expect(reachedLinkResolution).toBe(true);
			// Unproven identity: the link survives; the launch reports present.
			expect((await fs.lstat(path.join(reused.cwd, "node_modules"))).isSymbolicLink()).toBe(true);
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
		const probe = Bun.spawnSync(["bun", "-e", 'import { marker } from "@scope/app"; console.log(marker)'], {
			cwd: launched.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(probe.stderr.toString()).toBe("");
		expect(probe.stdout.toString().trim()).toBe("worktree-own-source");
	});

	it("does not delete an unresolvable user-owned external node_modules link", async () => {
		const repo = await createRepo("gjc-launch-worktree-unresolvable-link-");
		const external = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-external-store-"));
		cleanupPaths.push(external);
		await fs.mkdir(path.join(repo, "node_modules"));

		const launched = prepareLaunchWorktree(repo, ["--worktree", "unresolvable-link"]);
		const worktreeModules = path.join(launched.cwd, "node_modules");
		await fs.rm(worktreeModules, { recursive: true, force: true });
		await fs.symlink(path.join(external, "store"), worktreeModules, "dir");

		// Identity resolution fails only for permission reasons: the link target is
		// a user-owned external store, not the source checkout. The launch must
		// keep the link (classify present) instead of deleting user data.
		const denied: typeof fsSync.realpathSync = (() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		}) as unknown as typeof fsSync.realpathSync;
		const realpathSpy = spyOn(fsSync, "realpathSync");
		realpathSpy.mockImplementationOnce(((pathArg: fsSync.PathLike) => {
			if (String(pathArg) === worktreeModules) return denied(pathArg);
			return fsSync.realpathSync(pathArg);
		}) as unknown as typeof fsSync.realpathSync);
		try {
			const reused = prepareLaunchWorktree(repo, ["--worktree", "unresolvable-link"]);
			expect((await fs.lstat(path.join(reused.cwd, "node_modules"))).isSymbolicLink()).toBe(true);
			expect(await fs.readlink(path.join(reused.cwd, "node_modules"))).toBe(path.join(external, "store"));
		} finally {
			realpathSpy.mockRestore();
		}
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
