import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as activeStateModule from "@gajae-code/coding-agent/skill-state/active-state";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";

function assistantMessage(stopReason: "stop" | "length" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason,
		usage: {
			input: 190000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("AgentSession workflow recovery continuation (#4560)", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-4560-continuation-");
		const extensionPath = path.join(getProjectAgentDir(tempDir.path()), "extensions", "compact.ts");
		await Bun.write(extensionPath, "export default function(pi) {}");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected built-in anthropic model");
		const agent = new Agent({
			initialState: {
				model: { ...bundledModel, contextWindow: 200_000 },
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			extensionRunner,
		});
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function compact(stopReason: "stop" | "length" = "stop"): Promise<void> {
		const message = assistantMessage(stopReason);
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
		await Bun.sleep(25);
		await session.waitForIdle();
	}

	async function seedActiveSkillState(phase: string, skill = "ultragoal"): Promise<void> {
		const { sessionPath } = activeStateModule.getSkillActiveStatePaths(tempDir.path(), session.sessionId);
		await Bun.write(
			sessionPath,
			JSON.stringify({
				version: 1,
				active_skills: [{ skill, phase, active: true, updated_at: new Date().toISOString() }],
			}),
		);
	}

	async function seedUltragoalPlan(): Promise<void> {
		const dir = path.join(tempDir.path(), ".gjc", `_session-${session.sessionId}`, "ultragoal");
		const now = new Date().toISOString();
		await Bun.write(
			path.join(dir, "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcGoalMode: "aggregate",
				gjcObjective: "Ship the durable recovery contract",
				goals: [
					{
						id: "G001",
						title: "Implement",
						objective: "Implement the contract",
						status: "complete",
						createdAt: now,
						updatedAt: now,
						evidence: "focused tests pass",
					},
					{
						id: "G002",
						title: "Verify",
						objective: "Verify resumption",
						status: "active",
						createdAt: now,
						updatedAt: now,
					},
				],
				createdAt: now,
				updatedAt: now,
			}),
		);
	}

	it("continues from the structured workflow contract after compaction", async () => {
		await seedActiveSkillState("active");
		await seedUltragoalPlan();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-4560",
				objective: "Ship the durable recovery contract",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const calls = promptSpy.mock.calls.flat(4) as unknown[];
		const text = JSON.stringify(calls);

		expect(text).toContain("workflow-recovery");
		expect(text).toContain("continue-current-goal");
		expect(text).toContain("G002");
		expect(text).toContain("Accepted scope");
	});

	it("keeps the generic prompt when no durable workflow state exists", async () => {
		await seedActiveSkillState("active");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await compact("length");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const calls = promptSpy.mock.calls.flat(2) as unknown[];
		const text = JSON.stringify(calls);
		expect(text).not.toContain("workflow-recovery");
	});
});
