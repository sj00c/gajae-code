import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
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
	it("does not steal process cwd from a sibling session launched at the same root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		// Two sessions sharing ONE root: `process.cwd() === session.cwd` holds for
		// both, so an inferred ownership check would let the second session chdir
		// the process out from under the first.
		const managerA = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const managerB = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const ownsA = SessionManager.claimProcessCwdOwnership(managerA);
		expect(ownsA).toBe(true);
		// The sibling cannot take the claim while the first owner is alive.
		expect(SessionManager.claimProcessCwdOwnership(managerB)).toBe(false);
		const { session } = await makeSession(cwdA, managerB, { toolNames: ["move_session"] });
		const processBefore = process.cwd();
		try {
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-no-steal", { path: "repo-b" });
			// The non-owner's session moved, but the shared process cwd is untouched.
			expect(managerB.getCwd()).toBe(fs.realpathSync(repoB));
			expect(process.cwd()).toBe(processBefore);
			expect(managerA.getCwd()).toBe(cwdA);
		} finally {
			await session.dispose();
			await managerA.close();
		}
	});

	it("holds a cwd read lease across a tool's whole execution, not just its admission", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		fs.writeFileSync(path.join(cwdA, "marker-root"), "root");
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session", "bash"] });
		try {
			const bashTool = session.getToolForExecution("bash")!;
			// Admit the command FIRST, then start the move while it is mid-flight:
			// this is the window in which a check-then-yield fence would let a
			// root-A command execute in root B.
			const bashRun = bashTool.execute("pwd-mid-move", { command: "sleep 0.3; pwd; ls marker-root" });
			await Bun.sleep(60);
			const moveStarted = sessionManager.runExclusiveCwdTransition(async () => {
				await sessionManager.moveTo(repoB);
			});
			const bashResult = await bashRun;
			const output = textContent(bashResult as { content?: Array<{ type: string; text?: string }> });
			// The command ran entirely in root A: it saw root A's cwd and its marker.
			expect(output).toContain(fs.realpathSync(cwdA));
			expect(output).toContain("marker-root");
			expect(output).not.toContain("No such file");
			await moveStarted;
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
		}
	});

	it("fences an async bash job to the cwd it was admitted for", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session", "bash"],
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
		});
		try {
			const bashTool = session.getToolForExecution("bash")!;
			// The async job is admitted (and its cwd captured) while the session is
			// still at root A; it then outlives the tool call.
			const started = await bashTool.execute("async-pwd", {
				command: "sleep 0.4; pwd",
				async: true,
			});
			const jobId = (started as { details?: { async?: { jobId?: string } } }).details?.async?.jobId;
			expect(typeof jobId).toBe("string");
			// Move the session while the admitted job is still running.
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-during-async", { path: "repo-b" });
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
			const manager = AsyncJobManager.instance();
			expect(manager).toBeDefined();
			let output = "";
			for (let attempt = 0; attempt < 80; attempt++) {
				const job = manager!.getJob(jobId!);
				if (job && (job.status === "completed" || job.status === "failed")) {
					output = job.resultText ?? manager!.readOutputSince(jobId!, 0)?.text ?? "";
					break;
				}
				await Bun.sleep(50);
			}
			expect(output.length).toBeGreaterThan(0);
			// The job ran in the cwd it was ADMITTED for, not the post-move cwd:
			// a job admitted against root A must never silently execute in root B.
			expect(output).toContain(fs.realpathSync(cwdA));
			expect(output.trim().endsWith(fs.realpathSync(repoB))).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("makes a writer wait for an outstanding read lease instead of committing under it", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const releaseReader = Promise.withResolvers<void>();
		const readerEntered = Promise.withResolvers<void>();
		let cwdSeenAtRelease = "";
		const reader = sessionManager.runWithCwdReadLease(async () => {
			readerEntered.resolve();
			await releaseReader.promise;
			cwdSeenAtRelease = sessionManager.getCwd();
		});
		await readerEntered.promise;
		let moveCommitted = false;
		const writer = sessionManager.runExclusiveCwdTransition(async () => {
			await sessionManager.moveTo(repoB);
			moveCommitted = true;
		});
		await Bun.sleep(50);
		// Writer is queued behind the live lease, so cwd is still root A.
		expect(moveCommitted).toBe(false);
		expect(sessionManager.getCwd()).toBe(cwdA);
		releaseReader.resolve();
		await reader;
		await writer;
		expect(cwdSeenAtRelease).toBe(cwdA);
		expect(moveCommitted).toBe(true);
		expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		await sessionManager.close();
	});

	it("does not starve a queued writer behind a stream of new readers", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const releaseFirst = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const firstReader = sessionManager.runWithCwdReadLease(async () => {
			firstEntered.resolve();
			await releaseFirst.promise;
		});
		await firstEntered.promise;
		const writer = sessionManager.runExclusiveCwdTransition(() => sessionManager.moveTo(repoB));
		await Bun.sleep(20);
		// Readers arriving after the writer was announced must queue behind it.
		const lateReaderCwds: string[] = [];
		const lateReaders = [0, 1, 2].map(() =>
			sessionManager.runWithCwdReadLease(async () => {
				lateReaderCwds.push(sessionManager.getCwd());
			}),
		);
		await Bun.sleep(30);
		expect(lateReaderCwds).toEqual([]);
		releaseFirst.resolve();
		await firstReader;
		await writer;
		await Promise.all(lateReaders);
		// Every late reader observed the POST-move cwd, proving the writer went first.
		expect(lateReaderCwds).toHaveLength(3);
		for (const seen of lateReaderCwds) expect(seen).toBe(fs.realpathSync(repoB));
		await sessionManager.close();
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

	it("rejects without moving when authority rebinding fails, and keeps launch-root tools", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		const { session } = await makeSession(cwdA, sessionManager, { toolNames: ["move_session"] });
		try {
			// recreatePythonTool is the first fallible step of authority rebinding,
			// which the accessor runs BEFORE committing the session-file move.
			let calls = 0;
			const original = session.recreatePythonTool.bind(session);
			session.recreatePythonTool = async () => {
				calls += 1;
				// Fail the move-to-target rebind; allow the launch-root restore.
				if (calls === 1) throw new Error("python rebind exploded");
				return original();
			};
			const moveTool = session.getToolByName("move_session")!;
			await expect(moveTool.execute("move-rebind-fail", { path: "repo-b" })).rejects.toThrow(/python rebind exploded/);
			// No half-moved session: cwd, process cwd, and generation are unchanged.
			expect(sessionManager.getCwd()).toBe(cwdA);
			expect(sessionManager.getCwdGeneration()).toBe(0);
			// The launch-root authority was restored, not left torn down.
			expect(calls).toBe(2);
			// The single-use budget is not consumed by a rejected move: a later
			// successful call must still be admitted.
			const retry = await moveTool.execute("move-rebind-retry", { path: "repo-b" });
			expect(textContent(retry)).toContain("repo-b");
			expect(sessionManager.getCwd()).toBe(fs.realpathSync(repoB));
		} finally {
			await session.dispose();
		}
	});

	it("re-roots project context files and the workspace tree at the new cwd", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "root");
		const repoB = path.join(cwdA, "repo-b");
		fs.mkdirSync(repoB, { recursive: true });
		fs.writeFileSync(path.join(cwdA, "AGENTS.md"), "launcher-root-instructions");
		fs.writeFileSync(path.join(repoB, "AGENTS.md"), "repo-b-instructions");
		const sessionManager = SessionManager.create(cwdA, SessionManager.managedDestination(cwdA, tempDir));
		// contextFiles/workspaceTree are NOT injected here: the session must
		// discover them, and re-discover them after the move.
		const { session } = await makeSession(cwdA, sessionManager, {
			toolNames: ["move_session"],
			contextFiles: undefined,
		});
		try {
			const before = session.systemPrompt.join("\n");
			expect(before).toContain("launcher-root-instructions");
			// repo-b is not on the launch root's ancestor walk, so its instructions
			// are invisible until the session is actually rescoped into it.
			expect(before).not.toContain("repo-b-instructions");
			const moveTool = session.getToolByName("move_session")!;
			await moveTool.execute("move-context-reroot", { path: "repo-b" });
			await session.refreshBaseSystemPrompt();
			const after = session.systemPrompt.join("\n");
			// The model is now shown the target repo's own project instructions, and
			// the prompt describes the new cwd rather than the retired launcher root.
			expect(after).toContain("repo-b-instructions");
			expect(after).toContain(fs.realpathSync(repoB));
			// The ancestor AGENTS.md legitimately still applies after narrowing.
			expect(after).toContain("launcher-root-instructions");
		} finally {
			await session.dispose();
		}
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

	it("refuses to publish a process cwd whose identity is not the validated target", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-move-session-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const validated = path.join(tempDir, "validated");
		const other = path.join(tempDir, "other");
		fs.mkdirSync(validated, { recursive: true });
		fs.mkdirSync(other, { recursive: true });
		const validatedIdentity = fs.statSync(validated, { bigint: true });
		const restore = process.cwd();
		try {
			// The process landed somewhere OTHER than the pinned directory, which is
			// what a post-validation path replacement produces for a name-based chdir.
			process.chdir(other);
			await expect(
				SessionManager.assertProcessCwdIdentity({ dev: validatedIdentity.dev, ino: validatedIdentity.ino }),
			).rejects.toThrow(/not the validated target directory/);
			// The same assertion passes when the process really is in the pinned dir.
			process.chdir(validated);
			await SessionManager.assertProcessCwdIdentity({ dev: validatedIdentity.dev, ino: validatedIdentity.ino });
		} finally {
			process.chdir(restore);
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
