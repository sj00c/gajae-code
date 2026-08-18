import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Container, Input } from "@gajae-code/tui";
import { getAgentDir, Snowflake, setAgentDir, setDefaultTabWidth } from "@gajae-code/utils";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { AsyncJobManager } from "../src/async";
import { DebugSelectorComponent } from "../src/debug";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { JobsOverlayComponent } from "../src/modes/components/jobs-overlay";
import { TasksPaneComponent } from "../src/modes/components/tasks-pane";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { JobsObserver } from "../src/modes/jobs-observer";
import { SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { TasksAggregator } from "../src/modes/tasks-aggregator";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

const testTheme = await getThemeByName("red-claw");
if (!testTheme) throw new Error("Failed to load red-claw test theme");

/**
 * Issue #4657 regression harness: mount a real CustomEditor in a real
 * Container so the terminal disposal contract is observable end to end.
 *
 * The composer is reusable across overlays: Container.clear() disposes
 * children terminally, and Editor.dispose() unregisters the tab-width change
 * listener. An overlay-open path that calls clear() with the live composer
 * attached silently kills that listener; every later restore re-mounts a dead
 * editor and runtime tab-width changes stop re-deriving composer layout.
 *
 * Each test drives the exact production open path through SelectorController
 * (or DebugSelectorComponent for the /debug viewers), closes it the way
 * production closes it, and then asserts the composer's tab-width listener
 * still fires across overlay cycles — the invalidation probe from
 * gajae-pet-widget.test.ts. The trailing "red control" block proves the probe
 * itself is sound: a genuinely disposed editor stops accruing invalidations.
 */

const CANCEL_KEY = "\u001b";
const SELECT_CONFIRM_KEY = "\r";
const SELECT_DOWN_KEY = "\u001b[B";

function countInvalidations(editor: CustomEditor): { count: number } {
	const invalidations = { count: 0 };
	const originalInvalidate = editor.invalidate.bind(editor);
	editor.invalidate = () => {
		invalidations.count += 1;
		originalInvalidate();
	};
	return invalidations;
}

function makeComposerHarness() {
	const editor = new CustomEditor(defaultEditorTheme);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const chatContainer = new Container();
	const ctx = {
		editor,
		editorContainer,
		chatContainer,
		showWarning: () => {},
		showError: () => {},
		showStatus: () => {},
		isStopped: () => false,
		ui: {
			setFocus: () => {},
			requestRender: () => {},
			requestLayoutRender: () => {},
			terminal: { rows: 30, columns: 80 },
		},
	} as unknown as InteractiveModeContext;
	return { editor, editorContainer, chatContainer, ctx };
}

/**
 * The /debug viewers re-open the selector through `ctx.showDebugSelector()`
 * (debug/index.ts onExit); wire that hook to the real SelectorController
 * method so the production cycle runs end to end.
 */
function makeDebugHarness() {
	const harness = makeComposerHarness();
	const controller = new SelectorController(harness.ctx);
	const debugCtx = {
		...harness.ctx,
		showDebugSelector: () => controller.showDebugSelector(),
	} as unknown as InteractiveModeContext;
	const debugController = new SelectorController(debugCtx);
	return { harness, controller: debugController };
}

/**
 * Toggle the default tab width once and assert the composer's listener fired.
 * Returns the invalidation count after the toggle.
 */
function expectTabWidthToggleInvalidates(
	invalidations: { count: number },
	previous: number,
	defaultWidth: number,
): number {
	const otherWidth = defaultWidth === 3 ? 4 : 3;
	setDefaultTabWidth(otherWidth);
	setDefaultTabWidth(defaultWidth);
	expect(invalidations.count).toBeGreaterThan(previous);
	return invalidations.count;
}

/** Red control for the probe: a genuinely disposed editor stops invalidating. */
function expectDisposedEditorStopsInvalidating(
	editor: CustomEditor,
	editorContainer: Container,
	invalidations: { count: number },
	defaultWidth: number,
): void {
	const disposedCount = invalidations.count;
	editorContainer.clear();
	editorContainer.addChild(editor);
	const otherWidth = defaultWidth === 3 ? 4 : 3;
	setDefaultTabWidth(otherWidth);
	expect(invalidations.count).toBe(disposedCount);
}

describe("reusable composer lifecycle across remaining overlay open paths (#4657)", () => {
	test("jobs overlay open does not dispose the reusable composer", () => {
		setThemeInstance(testTheme);
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const controller = new SelectorController(harness.ctx);
		const defaultWidth = 3;
		setDefaultTabWidth(defaultWidth);

		try {
			const observer = new JobsObserver(new AsyncJobManager({ onJobComplete: async () => {} }), undefined);
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				controller.showJobsOverlay(observer);
				const overlay = harness.editorContainer.children.find(child => child instanceof JobsOverlayComponent);
				expect(overlay).toBeDefined();
				// Production close: cancel the overlay's focus list.
				overlay?.handleInput(CANCEL_KEY);
				expect(harness.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			setDefaultTabWidth(4);
		}
	});

	test("tasks pane open does not dispose the reusable composer", () => {
		setThemeInstance(testTheme);
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const controller = new SelectorController(harness.ctx);
		const defaultWidth = 3;
		setDefaultTabWidth(defaultWidth);

		try {
			const manager = new AsyncJobManager({ onJobComplete: async () => {} });
			const observer = new JobsObserver(manager, undefined);
			const aggregator = new TasksAggregator(manager, observer, new SessionObserverRegistry(), undefined);
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				controller.showTasksPane(aggregator);
				const pane = harness.editorContainer.children.find(child => child instanceof TasksPaneComponent);
				expect(pane).toBeDefined();
				// Production close: cancel the pane's focus list.
				pane?.handleInput(CANCEL_KEY);
				expect(harness.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			setDefaultTabWidth(4);
		}
	});

	test("debug log and raw-SSE viewer opens do not dispose the reusable composer", async () => {
		setThemeInstance(testTheme);
		const { harness, controller } = makeDebugHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		setDefaultTabWidth(defaultWidth);

		// Point the dated-log source at a temp agent dir with seeded log files
		// so the real #handleViewLogs path mounts the real viewer.
		const originalAgentDir = getAgentDir();
		const tempRoot = path.join(os.tmpdir(), "pi-composer-detach-debug", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
		setAgentDir(tempRoot);
		const today = new Date().toISOString().slice(0, 10);
		await fs.writeFile(path.join(tempRoot, `gjc.${today}.log`), "seeded log line\n", "utf8");

		// The production /debug entry: showDebugSelector goes through the real
		// SelectorController.showSelector generic open boundary, so the open
		// detach at that boundary is exercised too. Viewer exits re-open the
		// selector through the ctx hook exactly like production (wired in
		// makeDebugHarness).
		const openDebugSelector = () => {
			controller.showDebugSelector();
			const selector = harness.editorContainer.children.find(child => child instanceof DebugSelectorComponent);
			if (!selector) throw new Error("Expected the debug selector to mount");
			return selector;
		};
		// DEBUG_MENU_ITEMS order: open-artifacts, performance, work, dump,
		// memory, logs, system, raw-sse — "logs" is index 5, "raw-sse" is 7.
		const menuIndexes = { logs: 5, rawSse: 7 } as const;

		const runViewerCycle = async (menuIndex: number) => {
			const selector = openDebugSelector();
			for (let step = 0; step < menuIndex; step += 1) selector.handleInput(SELECT_DOWN_KEY);
			selector.handleInput(SELECT_CONFIRM_KEY);
			// DebugSelectorComponent calls done() (restore) then opens the real
			// viewer through the exact production path under test.
			const deadline = Date.now() + 2_000;
			while (
				(harness.editorContainer.children[0] === harness.editor ||
					harness.editorContainer.children[0] instanceof DebugSelectorComponent) &&
				Date.now() < deadline
			) {
				await Bun.sleep(1);
			}
			expect(harness.editorContainer.children.length).toBe(1);
			const viewer = harness.editorContainer.children[0];
			expect(viewer).not.toBe(harness.editor);
			expect(viewer).not.toBeInstanceOf(DebugSelectorComponent);
			// Production close: viewer exit re-opens the debug selector;
			// canceling that restores the composer.
			viewer?.handleInput?.(CANCEL_KEY);
			expect(harness.editorContainer.children[0]).toBeInstanceOf(DebugSelectorComponent);
			harness.editorContainer.children[0]?.handleInput?.(CANCEL_KEY);
			expect(harness.editorContainer.children).toEqual([harness.editor]);
		};

		try {
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				// Both changed viewer branches, alternating per cycle.
				await runViewerCycle(cycle % 2 === 0 ? menuIndexes.logs : menuIndexes.rawSse);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			setAgentDir(originalAgentDir);
			setDefaultTabWidth(4);
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("OAuth API-key paste onPrompt does not dispose the reusable composer", async () => {
		setThemeInstance(testTheme);
		const harness = makeComposerHarness();
		const invalidations = countInvalidations(harness.editor);
		const defaultWidth = 3;
		setDefaultTabWidth(defaultWidth);

		// Capture the production onPrompt callback (the exact closure under
		// test) while stubbing everything around it.
		const capturedPrompts: Array<(prompt: { message: string; placeholder?: string }) => Promise<string>> = [];
		const oauthCtx = {
			...harness.ctx,
			oauthManualInput: { waitForInput: () => Promise.resolve("code"), clear: () => {} },
			openInBrowser: () => {},
			showHookConfirm: async () => false,
			settings: { get: () => undefined },
			session: {
				modelRegistry: {
					refresh: async () => {},
					getModelProfiles: () => new Map(),
					authStorage: {
						login: async (
							_providerId: string,
							callbacks: {
								onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
							},
						) => {
							capturedPrompts.push(callbacks.onPrompt);
						},
						listCredentialInventory: () => [],
						listCredentialRemovalTargets: () => [],
					},
				},
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(oauthCtx);

		try {
			let previous = 0;
			for (let cycle = 0; cycle < 4; cycle += 1) {
				const opened = controller.showOAuthSelector("login", "vllm");
				// Drive the captured production onPrompt until the code input
				// mounts (the promise resolves on submit).
				const promptPromise = (async () => {
					while (capturedPrompts.length === 0) await Bun.sleep(1);
					const onPrompt = capturedPrompts.shift();
					if (!onPrompt) throw new Error("Expected a captured onPrompt callback");
					return onPrompt({ message: "Paste your API key" });
				})();
				await Bun.sleep(5);
				// Find the mounted code Input and submit through it.
				const codeInput = oauthCtx.editorContainer.children.find(
					(child): child is Input =>
						child instanceof Input && typeof (child as { onSubmit?: unknown }).onSubmit === "function",
				);
				if (!codeInput) throw new Error("Expected the API-key code input to mount");
				for (const character of "sk-test") codeInput.handleInput(character);
				codeInput.handleInput("\r");
				await promptPromise;
				await opened;
				expect(oauthCtx.editorContainer.children).toEqual([harness.editor]);
				previous = expectTabWidthToggleInvalidates(invalidations, previous, defaultWidth);
			}
			expect(previous).toBeGreaterThanOrEqual(4);
			expectDisposedEditorStopsInvalidating(harness.editor, harness.editorContainer, invalidations, defaultWidth);
		} finally {
			setDefaultTabWidth(4);
		}
	});
});
