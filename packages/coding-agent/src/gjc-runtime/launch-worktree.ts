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
 * Fails closed: a link whose target cannot be resolved for any reason other
 * than the link being broken is treated as self-linked, because an unreadable
 * link can never be proven safe to share.
 */
export function nodeModulesLinksInto(nodeModulesPath: string, sourceRoot: string): boolean {
	const sourceReal = fs.realpathSync(sourceRoot);
	// The node_modules root itself may be a symlink (some setups point it at a
	// vendored directory inside the repo); its own resolution is checked first.
	if (resolvesInside(fs.lstatSync(nodeModulesPath), nodeModulesPath, sourceReal)) return true;
	const stack: Array<{ dir: string; depth: number }> = [{ dir: nodeModulesPath, depth: 0 }];
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
			if (resolvesInside(entry, entryPath, sourceReal)) return true;
			if (entry.isDirectory() && depth + 1 < NODE_MODULES_SCAN_DEPTH) {
				stack.push({ dir: entryPath, depth: depth + 1 });
			}
		}
	}
	return false;
}

/**
 * Returns true when `entry` is a symlink whose target provably resolves inside
 * `sourceReal`, or whose resolution fails in a way that cannot rule that out.
 * A symlink whose target resolves to nowhere (broken or looping) resolves
 * nowhere and cannot pull origin sources in.
 */
function resolvesInside(entry: fs.Stats | fs.Dirent, entryPath: string, sourceReal: string): boolean {
	if (!entry.isSymbolicLink()) return false;
	let target: string;
	try {
		target = fs.realpathSync(entryPath);
	} catch (error) {
		return !BROKEN_LINK_CODES.has((error as NodeJS.ErrnoException).code ?? "");
	}
	return (
		sameFileSystemPath(target, sourceReal) ||
		(caseInsensitiveFs() && target.toLowerCase().startsWith(`${sourceReal.toLowerCase()}${path.sep}`)) ||
		target.startsWith(`${sourceReal}${path.sep}`)
	);
}

/**
 * Marker file inside a launcher-owned worktree `node_modules` boundary recording
 * that this launcher created the directory (#4620). Only directories carrying
 * this marker are reconciled or removed by remediation; everything else is
 * user-owned and never touched.
 */
const NODE_MODULES_OWNERSHIP_MARKER = ".gjc-node-modules-boundary";

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
	const target = path.join(worktreePath, "node_modules");
	const targetStat = tryLstat(target);
	if (targetStat) {
		if (targetStat.isSymbolicLink()) {
			// existsSync follows the link; a dangling link reports false but still
			// occupies the name, so it is handled here rather than below.
			const provenDangling = isProvenDangling(target);
			if (!provenDangling && positivelyResolvesToSourceModules(target, sourceRoot)) {
				fs.rmSync(target, { force: true });
				createWorkspaceSelfLinkBoundary(worktreePath);
				return "isolated";
			}
			if (provenDangling) {
				// A dangling link resolves nowhere: it can no longer pull origin
				// sources, but it also provides no boundary. Replace it with the
				// launcher-owned boundary so ancestor walk-up stays sealed.
				fs.rmSync(target, { force: true });
				createWorkspaceSelfLinkBoundary(worktreePath);
				return "isolated";
			}
			// A link whose resolution provably lands outside both the source
			// checkout's node_modules and every broken-link outcome is a
			// user-owned external store: provably not source-coupled, so it is
			// kept and reported present.
			const resolved = tryRealpath(target);
			if (resolved !== null) {
				const sourceModules = tryRealpath(path.join(sourceRoot, "node_modules"));
				if (sourceModules !== null && !sameFileSystemPath(resolved, sourceModules)) {
					return "present";
				}
			}
			// Unresolvable (EACCES/EPERM/EIO/...) or otherwise unproven: refuse
			// to launch through an unverified dependency boundary.
			throw new Error(
				`worktree_node_modules_unverified:${JSON.stringify(shortenPath(target))} — GJC cannot prove this ` +
					"node_modules link is safe to reuse or remove. Remove it manually or point it at the source " +
					"checkout's own node_modules, then relaunch.",
			);
		}
		if (targetStat.isDirectory()) {
			const marker = path.join(target, NODE_MODULES_OWNERSHIP_MARKER);
			if (fs.existsSync(marker)) {
				// Launcher-owned: reconcile against the current commit's members.
				createWorkspaceSelfLinkBoundary(worktreePath);
				return "isolated";
			}
			// A real directory without the marker is user-owned (a real install,
			// a store, or anything else): leave it completely untouched.
			return "present";
		}
		// Neither directory nor symlink (file, socket, ...): user-owned.
		return "present";
	}
	const source = path.join(sourceRoot, "node_modules");
	if (!fs.existsSync(source) || nodeModulesLinksInto(source, sourceRoot)) {
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

/** True when `target` is a symlink whose resolution provably fails because it is broken. */
function isProvenDangling(target: string): boolean {
	try {
		fs.realpathSync(target);
		return false;
	} catch (error) {
		return BROKEN_LINK_CODES.has((error as NodeJS.ErrnoException).code ?? "");
	}
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
	// A repo with no workspace declaration has no members to link and no
	// boundary to build; isolation from the source tree is already complete.
	if (!declaration) return;
	const { patterns, manifestFile } = declaration;

	const members: Array<{ name: string; dir: string }> = [];
	for (const pattern of patterns) {
		if (!isConfinedWorkspacePattern(pattern)) {
			throw new Error(
				`worktree_workspace_pattern_unsafe:${JSON.stringify(pattern)} in ${JSON.stringify(manifestFile)} — ` +
					"absolute paths and traversal segments cannot be used for the isolation boundary.",
			);
		}
		for (const match of new Bun.Glob(path.posix.join(pattern, "package.json")).scanSync({
			cwd: worktreePath,
			dot: false,
			onlyFiles: true,
		})) {
			const manifestPath = path.join(worktreePath, match);
			if (!isInsideDirectory(worktreePath, manifestPath)) {
				throw new Error(
					`worktree_workspace_member_outside:${JSON.stringify(shortenPath(manifestPath))} — the isolation ` +
						"boundary can only link members inside the worktree.",
				);
			}
			const member = readMemberManifest(manifestPath, manifestFile);
			if (!member.name) continue;
			if (!PACKAGE_NAME_PATTERN.test(member.name) || member.name.includes("\\")) {
				throw new Error(
					`worktree_workspace_member_name_invalid:${JSON.stringify(member.name)} in ${JSON.stringify(
						manifestFile,
					)} — package names must be scoped npm names without separators or traversal.`,
				);
			}
			members.push({ name: member.name, dir: path.dirname(manifestPath) });
		}
	}

	const modules = path.join(worktreePath, "node_modules");
	fs.mkdirSync(modules, { recursive: true });
	const markerPath = path.join(modules, NODE_MODULES_OWNERSHIP_MARKER);
	const expectedLinks = new Set(members.map(member => member.name));
	for (const member of members) {
		const linkPath = path.join(modules, ...member.name.split("/"));
		if (!isInsideDirectory(modules, linkPath)) {
			throw new Error(
				`worktree_workspace_link_outside:${JSON.stringify(shortenPath(linkPath))} — boundary links must stay ` +
					"inside the worktree node_modules.",
			);
		}
		fs.mkdirSync(path.dirname(linkPath), { recursive: true });
		const existing = tryLstat(linkPath);
		if (existing?.isSymbolicLink()) {
			// Replace stale links (previous commit's members) with current ones.
			fs.rmSync(linkPath, { force: true });
		}
		if (!tryLstat(linkPath)) fs.symlinkSync(member.dir, linkPath, "junction");
	}
	pruneStaleBoundaryLinks(modules, expectedLinks);
	if (!fs.existsSync(markerPath)) fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
}

/**
 * Removes launcher-created member links that are no longer declared at this
 * commit, so a reused worktree cannot resolve deleted members through an
 * ancestor `node_modules`. Only symlinks (this launcher never creates real
 * entries) are considered; real files/directories are user-owned and kept.
 */
function pruneStaleBoundaryLinks(modules: string, expectedLinks: Set<string>): void {
	for (const scope of fs.readdirSync(modules, { withFileTypes: true })) {
		if (!scope.isDirectory() || scope.name === ".bin" || scope.name.startsWith(".")) continue;
		const scopePath = path.join(modules, scope.name);
		if (scope.name.startsWith("@")) {
			for (const entry of fs.readdirSync(scopePath, { withFileTypes: true })) {
				const fullName = `${scope.name}/${entry.name}`;
				if (entry.isSymbolicLink() && !expectedLinks.has(fullName)) {
					fs.rmSync(path.join(scopePath, entry.name), { force: true });
				}
			}
		} else if (tryLstat(scopePath)?.isSymbolicLink() && !expectedLinks.has(scope.name)) {
			fs.rmSync(scopePath, { force: true });
		}
	}
}

/** Reads the authoritative workspace declaration for the worktree root. */
function readWorkspaceDeclaration(worktreePath: string): { patterns: string[]; manifestFile: string } | null {
	const packageJsonPath = path.join(worktreePath, "package.json");
	interface WorkspaceManifest {
		workspaces?: string[] | { packages?: string[] };
	}
	try {
		const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as WorkspaceManifest;
		const rawPatterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
		if (Array.isArray(rawPatterns) && rawPatterns.length > 0) {
			return { patterns: rawPatterns.map(String), manifestFile: "package.json" };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(
				`worktree_workspace_manifest_unreadable:${JSON.stringify(shortenPath(packageJsonPath))} — the ` +
					"isolation boundary cannot be built from an unreadable manifest.",
			);
		}
	}
	const pnpmPath = path.join(worktreePath, "pnpm-workspace.yaml");
	if (fs.existsSync(pnpmPath)) {
		try {
			const parsed = Bun.YAML.parse(fs.readFileSync(pnpmPath, "utf8")) as { packages?: unknown } | null;
			const rawPatterns = parsed?.packages;
			if (Array.isArray(rawPatterns) && rawPatterns.length > 0) {
				return { patterns: rawPatterns.map(String), manifestFile: "pnpm-workspace.yaml" };
			}
		} catch {
			throw new Error(
				`worktree_workspace_manifest_unreadable:${JSON.stringify(shortenPath(pnpmPath))} — the isolation ` +
					"boundary cannot be built from a malformed manifest.",
			);
		}
	}
	return null;
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

/** True when `candidate` resolves strictly inside `dir`. */
function isInsideDirectory(dir: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(dir), path.resolve(candidate));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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
	return sameFileSystemPath(resolvedTarget, resolvedSourceModules);
}

/**
 * Case-insensitive path equality on platforms whose filesystems match that way,
 * so an alias-spelled or differently-cased identity is still recognized as the
 * same physical path instead of being classified as unrelated.
 */
function sameFileSystemPath(a: string, b: string): boolean {
	if (a === b) return true;
	return caseInsensitiveFs() && a.toLowerCase() === b.toLowerCase();
}

/**
 * True on platforms whose filesystems match paths case-insensitively, where the
 * same physical path can be returned with different casing or alias spelling.
 */
function caseInsensitiveFs(): boolean {
	return process.platform === "win32" || process.platform === "darwin";
}
/** `lstat` that returns null instead of throwing for a missing path. */
function tryLstat(target: string): fs.Stats | null {
	try {
		return fs.lstatSync(target);
	} catch {
		return null;
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
