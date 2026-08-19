import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import { syncSkillActiveState } from "../src/skill-state/active-state";
import { moveSessionToolRenderer } from "../src/tools/move-session";

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
	}, 20_000);
	it("lets a sequential fenced bash call follow a completed move", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const cwdB = path.join(cwdA, "repo-b");
		fs.mkdirSync(cwdB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-then-bash", { path: "repo-b" });
			const bashTool = session.getToolForExecution("bash")!;
			const pwd = await bashTool.execute("pwd-after-fenced-move", { command: "pwd" });
			expect(textContent(pwd)).toContain("repo-b");
		} finally {
			await session.dispose();
		}
	});

	it("refuses an unreadable target without moving", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const locked = path.join(cwdA, "locked");
		fs.mkdirSync(locked, { recursive: true });
		fs.chmodSync(locked, 0);
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const moveTool = session.getToolByName("move_session")!;
			await expect(moveTool.execute("move-unreadable", { path: "locked" })).rejects.toThrow(
				/access unavailable|permission|EACCES/i,
			);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			fs.chmodSync(locked, 0o755);
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

	it("does not expose move_session in canonical sub-sessions identified by parentTaskPrefix or currentAgentType alone", async () => {
		for (const overrides of [{ parentTaskPrefix: "0-Worker" }, { currentAgentType: "executor" }] as Array<
			Record<string, unknown>
		>) {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwdA = path.join(tempDir, "root");
			fs.mkdirSync(cwdA, { recursive: true });

			const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
			const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"], ...overrides });
			try {
				expect(
					session.getToolByName("move_session"),
					`sub-session with ${Object.keys(overrides)[0]} must not expose move_session`,
				).toBeUndefined();
			} finally {
				await session.dispose();
			}
		}
	});

	it("refuses to move while a workflow skill is active", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const activated = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (
					event.type === "message_start" &&
					event.message.role === "custom" &&
					event.message.customType === SKILL_PROMPT_MESSAGE_TYPE
				)
					activated.resolve();
			});
			session.agent.emitExternalEvent({
				type: "message_start",
				message: {
					role: "custom",
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: "# Deep Interview",
					display: true,
					details: { name: "deep-interview" },
					attribution: "agent",
					timestamp: Date.now(),
				},
			});
			await activated.promise;
			unsubscribe();
			expect(session.getActiveSkillState()).toMatchObject({ skill: "deep-interview" });

			const moveTool = session.getToolByName("move_session")!;
			let error: unknown;
			try {
				await moveTool.execute("move-during-workflow", { path: "repo-b" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("workflow skill is active");
			expect(sessionManager.getCwd()).toBe(cwdA);
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
	it("does not expose move_session when caller-owned MCP or a frozen workspace tree is bound", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });
		const frozenTree = { cwd: cwdA, entries: [], agentsMdFiles: [] };
		const withTree = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const treeSession = await makeSession(cwdA, withTree, {
			toolNames: ["move_session"],
			workspaceTree: frozenTree,
		});
		try {
			expect(treeSession.session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await treeSession.session.dispose();
		}
		const withMcp = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const mcpSession = await makeSession(cwdA, withMcp, {
			toolNames: ["move_session"],
			mcpManager: { connectServers() {} },
		});
		try {
			expect(mcpSession.session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await mcpSession.session.dispose();
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
	it("does not expose move_session under bashAllowedPrefixes", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			bashAllowedPrefixes: ["/usr/bin"],
		});
		try {
			expect(session.getToolByName("move_session")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("refuses to move when a restored workflow is active without a live prompt marker", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		await syncSkillActiveState({
			cwd: cwdA,
			sessionId: sessionManager.getSessionId(),
			skill: "deep-interview",
			phase: "interview",
			active: true,
		});
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			expect(session.getActiveSkillState()).toBeUndefined();
			expect(session.getEffectiveActiveWorkflowSkillState()).toMatchObject({ skill: "deep-interview" });
			const moveTool = session.getToolByName("move_session")!;
			let error: unknown;
			try {
				await moveTool.execute("move-restored-workflow", { path: "repo-b" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeDefined();
			expect(String((error as Error)?.message ?? error)).toContain("workflow skill is active");
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
		}
	});

	it("queues an unrelated cwd transition instead of skipping the lock", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		fs.mkdirSync(cwdA, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const hold = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		let secondEntered = false;
		const first = sessionManager.runExclusiveCwdTransition(async () => {
			firstEntered.resolve();
			await hold.promise;
		});
		await firstEntered.promise;
		const second = sessionManager.runExclusiveCwdTransition(async () => {
			secondEntered = true;
		});
		await Bun.sleep(40);
		expect(secondEntered).toBe(false);
		hold.resolve();
		await Promise.all([first, second]);
		expect(secondEntered).toBe(true);
		await sessionManager.close();
	});

	it("serializes overlapping model and SessionManager moves", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		const repoC = path.join(cwdA, "repo-c");
		fs.mkdirSync(repoB, { recursive: true });
		fs.mkdirSync(repoC, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			const hold = Promise.withResolvers<void>();
			const firstEntered = Promise.withResolvers<void>();
			const first = sessionManager.runExclusiveCwdTransition(async () => {
				firstEntered.resolve();
				await hold.promise;
				await sessionManager.moveTo(repoB);
			});
			await firstEntered.promise;
			let acpDone = false;
			const acp = sessionManager.moveTo(repoC).then(() => {
				acpDone = true;
			});
			await Bun.sleep(40);
			expect(acpDone).toBe(false);
			hold.resolve();
			await first;
			await acp;
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoC));
		} finally {
			await session.dispose();
		}
	});
	it("does not steal process cwd when this session does not own it", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const processBefore = process.cwd();
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-no-steal", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			expect(process.cwd()).toBe(processBefore);
		} finally {
			await session.dispose();
		}
	});

	it("rejects a relative tool admitted before a concurrent cwd generation change", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			const hold = Promise.withResolvers<void>();
			const firstEntered = Promise.withResolvers<void>();
			const first = sessionManager.runExclusiveCwdTransition(async () => {
				firstEntered.resolve();
				await hold.promise;
				await sessionManager.moveTo(repoB);
			});
			await firstEntered.promise;
			const bashTool = session.getToolForExecution("bash")!;
			const bashRun = bashTool.execute("pwd-during-move", { command: "pwd" });
			await Bun.sleep(20);
			hold.resolve();
			await first;
			await expect(bashRun).rejects.toThrow(/working directory changed/);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a committed move when abort and dispose race it", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		const moveTool = session.getToolByName("move_session")!;
		const moving = moveTool.execute("move-abort-dispose", { path: "repo-b" });
		session.agent.abort();
		const disposed = session.dispose();
		await expect(moving).resolves.toBeDefined();
		await disposed;
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
	});

	it("does not fail the committed move when SSH refresh throws", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			session.refreshSshTool = async () => {
				throw new Error("ssh refresh exploded");
			};
			const moveTool = session.getToolByName("move_session")!;
			const result = await moveTool.execute("move-ssh-fail", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			expect(textContent(result)).toContain("repo-b");
		} finally {
			await session.dispose();
		}
	});

	it("refuses a move when the no-follow target is replaced after the handle is opened", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		const outside = path.join(tempDir, "outside");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const handle = await SessionManager.openNoFollowDirectory(repoB);
		try {
			const opened = await handle.stat({ bigint: true });
			fs.rmdirSync(repoB);
			fs.symlinkSync(outside, repoB);
			await expect(
				sessionManager.moveTo(repoB, {
					expectedIdentity: { dev: opened.dev, ino: opened.ino },
					targetHandle: handle,
				}),
			).rejects.toThrow(/replaced path|identity changed/);
			expect(sessionManager.getCwd()).toBe(cwdA);
		} finally {
			await handle.close().catch(() => {});
			await sessionManager.close();
		}
	});

	it("sanitizes control characters in the renderer preview and error output", () => {
		const dirty = "repo-\tname\x1b[31mred";
		const preview = moveSessionToolRenderer.renderCall({ path: dirty }).render(200).join("\n");
		expect(preview).not.toContain("\t");
		expect(preview).not.toContain("\x1b");
		expect(preview).toContain("move_session");
		const failed = moveSessionToolRenderer
			.renderResult({ isError: true, details: { from: dirty, to: dirty } }, { expanded: false, isPartial: false }, {
				fg: (_k: string, text: string) => text,
			} as never)
			.render(200)
			.join("\n");
		expect(failed).toContain("move_session failed");
		expect(failed).not.toContain("\x1b");
	});
});
