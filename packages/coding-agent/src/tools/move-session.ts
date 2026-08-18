import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import moveSessionDescription from "../prompts/tools/move-session.md" with { type: "text" };
import type { ToolSession } from "./index";
import { shortenPath } from "./render-utils";
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

export const moveSessionToolRenderer = {
	renderCall: (args: unknown): Component => new Text(`move_session ${String(args ?? "")}`, 1, 1),
	renderResult: (
		result: { details?: unknown; isError?: boolean },
		_options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
	): Component => {
		const details = (result.details ?? {}) as Partial<MoveSessionRenderArgs>;
		const from = typeof details.from === "string" ? details.from : "";
		const to = typeof details.to === "string" ? details.to : "";
		const body = result.isError ? "move_session failed" : `Session moved: ${shortenPath(from)} → ${shortenPath(to)}`;
		return new Text(theme.fg(result.isError ? "error" : "accent", body), 1, 1);
	},
};
