/**
 * Regression for the Windows `bun install -g` update path: when a `gjc`
 * process is running, bun cannot overwrite a locked
 * `node_modules/@gajae-code/natives/native/pi_natives.win32-x64.node` during
 * package update and silently keeps the old binary next to the new ESM
 * wrapper. The next launch then throws `<sym> is not a function` deep inside
 * tool execution (see Discord report, 2026-05-14).
 *
 * The fix has two halves, both pinned by this test:
 *   1. The loader stages `nativeDir/<filename>.node` → `versionedDir/<filename>.node`
 *      (per-package-version cache under `~/.gjc/natives/<version>/`) so the
 *      running process holds its OS-level handle on a path bun is never asked
 *      to overwrite. Gated to Windows + node_modules installs + non-compiled
 *      mode by `shouldStageNodeModulesAddon`.
 *   2. `resolveLoaderCandidates` puts the staged path ahead of the
 *      `node_modules` path so subsequent updates land in node_modules without
 *      contention.
 *
 * Both behaviors are off in workspace dev (`bun --cwd=packages/natives run
 * build`) and on non-Windows so the regular path is unchanged.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAddonFilenames,
	loadNative,
	maybeStageNodeModulesAddon,
	resolveLoaderCandidates,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@gajae-code\\pi-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\gajae-code\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@gajae-code/natives/native";

describe("windows native addon staging", () => {
	it("stages only on Windows node_modules installs", () => {
		// Windows + node_modules install + npm (not compiled) → stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);

		// Windows workspace dev: nativeDir lives outside node_modules → never stage,
		// otherwise rebuilds via `bun --cwd=packages/natives run build` would be
		// shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);

		// Windows compiled binary: the embedded-addon extractor already populates
		// versionedDir; staging from a non-existent nativeDir would race that.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);

		// Non-Windows: bun's atomic rename works fine, no need to stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "darwin",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("prepends versionedDir candidates ahead of node_modules when staging on Windows", () => {
		const versionedDir = "C:\\Users\\Admin\\.gjc\\natives\\15.0.1";
		const userDataDir = "C:\\Users\\Admin\\AppData\\Local\\gjc";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir,
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.win32-x64-baseline.node");
		const versionedDefault = path.join(versionedDir, "pi_natives.win32-x64.node");
		const nodeModulesBaseline = path.join(winNodeModulesNativeDir, "pi_natives.win32-x64-baseline.node");

		// Staged paths must be probed first so the running process locks the cache
		// copy and bun is free to replace the node_modules copy on next update.
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(versionedDefault);
		expect(candidates.indexOf(versionedBaseline)).toBeLessThan(candidates.indexOf(nodeModulesBaseline));

		// User-data dir is reserved for compiled-binary mode — staging must not
		// quietly start probing it on npm installs (where it never contains the
		// addon anyway).
		const userDataBaseline = path.join(userDataDir, "pi_natives.win32-x64-baseline.node");
		expect(candidates).not.toContain(userDataBaseline);
	});

	it("falls back to the node_modules-only candidate list when staging is off", () => {
		// Mirrors the non-Windows / workspace-dev path: same behavior as before
		// the staging feature was introduced.
		const versionedDir = "/home/u/.gjc/natives/15.0.1";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: false,
			nativeDir: posixNodeModulesNativeDir,
			execDir: "/usr/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});

		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const nodeModulesBaseline = path.join(posixNodeModulesNativeDir, "pi_natives.linux-x64-baseline.node");
		expect(candidates).not.toContain(versionedBaseline);
		expect(candidates).toContain(nodeModulesBaseline);
	});

	it("does not reuse a staged addon whose bytes drifted from the package artifact", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-drift-"));
		const nativeDir = path.join(root, "native");
		const versionedDir = path.join(root, "versioned");
		const filename = "pi_natives.win32-x64.node";
		await fs.mkdir(nativeDir, { recursive: true });
		await fs.mkdir(versionedDir, { recursive: true });
		await fs.writeFile(path.join(nativeDir, filename), "new-addon");
		await fs.writeFile(path.join(versionedDir, filename), "old-addon");
		try {
			const errors: string[] = [];
			const staged = maybeStageNodeModulesAddon(
				{
					isCompiledBinary: false,
					platformTag: "win32-x64",
					stageFromNodeModules: true,
					versionedDir,
					addonFilenames: [filename],
					optionalPackageNativeDirs: [],
					nativeDir,
				},
				errors,
			);
			expect(staged).toBeString();
			expect(staged).not.toBe(path.join(versionedDir, filename));
			expect(staged).not.toContain(nativeDir);
			expect(await fs.readFile(staged as string, "utf8")).toBe("new-addon");
			expect(errors).toEqual([expect.stringContaining("staged addon drift")]);
			await fs.rm(path.join(nativeDir, filename));
			const orphanErrors: string[] = [];
			expect(
				maybeStageNodeModulesAddon(
					{
						isCompiledBinary: false,
						platformTag: "win32-x64",
						stageFromNodeModules: true,
						versionedDir,
						addonFilenames: [filename],
						optionalPackageNativeDirs: [],
						nativeDir,
					},
					orphanErrors,
				),
			).toBeNull();
			expect(orphanErrors).toEqual([expect.stringContaining("staged addon orphan")]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("removes drifted staged candidates before native loading", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-stage-load-"));
		const nativeDir = path.join(root, "native");
		const versionedDir = path.join(root, "versioned");
		const filename = "pi_natives.win32-x64.node";
		const stagedPath = path.join(versionedDir, filename);
		const sourcePath = path.join(nativeDir, filename);
		await fs.mkdir(nativeDir, { recursive: true });
		await fs.mkdir(versionedDir, { recursive: true });
		await fs.writeFile(sourcePath, "new-addon");
		await fs.writeFile(stagedPath, "old-addon");
		try {
			const loadSelected = () => {
				const attempted: string[] = [];
				const bindings = loadNative({
					context: {
						isCompiledBinary: false,
						stageFromNodeModules: true,
						platformTag: "win32-x64",
						packageVersion: "test",
						selectedVariant: "baseline",
						versionedDir,
						nativeDir,
						optionalPackageNativeDirs: [],
						addonFilenames: [filename],
						candidates: [stagedPath, sourcePath],
					},
					extractEmbeddedAddons: () => [],
					stageNodeModulesAddon: (ctx, stageErrors) => maybeStageNodeModulesAddon(ctx, stageErrors),
					requireCandidate: candidate => {
						attempted.push(candidate);
						if (candidate === stagedPath || candidate === sourcePath) {
							throw new Error("stale node_modules candidate should not be loaded");
						}
						return { selected: candidate };
					},
					validateCandidate: () => undefined,
				});
				return { bindings, attempted };
			};

			const first = loadSelected();
			expect(first.attempted).toHaveLength(1);
			expect(first.attempted[0]).not.toBe(sourcePath);
			expect(first.attempted[0]).not.toBe(stagedPath);
			expect(first.attempted[0]).not.toContain(nativeDir);
			expect(await fs.readFile(first.attempted[0], "utf8")).toBe("new-addon");

			await fs.writeFile(sourcePath, "newer-addon");
			const second = loadSelected();
			expect(second.attempted).toHaveLength(1);
			expect(second.attempted[0]).not.toBe(first.attempted[0]);
			expect(second.attempted[0]).not.toBe(sourcePath);
			expect(await fs.readFile(second.attempted[0], "utf8")).toBe("newer-addon");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("pi-natives version sentinel", () => {
	it("Rust `js_name` matches the package version", async () => {
		// The JS loader (`packages/natives/native/index.js`) computes its expected
		// sentinel from `package.json#version`; if the Rust source falls out of
		// sync we ship a `.node` that the loader will refuse to use. Pinning the
		// pairing here catches release-script regressions before they reach CI.
		const libRs = await Bun.file(path.join(import.meta.dir, "../../../crates/pi-natives/src/lib.rs")).text();
		const sentinelMatch = libRs.match(/js_name = "(__piNativesV[A-Za-z0-9_]+)"/);
		expect(sentinelMatch, 'Rust sentinel `js_name = "__piNativesV…"` not found in lib.rs').not.toBeNull();
		const expected = `__piNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`;
		expect(sentinelMatch?.[1]).toBe(expected);
	});
});
