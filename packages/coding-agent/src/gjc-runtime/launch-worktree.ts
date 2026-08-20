import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "../tools/render-utils";

export type GjcLaunchWorktreeMode =
	| { enabled: false }
	| { enabled: true; detached: true; name: null }
	| { enabled: true; detached: false; name: string };

export interface ParsedLaunchWorktreeMode {
	mode: GjcLaunchWorktreeMode;
	remainingArgs: string[];
}

export interface GjcLaunchWorktreePlan {
	enabled: true;
	repoRoot: string;
	worktreePath: string;
	detached: boolean;
	baseRef: string;
	branchName: string | null;
}

export interface GjcLaunchWorktreeResult extends GjcLaunchWorktreePlan {
	created: boolean;
	reused: boolean;
	createdBranch: boolean;
	dirty?: boolean;
}

interface GitWorktreeEntry {
	path: string;
	head: string;
	branchRef: string | null;
	detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	throw new Error(stderr || `git ${args.join(" ")} failed`);
}

function tryRunGit(cwd: string, args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function sanitizePathToken(value: string): string {
	const readable = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const prefix = readable || "default";
	const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${prefix}-${digest}`;
}

/**
 * Environment override for the directory that holds a repository's launch worktrees.
 *
 * The bucket is otherwise derived entirely from the repository path, so a machine that
 * already keeps worktrees somewhere else — a dedicated volume, or a pre-existing
 * `<repo>.worktrees` convention — has no way to say so and accumulates a second bucket
 * beside the first.
 */
const WORKTREE_BUCKET_ENV = "GJC_WORKTREE_DIR";
/**
 * Expands to the repository directory name.
 *
 * A single exported value therefore stays repo-scoped across every checkout, which is
 * what keeps two repositories that share a branch name from resolving to one worktree.
 */
const REPO_NAME_PLACEHOLDER = "{repo}";
const DEFAULT_WORKTREE_BUCKET = `${REPO_NAME_PLACEHOLDER}.gajae-code-worktrees`;

function expandHomePrefix(value: string, home: string, pathApi: typeof path.posix): string {
	if (value === "~") return home;
	return value.startsWith(`~${pathApi.sep}`) || value.startsWith("~/") ? pathApi.join(home, value.slice(2)) : value;
}

/**
 * Pure core of {@link resolveWorktreeBucket}, exported for tests.
 *
 * Injecting the home directory and path implementation lets tests exercise
 * Windows drive/UNC/separator semantics (`path.win32`) on any host.
 */
export function resolveWorktreeBucketForPath(
	repoRoot: string,
	envValue: string | undefined,
	home: string,
	pathApi: typeof path.posix,
): string {
	const configured = envValue?.trim();
	const template = expandHomePrefix(configured || DEFAULT_WORKTREE_BUCKET, home, pathApi);
	return pathApi.resolve(
		pathApi.dirname(repoRoot),
		template.replaceAll(REPO_NAME_PLACEHOLDER, pathApi.basename(repoRoot)),
	);
}

/**
 * Directory that holds this repository's launch worktrees.
 *
 * A relative override resolves against the repository's PARENT directory, matching the
 * default's own shape, so `{repo}.worktrees` adopts an existing sibling bucket and
 * `.worktrees` parks a hidden bucket beside the repository. An absolute override is used verbatim.
 */
function resolveWorktreeBucket(repoRoot: string): string {
	return resolveWorktreeBucketForPath(repoRoot, process.env[WORKTREE_BUCKET_ENV], os.homedir(), path);
}

function resolveSourceBranchSlug(repoRoot: string, baseRef: string): string {
	const branch = tryRunGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch) return sanitizePathToken(branch);
	return `head-${baseRef.slice(0, 12)}`;
}

function branchExists(repoRoot: string, branchName: string): boolean {
	const result = Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
		cwd: repoRoot,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

function validateBranchName(repoRoot: string, branchName: string): void {
	const result = Bun.spawnSync(["git", "check-ref-format", "--branch", branchName], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode === 0) return;
	const stderr = result.stderr.toString().trim();
	throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}

function listWorktrees(repoRoot: string): GitWorktreeEntry[] {
	const raw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	if (!raw) return [];
	return raw
		.split(/\n\n+/)
		.map(chunk => chunk.trim())
		.filter(Boolean)
		.flatMap(chunk => {
			const lines = chunk
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean);
			const worktreeLine = lines.find(line => line.startsWith("worktree "));
			const headLine = lines.find(line => line.startsWith("HEAD "));
			const branchLine = lines.find(line => line.startsWith("branch "));
			if (!worktreeLine || !headLine) return [];
			return [
				{
					path: path.resolve(worktreeLine.slice("worktree ".length)),
					head: headLine.slice("HEAD ".length).trim(),
					branchRef: branchLine ? branchLine.slice("branch ".length).trim() : null,
					detached: lines.includes("detached") || !branchLine,
				},
			];
		});
}

function findWorktreeByPath(entries: GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | null {
	const resolved = path.resolve(worktreePath);
	return entries.find(entry => path.resolve(entry.path) === resolved) ?? null;
}

function describeWorktreeEntry(entry: GitWorktreeEntry): string {
	return entry.detached ? `detached HEAD ${entry.head}` : (entry.branchRef ?? `HEAD ${entry.head}`);
}

function formatWorktreeTargetMismatch(plan: GjcLaunchWorktreePlan, existing: GitWorktreeEntry): string {
	const expected = plan.detached ? `detached HEAD ${plan.baseRef}` : `branch refs/heads/${plan.branchName ?? ""}`;
	return [
		`worktree_target_mismatch:${plan.worktreePath}`,
		`GJC launch worktree target is already registered for ${describeWorktreeEntry(existing)}, but this launch expects ${expected}.`,
		`Path: ${plan.worktreePath}`,
		"Refusing to delete or reuse the conflicting worktree automatically. Safe remediation: inspect the path, commit/stash any work, then remove or prune the stale worktree with git worktree remove <path> when it is no longer needed, or choose a different --worktree name.",
	].join("\n");
}

function hasBranchInUse(entries: GitWorktreeEntry[], branchName: string, worktreePath: string): boolean {
	const expectedRef = `refs/heads/${branchName}`;
	const resolvedPath = path.resolve(worktreePath);
	return entries.some(entry => entry.branchRef === expectedRef && path.resolve(entry.path) !== resolvedPath);
}

function fileSystemErrorCode(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: null;
}

function formatBucketPath(bucketPath: string): string {
	return JSON.stringify(shortenPath(bucketPath));
}

function brokenBucketSymlinkError(bucketPath: string): Error {
	return new Error(
		[
			"worktree_bucket_broken_symlink",
			"The GJC launch worktree bucket is a symbolic link whose target cannot be resolved; it may be unmounted or offloaded cold storage.",
			`Path: ${formatBucketPath(bucketPath)}`,
			"Safe remediation: restore or remount the link target, or inspect and remove the dangling link with platform-appropriate filesystem tools, then relaunch. GJC did not delete or replace the entry.",
		].join("\n"),
	);
}

function bucketNotDirectoryError(bucketPath: string, symlinkTarget = false): Error {
	return new Error(
		[
			"worktree_bucket_not_directory",
			symlinkTarget
				? "The GJC launch worktree bucket is a symbolic link whose target is not a directory."
				: "The GJC launch worktree bucket path exists but is not a directory.",
			`Path: ${formatBucketPath(bucketPath)}`,
			"Safe remediation: inspect the obstructing entry and move or remove it with platform-appropriate filesystem tools, then relaunch. GJC did not delete or replace the entry.",
		].join("\n"),
	);
}

function inspectBucketDir(bucketPath: string): "missing" | "usable" {
	let entry: fs.Stats;
	try {
		entry = fs.lstatSync(bucketPath);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return "missing";
		throw new Error(
			[
				"worktree_bucket_inspection_failed",
				`GJC could not inspect the launch worktree bucket${fileSystemErrorCode(error) ? ` (${fileSystemErrorCode(error)})` : ""}.`,
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: verify that the bucket parent is accessible, then relaunch. GJC did not modify the entry.",
			].join("\n"),
		);
	}
	if (entry.isDirectory()) return "usable";
	if (!entry.isSymbolicLink()) throw bucketNotDirectoryError(bucketPath);

	let target: fs.Stats;
	try {
		target = fs.statSync(bucketPath);
	} catch (error) {
		const code = fileSystemErrorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw brokenBucketSymlinkError(bucketPath);
		throw new Error(
			[
				"worktree_bucket_target_inspection_failed",
				`GJC could not inspect the launch worktree bucket link target${code ? ` (${code})` : ""}.`,
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: verify that the link target is accessible, then relaunch. GJC did not modify the link.",
			].join("\n"),
		);
	}
	if (target.isDirectory()) return "usable";
	throw bucketNotDirectoryError(bucketPath, true);
}

function ensureBucketDirUsable(bucketPath: string): void {
	inspectBucketDir(bucketPath);
	try {
		fs.mkdirSync(bucketPath, { recursive: true });
	} catch (error) {
		// The entry can change between lstat/stat and mkdir. Re-inspect so a
		// racing broken link or non-directory is still reported actionably.
		inspectBucketDir(bucketPath);
		const code = fileSystemErrorCode(error);
		throw new Error(
			[
				"worktree_bucket_create_failed",
				`GJC could not create or reuse the launch worktree bucket${code ? ` (${code})` : ""}.`,
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: verify parent permissions and bucket accessibility, then relaunch. GJC did not delete or replace any entry.",
			].join("\n"),
		);
	}
	if (inspectBucketDir(bucketPath) === "missing") {
		throw new Error(
			[
				"worktree_bucket_changed_during_preflight",
				"The GJC launch worktree bucket disappeared while launch was preparing it.",
				`Path: ${formatBucketPath(bucketPath)}`,
				"Safe remediation: stabilize the bucket mount or parent directory, then relaunch. GJC did not delete or replace any entry.",
			].join("\n"),
		);
	}
}

function pruneStaleWorktreePath(repoRoot: string): void {
	runGit(repoRoot, ["worktree", "prune"]);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
	if (!fs.existsSync(worktreePath)) return null;
	const repoCommonDir = tryRunGit(repoRoot, ["rev-parse", "--git-common-dir"]);
	const worktreeCommonDir = tryRunGit(worktreePath, ["rev-parse", "--git-common-dir"]);
	if (!repoCommonDir || !worktreeCommonDir) return null;
	if (path.resolve(repoRoot, repoCommonDir) !== path.resolve(worktreePath, worktreeCommonDir)) return null;
	const head = tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
	if (!head) return null;
	const branchRef = tryRunGit(worktreePath, ["symbolic-ref", "-q", "HEAD"]);
	return { path: path.resolve(worktreePath), head, branchRef, detached: !branchRef };
}

function resolveCanonicalRepoRoot(cwd: string): string {
	const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const commonDir = tryRunGit(repoRoot, ["rev-parse", "--git-common-dir"]);
	if (!commonDir) return repoRoot;
	const resolvedCommonDir = path.resolve(repoRoot, commonDir);
	if (path.basename(resolvedCommonDir) !== ".git") return repoRoot;
	const ownerRoot = path.dirname(resolvedCommonDir);
	if (tryRunGit(ownerRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") return repoRoot;
	return ownerRoot;
}

function isWorktreeDirty(worktreePath: string): boolean {
	return runGit(worktreePath, ["status", "--porcelain"]).length > 0;
}

function resolveOptionalWorktreeName(args: string[], index: number): { name: string | null; nextIndex: number } {
	const next = args[index + 1];
	if (!next) return { name: null, nextIndex: index };
	if (next === "--") return { name: null, nextIndex: index };
	if (next.startsWith("-")) return { name: null, nextIndex: index };
	return { name: next.trim() || null, nextIndex: index + 1 };
}

export function parseLaunchWorktreeMode(args: string[]): ParsedLaunchWorktreeMode {
	let mode: GjcLaunchWorktreeMode = { enabled: false };
	const remainingArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			remainingArgs.push(...args.slice(index));
			break;
		}
		if (arg === "--worktree" || arg === "-w") {
			const parsed = resolveOptionalWorktreeName(args, index);
			mode = parsed.name
				? { enabled: true, detached: false, name: parsed.name }
				: { enabled: true, detached: true, name: null };
			index = parsed.nextIndex;
			continue;
		}
		if (arg.startsWith("--worktree=")) {
			const name = arg.slice("--worktree=".length).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		if (arg.startsWith("-w=") || (arg.startsWith("-w") && arg.length > 2)) {
			const name = arg.startsWith("-w=") ? arg.slice("-w=".length).trim() : arg.slice(2).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		remainingArgs.push(arg);
	}

	return { mode, remainingArgs };
}

export function planLaunchWorktree(
	cwd: string,
	mode: GjcLaunchWorktreeMode,
): GjcLaunchWorktreePlan | { enabled: false } {
	if (!mode.enabled) return { enabled: false };
	const repoRoot = resolveCanonicalRepoRoot(cwd);
	const baseRef = runGit(repoRoot, ["rev-parse", "HEAD"]);
	const branchName = mode.detached ? null : mode.name;
	if (branchName) validateBranchName(repoRoot, branchName);
	const worktreeSlug = mode.detached ? resolveSourceBranchSlug(repoRoot, baseRef) : sanitizePathToken(mode.name);
	const worktreePath = path.join(resolveWorktreeBucket(repoRoot), worktreeSlug);
	return { enabled: true, repoRoot, worktreePath, detached: mode.detached, baseRef, branchName };
}

export function ensureLaunchWorktree(
	plan: GjcLaunchWorktreePlan | { enabled: false },
): GjcLaunchWorktreeResult | { enabled: false } {
	if (!plan.enabled) return { enabled: false };
	let allWorktrees = listWorktrees(plan.repoRoot);
	const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	if (staleAtPath && !fs.existsSync(staleAtPath.path)) {
		pruneStaleWorktreePath(plan.repoRoot);
		allWorktrees = listWorktrees(plan.repoRoot);
	}

	const existingAtPath =
		findWorktreeByPath(allWorktrees, plan.worktreePath) ??
		readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
	const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

	if (existingAtPath) {
		let dirty = isWorktreeDirty(plan.worktreePath);
		if (plan.detached) {
			if (!existingAtPath.detached) {
				throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
			}
			if (existingAtPath.head !== plan.baseRef) {
				if (dirty) throw new Error(`worktree_dirty:${plan.worktreePath}`);
				runGit(plan.worktreePath, ["checkout", "--detach", plan.baseRef]);
				dirty = false;
			}
		} else if (existingAtPath.branchRef !== expectedBranchRef) {
			throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
		}
		return {
			...plan,
			worktreePath: path.resolve(plan.worktreePath),
			created: false,
			reused: true,
			createdBranch: false,
			...(dirty ? { dirty: true } : {}),
		};
	}

	if (fs.existsSync(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
	if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
		throw new Error(`branch_in_use:${plan.branchName}`);
	}

	ensureBucketDirUsable(path.dirname(plan.worktreePath));
	const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;
	const args = ["worktree", "add"];
	if (plan.detached) args.push("--detach", plan.worktreePath, plan.baseRef);
	else if (branchAlreadyExisted) args.push(plan.worktreePath, plan.branchName ?? "");
	else args.push("-b", plan.branchName ?? "", plan.worktreePath, plan.baseRef);

	const result = Bun.spawnSync(["git", ...args], { cwd: plan.repoRoot, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) throw new Error(`branch_in_use:${plan.branchName}`);
		throw new Error(stderr || `worktree_add_failed:${args.join(" ")}`);
	}

	return {
		...plan,
		worktreePath: path.resolve(plan.worktreePath),
		created: true,
		reused: false,
		createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
	};
}

export type NodeModulesReuse = "symlink" | "present" | "missing" | "isolated";

/**
 * Depth cap for the workspace self-link scan in {@link nodeModulesLinksInto}.
 *
 * Package managers lay workspace links out at bounded depth: bun/npm hoist them
 * directly under `node_modules/<scope>/<pkg>` (depth 2), bun's isolated linker
 * under `node_modules/.bun/node_modules/<scope>/<pkg>` (depth 3), and pnpm's
 * scoped layout under `node_modules/.pnpm/<scope>+<pkg>@<ver>/node_modules/<scope>/<pkg>`
 * (depth 5). The cap covers that deepest real layout with margin while keeping
 * the scan bounded and cycle-safe.
 */
const NODE_MODULES_SCAN_DEPTH = 6;

/** Filesystem error codes that mean "this link resolves nowhere", not "unreadable". */
const BROKEN_LINK_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EDEADLK"]);

/**
 * Detects whether a `node_modules` tree links back into the repository checkout
 * that owns it (#4620).
 *
 * Workspace installs (bun, npm workspaces, pnpm) create symlinks whose targets
 * resolve inside the repo — `node_modules/@scope/pkg -> ../../packages/pkg` for
 * hoisted layouts, or equivalents under `.bun/node_modules` / `.pnpm` for
 * isolated ones. Reusing such a tree from a sibling checkout makes every
 * workspace import resolve the *origin's* live sources, and installs run inside
 * the worktree mutate the origin's tree. `node_modules` links that resolve
 * outside the repo (external registries, global stores) carry no such coupling
 * and remain safe to share. The scan never descends through a symlink that
 * resolves outside `node_modules` itself: workspace self-links always live
 * inside the tree, and chasing arbitrary external targets would make the scan
 * unbounded.
 *
 * Links that resolve *within the `node_modules` tree itself* are not workspace
 * self-links: `node_modules/.bin/tool -> ../pkg/bin/tool.js`, and the intra-tree
 * links isolated layouts use for nested dependencies, describe the install
 * graph rather than the repository's own sources. They exist in essentially
 * every install, and treating them as self-links would refuse a shared tree for
 * ordinary non-workspace repositories — leaving the worktree with no
 * `node_modules` at all (#4626 review). Only targets that escape the tree and
 * land on repository sources (`node_modules/@scope/pkg -> ../../packages/pkg`)
 * couple the two checkouts.
 *
 * Fails closed: a link whose target cannot be resolved for any reason other
 * than the link being broken is treated as self-linked, because an unreadable
 * link can never be proven safe to share.
 */
export function nodeModulesLinksInto(nodeModulesPath: string, sourceRoot: string): boolean {
	const sourceReal = fs.realpathSync(sourceRoot);
	// Real location of the tree being scanned. Targets landing inside it are
	// install-graph internals, not repository sources; a root that cannot be
	// resolved yields null, which excludes nothing and keeps the scan strict.
	const modulesReal = tryRealpath(nodeModulesPath);
	// The node_modules root itself may be a symlink: a root that resolves
	// OUTSIDE the source repo belongs to another checkout's install graph
	// (nested repo in a parent workspace, external store) and must never be
	// recursively traversed as if it were this repo's own tree — its entries
	// resolve foreign live sources by construction, so the share decision is
	// already made. A root resolving inside the source repo is checked by
	// prefix below.
	const rootStat = fs.lstatSync(nodeModulesPath);
	if (rootStat.isSymbolicLink()) {
		const rootReal = tryRealpath(nodeModulesPath);
		if (rootReal === null) return true;
		if (!isInsideOrEqualReal(sourceReal, rootReal)) return true;
	}
	if (resolvesInside(rootStat, nodeModulesPath, sourceReal, modulesReal)) return true;
	const stack: Array<{ dir: string; depth: number }> = [{ dir: nodeModulesPath, depth: 0 }];
	let depthCapped = false;
	while (stack.length > 0) {
		const { dir, depth } = stack.pop() as { dir: string; depth: number };
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			// A directory that vanished mid-scan holds nothing; one that cannot be
			// read might hold the workspace self-link this scan exists to find.
			if (code !== "ENOENT") return true;
			continue;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (resolvesInside(entry, entryPath, sourceReal, modulesReal)) return true;
			if (entry.isDirectory() && depth + 1 < NODE_MODULES_SCAN_DEPTH) {
				stack.push({ dir: entryPath, depth: depth + 1 });
			} else if (entry.isDirectory()) {
				// A directory at the depth cap was not examined: the scan cannot
				// prove it holds no self-link, so the tree is treated as linked.
				depthCapped = true;
			}
		}
	}
	return depthCapped;
}

/** True when `candidateReal` equals `dirReal` or resolves strictly inside it (realpath identity). */
function isInsideOrEqualReal(dirReal: string, candidateReal: string): boolean {
	if (candidateReal === dirReal) return true;
	const relative = path.relative(dirReal, candidateReal);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Returns true when `entry` is a symlink whose target provably resolves inside
 * `sourceReal` *and outside* `modulesReal`, or whose resolution fails in a way
 * that cannot rule that out. A symlink whose target resolves to nowhere (broken
 * or looping) resolves nowhere and cannot pull origin sources in.
 *
 * `modulesReal` is the real path of the `node_modules` tree being scanned, or
 * null when it could not be resolved. Targets inside it are install-graph
 * internals (`.bin` shims, nested dependency links) and never couple the
 * worktree to the origin's sources; targets reaching repository sources outside
 * it do, and are still reported.
 */
function resolvesInside(
	entry: fs.Stats | fs.Dirent,
	entryPath: string,
	sourceReal: string,
	modulesReal: string | null,
): boolean {
	if (!entry.isSymbolicLink()) return false;
	let target: string;
	try {
		target = fs.realpathSync(entryPath);
	} catch (error) {
		return !BROKEN_LINK_CODES.has((error as NodeJS.ErrnoException).code ?? "");
	}
	const insideSource =
		sameFileSystemPath(target, sourceReal, sourceReal) ||
		(volumeMatchesCaseInsensitively(sourceReal) &&
			target.toLowerCase().startsWith(`${sourceReal.toLowerCase()}${path.sep}`)) ||
		target.startsWith(`${sourceReal}${path.sep}`);
	if (!insideSource) return false;
	return modulesReal === null || !isInsideOrEqualRealCaseAware(modulesReal, target, sourceReal);
}

/**
 * {@link isInsideOrEqualReal} that also accepts a case-folded match when the
 * probed volume is case-insensitive, so a `.bin` target recorded with different
 * casing than its tree is still recognized as living inside it.
 */
function isInsideOrEqualRealCaseAware(dirReal: string, candidateReal: string, probeRoot: string): boolean {
	if (isInsideOrEqualReal(dirReal, candidateReal)) return true;
	if (!volumeMatchesCaseInsensitively(probeRoot)) return false;
	return isInsideOrEqualReal(dirReal.toLowerCase(), candidateReal.toLowerCase());
}

/**
 * Marker file inside a launcher-owned worktree `node_modules` boundary recording
 * that this launcher created the directory (#4620). Only directories carrying
 * this marker are reconciled or removed by remediation; everything else is
 * user-owned and never touched.
 */
const NODE_MODULES_OWNERSHIP_MARKER = ".gjc-node-modules-boundary";
/**
 * Per-link ownership manifest beside {@link NODE_MODULES_OWNERSHIP_MARKER},
 * recording every member link this launcher created and its recorded target.
 * Only recorded links are ever replaced or pruned during reconciliation.
 */
const NODE_MODULES_LINK_OWNERSHIP_MANIFEST = ".gjc-node-modules-links.json";

/**
 * Lock directory serializing boundary inspection/reconciliation/commit for one
 * worktree (#4626 review: same-worktree race). `mkdir` is atomic on every
 * supported filesystem, so creation doubles as acquisition.
 */
const NODE_MODULES_BOUNDARY_LOCK = ".gjc-node-modules-boundary.lock";
/** How long a contender waits for a held boundary lock before failing. */
const BOUNDARY_LOCK_WAIT_MS = 5_000;
/** Age after which a leftover lock directory is treated as abandoned. */
const BOUNDARY_LOCK_STALE_MS = 60_000;

/**
 * Runs `body` holding the worktree's boundary lock. A concurrent holder is
 * waited out briefly; a lock older than {@link BOUNDARY_LOCK_STALE_MS} belongs
 * to a crashed launcher and is broken. The lock directory is transient —
 * created on acquisition, removed on release — and never carries user data.
 */
function withBoundaryLock<T>(worktreePath: string, body: () => T): T {
	const lockPath = path.join(worktreePath, NODE_MODULES_BOUNDARY_LOCK);
	const deadline = Date.now() + BOUNDARY_LOCK_WAIT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = tryLstat(lockPath);
			if (stat !== null && !stat.isDirectory()) {
				// A non-directory entry at the lock name is user-owned and never
				// removed; it cannot be a launcher lock, so fail closed.
				throw new Error(
					`worktree_boundary_lock_invalid:${JSON.stringify(shortenPath(lockPath))} — the boundary lock ` +
						"name is occupied by an entry that is not a lock directory. Remove it and relaunch.",
				);
			}
			if (stat !== null && Date.now() - stat.mtimeMs > BOUNDARY_LOCK_STALE_MS) {
				fs.rmSync(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`worktree_boundary_lock_busy:${JSON.stringify(shortenPath(lockPath))} — another launch is ` +
						"reconciling this worktree's node_modules boundary. Retry once it finishes, or remove the " +
						"stale lock directory if that launch crashed.",
				);
			}
			Bun.sleepSync(25);
		}
	}
	try {
		return body();
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true });
	}
}

/** Package-name grammar accepted for boundary links (npm scope rules). */
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Isolates launch-worktree dependency resolution (#4620).
 *
 * Reusing the origin checkout's `node_modules` is only safe when the tree links
 * back into nothing inside the origin repository. Workspace installs violate
 * that: their `@scope/pkg -> packages/pkg` links make worktree imports resolve
 * the origin checkout's live sources and let worktree-side installs rewrite the
 * origin's links. When self-links are detected the worktree is left without a
 * shared symlink — never a cross-checkout link — and instead carries a
 * launcher-owned boundary that links the worktree's own workspace members.
 *
 * The boundary is reconciled on every launch so a reused worktree checked out
 * at a different commit never resolves stale or missing members through an
 * ancestor `node_modules`. An origin `node_modules` that is itself a symlink
 * (vendored inside the repo, or a nested-repo parent-workspace hoist) is never
 * shared either: its entries belong to another checkout's install graph.
 *
 * Ownership rules: a `node_modules` directory is launcher-owned only when it
 * carries {@link NODE_MODULES_OWNERSHIP_MARKER}. Remediation removes only
 * launcher-owned directories and positively-identified launcher-created
 * symlinks (target equal to the source checkout's own `node_modules`). Any
 * other link — including one whose target cannot be resolved — is user-owned:
 * the launch fails closed with an actionable error rather than deleting it or
 * continuing through an unproven dependency boundary.
 */
export function ensureReusableNodeModules(sourceRoot: string, worktreePath: string): NodeModulesReuse {
	// Inspection, remediation, reconciliation, metadata commit, and the
	// completeness post-condition are one locked transaction per worktree:
	// two concurrent launches against the same worktree must not observe a
	// half-populated boundary and accept it as complete (#4626 review:
	// same-worktree race).
	return withBoundaryLock(worktreePath, () => ensureReusableNodeModulesLocked(sourceRoot, worktreePath));
}

function ensureReusableNodeModulesLocked(sourceRoot: string, worktreePath: string): NodeModulesReuse {
	const target = path.join(worktreePath, "node_modules");
	const targetStat = tryLstat(target);
	if (targetStat) {
		if (targetStat.isSymbolicLink()) {
			// existsSync follows the link; a dangling link reports false but still
			// occupies the name, so it is handled here rather than below.
			if (positivelyResolvesToSourceModules(target, sourceRoot)) {
				fs.rmSync(target, { force: true });
				// A plain (non-workspace) repository whose source tree is proven
				// safe to share keeps its dependency tree: re-establish the same
				// share this launcher created instead of leaving the worktree
				// with no dependencies at all. Only a workspace repo, a missing
				// source tree, a symlinked source root, or a source tree that
				// now links back into the repo isolates.
				const declaration = readWorkspaceDeclaration(worktreePath);
				const source = path.join(sourceRoot, "node_modules");
				const sourceStat = tryLstat(source);
				if (
					!declaration &&
					sourceStat !== null &&
					sourceStat.isDirectory() &&
					!nodeModulesLinksInto(source, sourceRoot)
				) {
					fs.symlinkSync(source, target, "junction");
					return "symlink";
				}
				createWorkspaceSelfLinkBoundary(worktreePath);
				return "isolated";
			}
			// A link that resolves is either provably the source checkout's own
			// node_modules (handled above, the exact link this launcher creates)
			// or another tree. Any other tree is user-owned, but ownership alone
			// does not isolate resolution: for a workspace repo it must also be a
			// complete boundary for this commit, or missing members would resolve
			// through an ancestor checkout (#4620).
			const resolved = tryRealpath(target);
			if (resolved !== null) {
				const sourceModules = tryRealpath(path.join(sourceRoot, "node_modules"));
				const isSourceModules = sourceModules !== null && sameFileSystemPath(resolved, sourceModules, sourceRoot);
				if (!isSourceModules) {
					const declaration = readWorkspaceDeclaration(worktreePath);
					if (declaration && !isCompleteResolutionBoundary(worktreePath, target, declaration)) {
						throw new Error(
							`worktree_node_modules_boundary_incomplete:${JSON.stringify(shortenPath(target))} — the worktree ` +
								"declares workspace packages that this link does not resolve, so missing members would " +
								"resolve through an ancestor checkout. Run the package manager inside the worktree to " +
								"complete the install, or remove this link and relaunch to let GJC create its boundary.",
						);
					}
					return "present";
				}
			}
			// Unresolvable (EACCES/EPERM/EIO/dangling/transient) or otherwise
			// unproven: preserve the link — ownership of a broken or unreadable
			// link can never be proven — and refuse to launch through it.
			throw new Error(
				`worktree_node_modules_unverified:${JSON.stringify(shortenPath(target))} — GJC cannot prove this ` +
					"node_modules link is safe to reuse or remove. Remove it manually or point it at the source " +
					"checkout's own node_modules, then relaunch.",
			);
		}
		if (targetStat.isDirectory()) {
			const marker = path.join(target, NODE_MODULES_OWNERSHIP_MARKER);
			// The marker is the launcher's ownership proof: anything but a
			// regular file inside this directory (symlink, dir, dangling link)
			// cannot prove launcher ownership and must not be followed.
			assertBoundaryMetadataFile(target, marker, "worktree_boundary_marker_invalid");
			if (fs.existsSync(marker)) {
				// Launcher-owned: reconcile against the current commit's members.
				createWorkspaceSelfLinkBoundary(worktreePath);
				return "isolated";
			}
			// A real directory without the marker is user-owned. For a workspace
			// repo it is accepted only when it is already a complete boundary for
			// the current commit: every declared member must resolve from this
			// directory to a location inside this worktree. A partial tree lets
			// missing members resolve through an ancestor workspace — exactly the
			// contamination #4620 exists to stop — so an incomplete directory is
			// refused (never deleted) and the user is told to complete or remove it.
			const declaration = readWorkspaceDeclaration(worktreePath);
			if (declaration && !isCompleteResolutionBoundary(worktreePath, target, declaration)) {
				throw new Error(
					`worktree_node_modules_boundary_incomplete:${JSON.stringify(shortenPath(target))} — the worktree ` +
						"declares workspace packages that this directory does not resolve, so missing members would " +
						"resolve through an ancestor checkout. Run the package manager inside the worktree to complete " +
						"the install, or remove this directory and relaunch to let GJC create its boundary.",
				);
			}
			return "present";
		}
		// Neither directory nor symlink (file, socket, FIFO, ...): it cannot
		// hold `node_modules/<workspace-member>` entries, so for a workspace
		// repo resolution would walk up to an ancestor checkout. Refuse the
		// launch (never delete the user-owned entry) with remediation.
		const nonDirectoryDeclaration = readWorkspaceDeclaration(worktreePath);
		if (nonDirectoryDeclaration) {
			throw new Error(
				`worktree_node_modules_not_a_boundary:${JSON.stringify(shortenPath(target))} — the worktree declares ` +
					"workspace packages, but this entry is not a directory and cannot provide local resolution for " +
					"them, so imports would resolve through an ancestor checkout. Remove the entry and relaunch, or " +
					"replace it with a complete install.",
			);
		}
		return "present";
	}
	// The isolation decision is driven by the worktree's own workspace
	// declaration first, so an origin tree that merely happens to contain no
	// self-links never causes a workspace repo to be shared (#4620: external
	// hoists and partial installs encode ownership outside the link scan).
	const declaration = readWorkspaceDeclaration(worktreePath);
	const source = path.join(sourceRoot, "node_modules");
	if (declaration || !fs.existsSync(source) || nodeModulesLinksInto(source, sourceRoot)) {
		createWorkspaceSelfLinkBoundary(worktreePath);
		return "missing";
	}
	// A node_modules root symlinked outside the repo belongs to another
	// checkout's install graph (nested repo in a parent workspace); its entries
	// resolve that parent's live sources, so it is never shared either.
	const sourceStat = fs.lstatSync(source);
	if (sourceStat.isSymbolicLink()) {
		createWorkspaceSelfLinkBoundary(worktreePath);
		return "missing";
	}
	fs.symlinkSync(source, target, "junction");
	return "symlink";
}

/**
 * Creates or reconciles the worktree-local resolution boundary for workspace
 * packages (#4620).
 *
 * `ensureReusableNodeModules` refuses to share the source tree for workspace
 * repos, but refusal alone does not isolate resolution: launch worktrees are
 * siblings under the repository's parent, so when that parent (or any other
 * ancestor) carries its own `node_modules` — the nested-repo-in-parent-workspace
 * layout — Node/Bun resolution walks up and binds the worktree to the ancestor's
 * live workspace sources anyway. An empty `node_modules` directory does not stop
 * that walk-up; only entries in the worktree's own `node_modules` do.
 *
 * Every workspace member declared by the worktree's own root manifest —
 * `package.json` `workspaces` (array or `{packages}` object) or
 * `pnpm-workspace.yaml` — is linked into `worktree/node_modules/<name> ->
 * <worktree member>`, mirroring what a worktree-local install creates for the
 * workspace packages themselves: offline, deterministic, own-commit only.
 * Stale member links from a previous commit are pruned so reuse cannot resolve
 * deleted members through an ancestor tree. External dependencies are not
 * fabricated — the user's own install in the worktree is free to replace these
 * links and, once run, owns the directory (the marker file coexists harmlessly;
 * package managers ignore unknown dot-files).
 *
 * Fails closed: unreadable or malformed root/member manifests, workspace
 * patterns that traverse outside the worktree, member names outside the npm
 * grammar, and member or link paths escaping the worktree are isolation
 * failures, not silent skips.
 */
function createWorkspaceSelfLinkBoundary(worktreePath: string): void {
	const declaration = readWorkspaceDeclaration(worktreePath);
	const modules = path.join(worktreePath, "node_modules");
	const markerPath = path.join(modules, NODE_MODULES_OWNERSHIP_MARKER);
	// Both boundary metadata names must be plain regular files inside the
	// boundary before anything reads or writes through them.
	assertBoundaryMetadataFile(modules, markerPath, "worktree_boundary_marker_invalid");
	const markerOwned = fs.existsSync(markerPath);
	if (!declaration) {
		// No declaration at this commit: a marker-owned boundary from a previous
		// commit is stale and must be reconciled to the empty set; anything else
		// (user install, no boundary yet) is left alone.
		if (markerOwned) {
			const ownership = readBoundaryOwnership(modules);
			reconcileBoundaryLinks(modules, new Map(), ownership);
			writeBoundaryOwnership(modules, ownership);
			if (ownership.size === 0) {
				// Fully reconciled to empty: remove the marker so the directory is
				// no longer claimed by this launcher.
				fs.rmSync(markerPath, { force: true });
			}
		}
		return;
	}
	const { manifestFile } = declaration;
	const members = new Map<string, { manifestPath: string; dir: string }>();
	for (const manifestPath of scanWorkspaceMemberManifests(worktreePath, declaration)) {
		const member = readMemberManifest(manifestPath, manifestFile);
		if (!member.name) {
			throw new Error(
				`worktree_workspace_member_name_invalid:${JSON.stringify(shortenPath(manifestPath))} declared by ` +
					`${JSON.stringify(manifestFile)} — a selected member without a package name cannot be linked, ` +
					"so the isolation boundary cannot be proven complete.",
			);
		}
		if (!PACKAGE_NAME_PATTERN.test(member.name) || member.name.includes("\\")) {
			throw new Error(
				`worktree_workspace_member_name_invalid:${JSON.stringify(member.name)} in ${JSON.stringify(
					manifestFile,
				)} — package names must be scoped npm names without separators or traversal.`,
			);
		}
		const manifestDir = path.dirname(manifestPath);
		// The member directory itself must resolve inside the worktree: a
		// symlinked member pointing at another checkout must never become a
		// boundary target.
		assertCanonicalInside(worktreePath, manifestDir, "worktree_workspace_member_outside");
		const declared = members.get(member.name);
		if (declared === undefined || manifestPath.localeCompare(declared.manifestPath) < 0) {
			members.set(member.name, { manifestPath, dir: manifestDir });
		}
	}

	// A launcher boundary replaces a launcher boundary; it is never created over
	// a user-owned install (no marker).
	if (!markerOwned && fs.existsSync(modules)) return;
	fs.mkdirSync(modules, { recursive: true });
	const ownership = readBoundaryOwnership(modules);
	for (const [name, member] of members) {
		const linkPath = path.join(modules, ...name.split("/"));
		// Containment for a link destination is about the PATH inside node_modules
		// (the link's target legitimately lives elsewhere in the worktree).
		assertPathInside(modules, linkPath, "worktree_workspace_link_outside");
		fs.mkdirSync(path.dirname(linkPath), { recursive: true });
		// Replace only links this launcher recorded AND that still carry the
		// recorded identity; anything else at the path is user-owned (a
		// package-manager install replaced the tree) — keep it and skip managing
		// that entry.
		const recorded = ownership.get(name);
		if (recorded !== undefined) {
			if (!isRecordedLinkAtIdentity(linkPath, recorded)) {
				ownership.delete(name);
				continue;
			}
		} else if (tryLstat(linkPath)) continue;
		// Atomically install the new link: create at a process-unique temporary
		// name in the same directory, then rename(2) over the destination.
		// Rename replaces atomically, so a failure or interruption mid-flight
		// can never leave a missing member entry that the next launch would
		// silently accept as a complete marker-owned boundary (#4626 review:
		// marker-owned partial boundary). Same-directory placement keeps the
		// rename a same-filesystem operation.
		const tempPath = `${linkPath}.gjc-new-${process.pid}-${Date.now()}`;
		fs.symlinkSync(member.dir, tempPath, "junction");
		fs.renameSync(tempPath, linkPath);
		ownership.set(name, member.dir);
	}
	// Prune stale members and commit the SAME ownership map exactly once:
	// reconciling against a second map re-read from disk and then overwriting
	// it with this one re-records links that were just pruned, which makes an
	// A→B→A reuse refuse to recreate a missing member link and then fail the
	// completeness post-condition (#4626 review: split ownership maps).
	reconcileBoundaryLinks(modules, members, ownership);
	writeBoundaryOwnership(modules, ownership);
	if (!fs.existsSync(markerPath)) writeBoundaryMarker(markerPath);
	// Post-condition: the boundary we just reconciled must actually resolve
	// every declared member. A crash, ENOSPC, or interruption in any earlier
	// step could have left a marker-owned partial boundary; this launch would
	// otherwise report success while missing members resolve through an
	// ancestor checkout. Fail loudly instead of accepting the partial state.
	const completedDeclaration = readWorkspaceDeclaration(worktreePath);
	if (completedDeclaration && !isCompleteResolutionBoundary(worktreePath, modules, completedDeclaration)) {
		throw new Error(
			`worktree_boundary_incomplete_after_reconcile:${JSON.stringify(shortenPath(modules))} — the isolation ` +
				"boundary does not resolve every declared workspace member after reconciliation. The boundary state " +
				"may be damaged; remove the node_modules directory and relaunch.",
		);
	}
}
/**
 * Scans the worktree's workspace declarations and returns the absolute paths of
 * every member `package.json` they select.
 *
 * Each declaration source is evaluated independently with pnpm/npm ordered
 * semantics — patterns apply in declaration order, `!pattern` removes matches
 * selected so far in THAT declaration, and a later positive pattern
 * re-includes them — and the member set is the UNION of what every
 * declaration selects. A negation in one root manifest therefore cannot
 * exclude a member another root manifest positively selects.
 *
 * Traversal or absolute patterns are isolation failures, not silent skips.
 */
function scanWorkspaceMemberManifests(worktreePath: string, declaration: WorkspaceDeclaration): string[] {
	const selected = new Set<string>();
	for (const source of declaration.sources) {
		const sourceSelected = new Set<string>();
		for (const pattern of source.patterns) {
			const positive = pattern.startsWith("!") ? pattern.slice(1) : pattern;
			const glob = new Bun.Glob(path.posix.join(positive, "package.json"));
			if (pattern.startsWith("!")) {
				for (const match of sourceSelected) {
					if (glob.match(match)) sourceSelected.delete(match);
				}
				continue;
			}
			for (const match of glob.scanSync({ cwd: worktreePath, dot: false, onlyFiles: true })) {
				// Installed dependency manifests are never workspace members: a
				// recursive pattern (`packages/**`, `**`) would otherwise match
				// `node_modules/**/package.json` and link or reject installed
				// packages as if they were declared members (#4626 review).
				if (match.split("/").includes("node_modules")) continue;
				// The root manifest declares the workspace but is never a member
				// of it; recursive patterns (`**`) would otherwise select it.
				if (match === "package.json") continue;
				sourceSelected.add(match);
			}
		}
		for (const match of sourceSelected) selected.add(match);
	}
	return [...selected].map(match => path.join(worktreePath, match));
}

/**
 * True when `modules` already resolves every workspace member the worktree
 * declares at this commit, each to a location inside this worktree — i.e. the
 * directory is a complete resolution boundary and no member can fall through
 * to an ancestor checkout. The check proves where each entry RESOLVES, not how
 * it got there: a package-manager symlink to the worktree member, a hard copy
 * of the member, or a real install that happens to shadow the member all stop
 * the ancestor walk-up the same way. What can never count is a missing entry
 * or one resolving outside this worktree — those are exactly the fall-through
 * paths #4620 exists to close.
 */
function isCompleteResolutionBoundary(
	worktreePath: string,
	modules: string,
	declaration: WorkspaceDeclaration,
): boolean {
	const members = new Map<string, string>();
	for (const manifestPath of scanWorkspaceMemberManifests(worktreePath, declaration)) {
		const member = readMemberManifest(manifestPath, declaration.manifestFile);
		if (!member.name) return false;
		const declared = members.get(member.name);
		if (declared === undefined || manifestPath.localeCompare(declared) < 0) {
			members.set(member.name, manifestPath);
		}
	}
	const worktreeReal = tryRealpath(worktreePath);
	if (worktreeReal === null) return false;
	const modulesReal = tryRealpath(modules);
	if (modulesReal === null) return false;
	for (const name of members.keys()) {
		const entryPath = path.join(modules, ...name.split("/"));
		const resolved = tryRealpath(entryPath);
		if (resolved === null) return false;
		// Resolving to the worktree root itself, or into the boundary directory
		// being validated (a self-looping link), is not a member entry; a real
		// entry anywhere else inside the worktree shadows the ancestor walk-up.
		if (sameFileSystemPath(resolved, worktreeReal, worktreePath)) return false;
		if (sameFileSystemPath(resolved, modulesReal, worktreePath)) return false;
		if (!volumeMatchesCaseInsensitively(worktreePath) && !resolved.startsWith(`${worktreeReal}${path.sep}`)) {
			return false;
		}
		if (
			volumeMatchesCaseInsensitively(worktreePath) &&
			!resolved.toLowerCase().startsWith(`${worktreeReal.toLowerCase()}${path.sep}`)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Removes launcher-recorded member links that are no longer declared at this
 * commit. A recorded entry is removed when it is still a symlink carrying its
 * recorded identity, or when it is a symlink that resolves nowhere: the name is
 * launcher-recorded either way, and a dangling link holds no reachable user
 * data — but leaving it would shadow member resolution and block the link's
 * later recreation (A→B→A reuse). A package-manager install that replaced a
 * recorded entry leaves a different identity at the path, which is user-owned
 * and never touched.
 */
function reconcileBoundaryLinks(
	modules: string,
	members: Map<string, { manifestPath: string; dir: string }>,
	ownership: Map<string, string>,
): void {
	for (const name of [...ownership.keys()]) {
		if (members.has(name)) continue;
		const linkPath = path.join(modules, ...name.split("/"));
		const recorded = ownership.get(name);
		if (recorded !== undefined && isRecordedLinkAtIdentity(linkPath, recorded)) {
			fs.rmSync(linkPath, { force: true });
		} else {
			const stat = tryLstat(linkPath);
			if (stat?.isSymbolicLink() && tryRealpath(linkPath) === null) {
				fs.rmSync(linkPath, { force: true });
			}
		}
		ownership.delete(name);
	}
}

/**
 * Reads the per-link ownership manifest beside the boundary marker.
 *
 * Fails closed: a manifest that exists but is not a regular file inside the
 * boundary (a symlink lets a checkout redirect reconciliation reads and writes
 * to an arbitrary external path), cannot be read, or cannot be parsed as a
 * flat string→string record of valid package names authorizes nothing —
 * silently treating it as empty would let remediation delete links the
 * launcher cannot prove it owns, or preserve stale links it should have
 * pruned. An absent manifest (first creation) is legitimately empty.
 */
function readBoundaryOwnership(modules: string): Map<string, string> {
	const manifestPath = path.join(modules, NODE_MODULES_LINK_OWNERSHIP_MANIFEST);
	assertBoundaryMetadataFile(modules, manifestPath, "worktree_boundary_manifest_invalid");
	let raw: string;
	try {
		raw = fs.readFileSync(manifestPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw new Error(
			`worktree_boundary_manifest_unreadable:${JSON.stringify(shortenPath(manifestPath))} — link ownership ` +
				"cannot be proven, so the isolation boundary cannot be reconciled safely.",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			`worktree_boundary_manifest_invalid:${JSON.stringify(shortenPath(manifestPath))} — link ownership ` +
				"cannot be proven, so the isolation boundary cannot be reconciled safely.",
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`worktree_boundary_manifest_invalid:${JSON.stringify(shortenPath(manifestPath))} — link ownership ` +
				"cannot be proven, so the isolation boundary cannot be reconciled safely.",
		);
	}
	const map = new Map<string, string>();
	for (const [name, dir] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof dir !== "string" || !PACKAGE_NAME_PATTERN.test(name) || name.includes("\\")) {
			throw new Error(
				`worktree_boundary_manifest_invalid:${JSON.stringify(shortenPath(manifestPath))} — entry ` +
					`${JSON.stringify(name)} is not a recorded package link, so its ownership cannot be proven.`,
			);
		}
		map.set(name, dir);
	}
	return map;
}

/**
 * Positive identity proof for a recorded boundary link: the entry must be a
 * symlink whose recorded target directory still exists, and whose realpath
 * must still resolve to that recorded target's realpath. Anything else — a
 * replaced entry, a dangling link, an unreadable path — is not the launcher's
 * link and must never be replaced or removed on the manifest's say-so.
 */
function isRecordedLinkAtIdentity(linkPath: string, recordedTarget: string): boolean {
	const stat = tryLstat(linkPath);
	if (stat === null || !stat.isSymbolicLink()) return false;
	const targetReal = tryRealpath(linkPath);
	if (targetReal === null) return false;
	const recordedReal = tryRealpath(recordedTarget);
	if (recordedReal === null) return false;
	return sameFileSystemPath(targetReal, recordedReal, path.dirname(linkPath));
}
/** Process-unique suffix for same-directory temporary boundary metadata files. */
let boundaryTempCounter = 0;

/**
 * Atomically writes a boundary metadata file: an exclusively created
 * process-unique temporary regular file in the same directory, then
 * rename(2) over the destination. Rename does not follow a symlink at the
 * destination, so a swap between {@link assertBoundaryMetadataFile} and the
 * write cannot redirect the write outside the boundary, and concurrent
 * readers never observe truncated JSON (#4626 review: metadata write TOCTOU).
 */
function writeBoundaryMetadataAtomically(metadataPath: string, contents: string): void {
	const tempPath = `${metadataPath}.gjc-new-${process.pid}-${boundaryTempCounter++}`;
	fs.writeFileSync(tempPath, contents, { flag: "wx" });
	fs.renameSync(tempPath, metadataPath);
}

/** Writes the per-link ownership manifest beside the boundary marker. */
function writeBoundaryOwnership(modules: string, ownership: Map<string, string>): void {
	const manifestPath = path.join(modules, NODE_MODULES_LINK_OWNERSHIP_MANIFEST);
	assertBoundaryMetadataFile(modules, manifestPath, "worktree_boundary_manifest_invalid");
	const record: Record<string, string> = {};
	for (const [name, dir] of ownership) record[name] = dir;
	writeBoundaryMetadataAtomically(manifestPath, `${JSON.stringify(record, null, "\t")}\n`);
}

/** Writes the launcher-ownership marker beside the link manifest. */
function writeBoundaryMarker(markerPath: string): void {
	writeBoundaryMetadataAtomically(markerPath, `${new Date().toISOString()}\n`);
}

/**
 * Boundary metadata (ownership marker and link manifest) must be a regular
 * file lexically inside `modules` whose realpath also resolves inside
 * `modules`. A symlink at either name lets a checkout redirect the launcher's
 * metadata reads and writes to an arbitrary path outside the boundary —
 * including creating or overwriting an external file — so anything but a
 * plain regular file inside the boundary fails closed. An absent entry is
 * fine: it is about to be created.
 */
function assertBoundaryMetadataFile(modules: string, metadataPath: string, errorCode: string): void {
	// lstat (not existsSync) decides absence: a dangling symlink must be seen
	// as an obstruction, not as "will be created", or the write below would
	// create the external target.
	const stat = tryLstat(metadataPath);
	if (stat === null) return;
	if (!stat.isFile()) {
		throw new Error(
			`${errorCode}:${JSON.stringify(shortenPath(metadataPath))} — boundary metadata must be a regular file ` +
				"inside the launcher-owned node_modules, not a symlink or directory.",
		);
	}
	const modulesReal = tryRealpath(modules);
	const metadataReal = tryRealpath(metadataPath);
	if (modulesReal === null || metadataReal === null) {
		throw new Error(
			`${errorCode}:${JSON.stringify(shortenPath(metadataPath))} — boundary metadata identity cannot be ` +
				"resolved, so writes through it cannot be proven safe.",
		);
	}
	if (metadataReal !== modulesReal && !isInsideDirectoryReal(modulesReal, metadataReal)) {
		throw new Error(
			`${errorCode}:${JSON.stringify(shortenPath(metadataPath))} — boundary metadata resolves outside the ` +
				"launcher-owned node_modules and must not be read or written through.",
		);
	}
}

/**
 * Path-only containment for link destinations: the path must lexically sit
 * inside `dir` AND no parent component of it may be a symlink resolving
 * outside `dir` (the destination path itself need not exist yet).
 */
function assertPathInside(dir: string, candidate: string, errorCode: string): void {
	const relative = path.relative(path.resolve(dir), path.resolve(candidate));
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${errorCode}:${JSON.stringify(shortenPath(candidate))} — escapes the worktree boundary.`);
	}
	const dirReal = tryRealpath(dir);
	if (dirReal === null) return;
	const parentReal = tryRealpath(path.dirname(candidate));
	if (parentReal === null) return;
	if (parentReal !== dirReal && !isInsideDirectoryReal(dirReal, parentReal)) {
		throw new Error(
			`${errorCode}:${JSON.stringify(shortenPath(candidate))} — parent resolves outside the worktree boundary.`,
		);
	}
}

/**
 * Containment assertion that cannot be fooled by symlinked parents: the
 * canonical (realpath) identity of `candidate` must resolve inside the canonical
 * identity of `dir`. Symlinked or junctioned parents that lexically appear
 * inside but physically resolve outside are rejected.
 */
function assertCanonicalInside(dir: string, candidate: string, errorCode: string): void {
	const relativeLexical = path.relative(path.resolve(dir), path.resolve(candidate));
	const lexicallyInside =
		relativeLexical !== "" && !relativeLexical.startsWith("..") && !path.isAbsolute(relativeLexical);
	if (!lexicallyInside) {
		throw new Error(`${errorCode}:${JSON.stringify(shortenPath(candidate))} — escapes the worktree boundary.`);
	}
	const dirReal = tryRealpath(dir);
	const candidateReal = tryRealpath(candidate);
	if (dirReal !== null && candidateReal !== null) {
		if (!isInsideDirectoryReal(dirReal, candidateReal)) {
			throw new Error(
				`${errorCode}:${JSON.stringify(shortenPath(candidate))} — resolves outside the worktree boundary.`,
			);
		}
		return;
	}
	// Unresolvable candidate (not yet created): ensure no parent symlink carries
	// it outside.
	const parentReal = tryRealpath(path.dirname(candidate));
	if (parentReal !== null) {
		const dirRealFallback = dirReal ?? path.resolve(dir);
		if (
			!isInsideDirectoryReal(dirRealFallback, path.join(parentReal, path.basename(candidate))) &&
			parentReal !== dirRealFallback
		) {
			throw new Error(
				`${errorCode}:${JSON.stringify(shortenPath(candidate))} — parent resolves outside the worktree boundary.`,
			);
		}
	}
}

/** Realpath-strict variant of {@link isInsideDirectory}. */
function isInsideDirectoryReal(dirReal: string, candidateReal: string): boolean {
	if (candidateReal === dirReal) return false;
	const relative = path.relative(dirReal, candidateReal);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
/** A single workspace declaration source (root manifest file). */
interface WorkspaceDeclarationSource {
	patterns: string[];
	manifestFile: string;
}

/** The worktree root's authoritative workspace declarations. */
interface WorkspaceDeclaration {
	sources: WorkspaceDeclarationSource[];
	manifestFile: string;
}

/**
 * The worktree root's authoritative workspace declarations (#4620).
 *
 * `package.json` `workspaces` and `pnpm-workspace.yaml` are kept as separate
 * declarations on purpose: ordered negation semantics are per-declaration, so
 * merging their pattern lists into one sequence would let a `!pattern` in one
 * file exclude a member the other file positively selects. Members are the
 * UNION of what each declaration independently selects.
 *
 * Manifest presence is decided by `lstat`: a dangling symlink or other
 * non-regular entry at a manifest name is an obstruction, not an absent
 * declaration, because the boundary cannot be proven from a manifest that
 * cannot be read as a plain file.
 */
function readWorkspaceDeclaration(worktreePath: string): WorkspaceDeclaration | null {
	const packageJsonPath = path.join(worktreePath, "package.json");
	let packageJsonPatterns: string[] | null = null;
	const packageJsonStat = tryLstat(packageJsonPath);
	if (packageJsonStat !== null) {
		if (!packageJsonStat.isFile()) {
			throw new Error(
				`worktree_workspace_manifest_unreadable:${JSON.stringify(shortenPath(packageJsonPath))} — the ` +
					"isolation boundary cannot be built from a manifest that is not a regular file.",
			);
		}
		try {
			const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
			packageJsonPatterns = extractPatternList(manifest.workspaces, "package.json");
		} catch (error) {
			// Isolation-contract errors (invalid declarations) propagate; only a
			// vanished file (ENOENT from the race between lstat and read) is
			// tolerated as an absent declaration.
			if (!(error instanceof Error) || !/worktree_workspace_(manifest|pattern)_/.test(error.message)) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw new Error(
						`worktree_workspace_manifest_unreadable:${JSON.stringify(shortenPath(packageJsonPath))} — the ` +
							"isolation boundary cannot be built from an unreadable manifest.",
					);
				}
			} else {
				throw error;
			}
		}
	}
	const pnpmPath = path.join(worktreePath, "pnpm-workspace.yaml");
	let pnpmPatterns: string[] | null = null;
	const pnpmStat = tryLstat(pnpmPath);
	if (pnpmStat !== null) {
		if (!pnpmStat.isFile()) {
			throw new Error(
				`worktree_workspace_manifest_unreadable:${JSON.stringify(shortenPath(pnpmPath))} — the isolation ` +
					"boundary cannot be built from a manifest that is not a regular file.",
			);
		}
		try {
			const parsed = Bun.YAML.parse(fs.readFileSync(pnpmPath, "utf8")) as { packages?: unknown } | null;
			pnpmPatterns = extractPatternList(parsed?.packages, "pnpm-workspace.yaml");
		} catch (error) {
			// Isolation-contract errors (invalid declarations) propagate.
			if (!(error instanceof Error) || !/worktree_workspace_(manifest|pattern)_/.test(error.message)) {
				throw new Error(
					`worktree_workspace_manifest_unreadable:${JSON.stringify(shortenPath(pnpmPath))} — the isolation ` +
						"boundary cannot be built from a malformed manifest.",
				);
			}
			throw error;
		}
	}
	const sources: Array<{ patterns: string[]; manifestFile: string }> = [];
	if (packageJsonPatterns !== null) sources.push({ patterns: packageJsonPatterns, manifestFile: "package.json" });
	if (pnpmPatterns !== null) sources.push({ patterns: pnpmPatterns, manifestFile: "pnpm-workspace.yaml" });
	if (sources.length === 0) return null;
	const manifestFile =
		sources.length === 2 ? "package.json+pnpm-workspace.yaml" : (sources[0]?.manifestFile ?? "package.json");
	return { sources, manifestFile };
}

/** Strictly extracts a string list of workspace patterns; anything else is an isolation failure. */
function extractPatternList(value: unknown, declaringFile: string): string[] | null {
	if (value === undefined || value === null) return null;
	const patterns = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? (value as { packages?: unknown }).packages
			: null;
	if (!Array.isArray(patterns)) {
		throw new Error(
			`worktree_workspace_manifest_invalid:${JSON.stringify(value)} in ${JSON.stringify(declaringFile)} — ` +
				"workspace declarations must be an array of patterns or a { packages: [...] } object.",
		);
	}
	const parsed: string[] = [];
	for (const entry of patterns) {
		if (typeof entry !== "string" || entry.length === 0) {
			throw new Error(
				`worktree_workspace_pattern_invalid:${JSON.stringify(entry)} in ${JSON.stringify(declaringFile)} — ` +
					"workspace patterns must be non-empty strings.",
			);
		}
		// The negated body must itself be a confined pattern: validating only
		// the raw entry would let "!/../escape" pass the traversal check.
		const body = entry.startsWith("!") ? entry.slice(1) : entry;
		if (body === "" || !isConfinedWorkspacePattern(body)) {
			throw new Error(
				`worktree_workspace_pattern_invalid:${JSON.stringify(entry)} in ${JSON.stringify(declaringFile)} — ` +
					"absolute paths and traversal segments cannot be used for the isolation boundary.",
			);
		}
		parsed.push(entry);
	}
	return parsed;
}

/** Reads a member manifest, failing closed when it exists but cannot be parsed. */
function readMemberManifest(manifestPath: string, declaringFile: string): { name?: string } {
	let raw: string;
	try {
		raw = fs.readFileSync(manifestPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			`worktree_workspace_member_unreadable:${JSON.stringify(shortenPath(manifestPath))} declared by ` +
				`${JSON.stringify(declaringFile)} — the isolation boundary cannot skip an unreadable member.`,
		);
	}
	try {
		return JSON.parse(raw) as { name?: string };
	} catch {
		throw new Error(
			`worktree_workspace_member_invalid:${JSON.stringify(shortenPath(manifestPath))} declared by ` +
				`${JSON.stringify(declaringFile)} — the isolation boundary cannot skip a malformed member manifest.`,
		);
	}
}

/** True when a workspace glob pattern stays inside the worktree (no absolute or traversal segments). */
function isConfinedWorkspacePattern(pattern: string): boolean {
	if (pattern === "" || path.isAbsolute(pattern)) return false;
	return !pattern.split(/[/\\]+/).includes("..");
}

/**
 * Positive-proof check for launcher-created links: true only when the link's
 * target is the source checkout's own `node_modules`.
 */
function positivelyResolvesToSourceModules(target: string, sourceRoot: string): boolean {
	let resolvedTarget: string;
	let resolvedSourceModules: string;
	try {
		resolvedTarget = fs.realpathSync(target);
		resolvedSourceModules = fs.realpathSync(path.join(sourceRoot, "node_modules"));
	} catch {
		return false;
	}
	return sameFileSystemPath(resolvedTarget, resolvedSourceModules, sourceRoot);
}

/**
 * Path-equality probe cache: whether paths on the volume holding `probeRoot`
 * match case-insensitively, measured rather than assumed per-platform.
 *
 * Darwin ships both case-insensitive (default APFS/HFS+) and case-sensitive
 * (APFS case-sensitive) volumes; treating the whole platform as one behavior
 * lets a case-sensitive volume's distinct paths collide under `toLowerCase`,
 * which could make an ownership check accept or delete the wrong target. The
 * probe creates two entries differing only by case inside `probeRoot`; if the
 * second creation collides the volume folds case. Windows volumes are
 * case-insensitive by construction and the probe confirms that. The result is
 * cached per probe root.
 */
const caseFoldProbeCache = new Map<string, boolean>();

function volumeMatchesCaseInsensitively(probeRoot: string): boolean {
	const cached = caseFoldProbeCache.get(probeRoot);
	if (cached !== undefined) return cached;
	let folds = false;
	// The probe runs inside a unique launcher-owned temporary directory:
	// probing fixed names directly under the checkout would race parallel
	// launches against each other, and the recursive cleanup could delete
	// user-owned entries that happen to sit at the probe names (#4626 review:
	// destructive fixed-path probe). Only this freshly created directory is
	// ever removed.
	let probeDir: string | null = null;
	try {
		probeDir = fs.mkdtempSync(path.join(probeRoot, ".gjc-case-probe-"));
		const probeA = path.join(probeDir, "a");
		const probeB = path.join(probeDir, "A");
		fs.mkdirSync(probeA);
		try {
			fs.mkdirSync(probeB);
			// Both spellings coexist: the volume distinguishes case.
			folds = false;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			// The case-variant collided with the first probe entry.
			folds = code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "EPERM";
		}
	} catch {
		// The probe itself cannot run (read-only root, permission denied):
		// assume folding, the conservative direction for identity checks that
		// may otherwise treat a same-volume alias as unrelated and delete or
		// share the wrong tree.
		folds = true;
	} finally {
		if (probeDir !== null) fs.rmSync(probeDir, { force: true, recursive: true });
	}
	caseFoldProbeCache.set(probeRoot, folds);
	return folds;
}

/**
 * Case-insensitive path equality on the volume holding `reference`, so an
 * alias-spelled or differently-cased identity is still recognized as the same
 * physical path instead of being classified as unrelated — but only when that
 * volume actually folds case.
 */
function sameFileSystemPath(a: string, b: string, reference: string): boolean {
	if (a === b) return true;
	return volumeMatchesCaseInsensitively(reference) && a.toLowerCase() === b.toLowerCase();
}
/**
 * `lstat` that returns null only for a path that provably does not exist
 * (ENOENT). Every other failure — EACCES, EIO, ENOTDIR, ELOOP, ... — means the
 * launcher cannot prove what occupies the path, and propagates: reading
 * "unreadable" as "absent" would route boundary decisions down paths that
 * bypass the isolation contract (#4626 review: a permission error on the root
 * workspace manifest silently disabled declaration-driven isolation).
 */
function tryLstat(target: string): fs.Stats | null {
	try {
		return fs.lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** `realpath` that returns null instead of throwing when resolution fails. */
function tryRealpath(target: string): string | null {
	try {
		return fs.realpathSync(target);
	} catch {
		return null;
	}
}

/** Result of {@link prepareLaunchWorktree}: the effective working directory, remaining args, and resolved worktree plan. */
export interface PreparedLaunchWorktree {
	cwd: string;
	args: string[];
	worktree: GjcLaunchWorktreeResult | { enabled: false };
}

export function prepareLaunchWorktree(cwd: string, args: string[]): PreparedLaunchWorktree {
	const parsed = parseLaunchWorktreeMode(args);
	const planned = planLaunchWorktree(cwd, parsed.mode);
	const ensured = ensureLaunchWorktree(planned);
	if (!ensured.enabled) return { cwd, args: parsed.remainingArgs, worktree: ensured };
	ensureReusableNodeModules(ensured.repoRoot, ensured.worktreePath);
	return { cwd: ensured.worktreePath, args: parsed.remainingArgs, worktree: ensured };
}
