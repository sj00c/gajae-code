import type { Settings } from "../config/settings";
import type { WorkspaceTree } from "../workspace-tree";
import { createLazyService, type LazyService } from "./lazy-service";

/** Deadline used by the legacy workspace-tree startup scan and first-turn barrier. */
export const WORKSPACE_TREE_SCAN_TIMEOUT_MS = 5_000;

/** Runtime view over the initial workspace tree and later TTL refreshes. */
export interface WorkspaceTreeRuntime {
	snapshot: WorkspaceTree;
	refresh(): Promise<WorkspaceTree>;
}

/**
 * Build the workspace-tree service without importing the native scanner until
 * the service is activated. The scan itself remains the single authority for
 * both eager startup and the lazy first-turn barrier.
 *
 * `cwd` is resolved per scan rather than captured once: a session that rescopes
 * (`move_session`, `/move`) must have its refreshes re-root at the new cwd,
 * otherwise every later tree describes the abandoned launcher root.
 */
export function createWorkspaceTreeService(
	settings: Settings,
	cwd: string | (() => string),
): LazyService<WorkspaceTreeRuntime> {
	const resolveCwd = typeof cwd === "function" ? cwd : () => cwd;
	return createLazyService({
		id: "workspaceTree",
		enabled: () => settings.get("workspaceTree.mode") === "eager" || settings.get("workspaceTree.mode") === "lazy",
		initialize: async ({ signal }) => {
			const scan = async (): Promise<WorkspaceTree> => {
				if (signal.aborted) throw new Error("Workspace-tree scan was aborted before it started.");
				const { buildWorkspaceTree } = await import("../workspace-tree");
				const tree = await buildWorkspaceTree(resolveCwd(), { timeoutMs: WORKSPACE_TREE_SCAN_TIMEOUT_MS });
				if (signal.aborted) throw new Error("Workspace-tree scan was aborted before it completed.");
				return tree;
			};
			const snapshot = await scan();
			return {
				value: {
					snapshot,
					refresh: async () => {
						const { buildWorkspaceTree } = await import("../workspace-tree");
						return buildWorkspaceTree(resolveCwd(), { timeoutMs: WORKSPACE_TREE_SCAN_TIMEOUT_MS });
					},
				},
			};
		},
	});
}
