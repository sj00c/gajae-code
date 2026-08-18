import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("move_session tool (agent-invokable session rescope)", () => {
	const tempDirs: string[] = [];
	// The accessor's setProjectDir() chdirs the process into the moved
	// directory; tests must restore the original cwd before their temp roots
	// are deleted, or every later shell init in this process fails with a
	// dead getcwd (matches the real /move semantics: the process follows).
	const processCwdAtStart = process.cwd();

	afterEach(() => {
		if (process.cwd() !== processCwdAtStart) {
			process.chdir(processCwdAtStart);
		}
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function makeSession(cwd: string, sessionManager: SessionManager, overrides: Record<string, unknown> = {}) {
		return createAgentSession({
			cwd,
			agentDir: path.dirname(cwd),
			sessionManager,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			...overrides,
		});
	}

	it("exposes move_session in a top-level session and moves tool cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(tempDir, "root", "repo-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			expect(session.getToolByName("move_session")).toBeDefined();
			expect(sessionManager.getCwd()).toBe(cwdA);

			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-1", { path: cwdB });

			expect(textContent(result)).toContain(cwdB);
			expect(sessionManager.getCwd()).toBe(cwdB);

			// The bash tool's default cwd follows the move, like /move.
			const bashTool = session.getToolByName("bash")!;
			const pwd = await bashTool.execute("pwd-after-move-session", { command: "pwd" });
			expect(textContent(pwd)).toContain(cwdB);
		} finally {
			await session.dispose();
		}
	});

	it("resolves a relative target against the current session cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-2", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(repoB);
			const details = (result as { details?: { from?: string; to?: string } }).details ?? {};
			expect(details.from).toBe(cwdA);
			expect(details.to).toBe(repoB);
		} finally {
			await session.dispose();
		}
	});

	it("rejects a missing directory instead of moving", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const missing = path.join(tempDir, "does-not-exist");
			let error: unknown;
			try {
				await moveTool.execute("move-3", { path: missing });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain(missing);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("does not expose move_session in subagent sessions (taskDepth > 0)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			taskDepth: 1,
			currentAgentType: "executor",
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not expose move_session under a read-only bash restriction profile", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			bashRestrictionProfile: "read-only",
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("refuses to rescope outside the current session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const outside = path.join(tempDir, "sibling");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			for (const target of [outside, "..", path.dirname(cwdA), "/"]) {
				let error: unknown;
				try {
					await moveTool.execute(`move-outside-${target}`, { path: target });
				} catch (err) {
					error = err;
				}
				expect(error, `target ${target} must be refused`).toBeDefined();
				expect(String((error as Error)?.message ?? error)).toContain("only narrows");
				expect(sessionManager.getCwd()).toBe(cwdA);
			}
			// A refused move does not consume the one-move bound.
			const repoB = path.join(cwdA, "repo-b");
			fs.mkdirSync(repoB, { recursive: true });
			const result = await moveTool.execute("move-after-refusals", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			expect(textContent(result)).toContain("repo-b");
		} finally {
			await session.dispose();
		}
	});

	it("rejects moving to the current directory itself", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			let error: unknown;
			try {
				await moveTool.execute("move-self", { path: "." });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("nothing to move");
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("allows only one successful move per session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		const deeper = path.join(cwdA, "repo-b", "pkg");
		fs.mkdirSync(deeper, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-first", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));

			let error: unknown;
			try {
				await moveTool.execute("move-second", { path: "pkg" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("only one agent-invoked move");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
		}
	});

	it("canonicalizes a symlinked target to its realpath", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const realRepo = path.join(cwdA, "real-repo");
		const link = path.join(cwdA, "link-repo");
		fs.mkdirSync(realRepo, { recursive: true });
		fs.symlinkSync(realRepo, link);

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-symlink", { path: "link-repo" });
			const canonical = fs.realpathSync(realRepo);
			expect(sessionManager.getCwd()).toBe(canonical);
			const details = (result as { details?: { to?: string } }).details ?? {};
			expect(details.to).toBe(canonical);
		} finally {
			await session.dispose();
		}
	});

	it("accepts a child literally named with leading dots (not a parent escape)", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const dotted = path.join(cwdA, "..dots");
		fs.mkdirSync(dotted, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-dotted-child", { path: "..dots" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(dotted));
			expect(textContent(result)).toContain("..dots");
		} finally {
			await session.dispose();
		}
	});
});
