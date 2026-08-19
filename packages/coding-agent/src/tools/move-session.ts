import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt, sanitizeText } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import moveSessionDescription from "../prompts/tools/move-session.md" with { type: "text" };
import type { ToolSession } from "./index";
import { Ellipsis, replaceTabs, shortenPath, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";

const moveSessionSchema = z.object({
	path: z.string().describe("target directory: absolute, or relative to the current session cwd"),
});

export type MoveSessionToolInput = z.infer<typeof moveSessionSchema>;

export interface MoveSessionToolDetails {
	from: string;
	to: string;
}

export class MoveSessionTool implements AgentTool<typeof moveSessionSchema, MoveSessionToolDetails> {
	readonly name = "move_session";
	readonly label = "Move Session";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(moveSessionDescription);
	readonly parameters = moveSessionSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	// The move chdirs the process and resets global caches; it must not
	// interleave with other tool executions across flush→moveTo→chdir.
	readonly concurrency = "exclusive" as const;
	// The move commits session-file relocation; aborting mid-sequence would
	// leave a half-moved session with no rollback path.
	readonly nonAbortable = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(_toolCallId: string, params: MoveSessionToolInput): Promise<AgentToolResult<MoveSessionToolDetails>> {
		const rescope = this.#session.rescopeSessionCwd;
		if (!rescope) {
			throw new ToolError(
				"This session cannot rescope its working directory; only top-level unrestrained sessions can move.",
			);
		}
		if (typeof params.path !== "string" || params.path.trim() === "") {
			throw new ToolError("path is required and must be a directory path.");
		}
		let moved: { from: string; to: string };
		try {
			moved = await rescope(params.path);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		return {
			content: [{ type: "text", text: `Session moved to ${moved.to} (from ${moved.from}).` }],
			details: { from: moved.from, to: moved.to },
		};
	}
}

interface MoveSessionRenderArgs {
	from: string;
	to: string;
}

const MOVE_SESSION_PREVIEW_WIDTH = 120;

export const moveSessionToolRenderer = {
	renderCall: (args: unknown): Component => {
		const target =
			typeof args === "object" && args !== null && typeof (args as { path?: unknown }).path === "string"
				? (args as { path: string }).path
				: "";
		const text = truncateToWidth(
			replaceTabs(sanitizeText(`move_session ${target}`)),
			MOVE_SESSION_PREVIEW_WIDTH,
			Ellipsis.Omit,
		);
		return new Text(text, 1, 1);
	},
	renderResult: (
		result: { details?: unknown; isError?: boolean },
		_options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
	): Component => {
		const details = (result.details ?? {}) as Partial<MoveSessionRenderArgs>;
		const from = typeof details.from === "string" ? details.from : "";
		const to = typeof details.to === "string" ? details.to : "";
		const body = result.isError
			? "move_session failed"
			: `Session moved: ${shortenPath(sanitizeText(from))} → ${shortenPath(sanitizeText(to))}`;
		return new Text(
			theme.fg(
				result.isError ? "error" : "accent",
				truncateToWidth(replaceTabs(sanitizeText(body)), MOVE_SESSION_PREVIEW_WIDTH, Ellipsis.Omit),
			),
			1,
			1,
		);
	},
};
