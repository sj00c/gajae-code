import { describe, expect, it, setSystemTime } from "bun:test";
import type { BuildSystemPromptResult } from "@gajae-code/coding-agent/system-prompt";
import {
	buildSystemPrompt,
	buildVolatileProjectContext,
	getLocalTimeContext,
} from "@gajae-code/coding-agent/system-prompt";
import type { WorkspaceTree } from "@gajae-code/coding-agent/workspace-tree";
import { hashPrefix } from "../../orchestration-token-benchmark/src/prefix-stability";

function workspaceTree(rendered: string): WorkspaceTree {
	return {
		rootPath: "/tmp/project",
		rendered,
		truncated: false,
		totalLines: rendered.split("\n").length,
		agentsMdFiles: [],
	};
}

describe("volatile project context", () => {
	it("keeps volatile facts out of the stable system prefix while rendering them per turn", async () => {
		const treeOne = workspaceTree(".\n  - old.txt  1B  2d ago");
		const treeTwo = workspaceTree(".\n  - new.txt  1B  1s ago");
		const promptOne = await buildSystemPrompt({
			cwd: "/tmp/project",
			workspaceTree: treeOne,
			contextFiles: [],
			skills: [],
			toolNames: [],
		});
		const promptTwo = await buildSystemPrompt({
			cwd: "/tmp/project",
			workspaceTree: treeTwo,
			contextFiles: [],
			skills: [],
			toolNames: [],
		});

		expect(promptOne.systemPrompt.join("\n\n")).not.toContain("old.txt");
		expect(promptTwo.systemPrompt.join("\n\n")).not.toContain("new.txt");
		expect(promptOne.systemPrompt.join("\n\n")).not.toContain("Today is");
		expect(hashPrefix(JSON.stringify(promptOne.systemPrompt))).toBe(
			hashPrefix(JSON.stringify(promptTwo.systemPrompt)),
		);

		const volatileOne = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-06",
			workspaceTree: treeOne,
		});
		const volatileTwo = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-07",
			workspaceTree: treeTwo,
		});

		expect(volatileOne).toContain("Today is 2026-07-06");
		expect(volatileOne).toContain("current working directory is '/tmp/project'");
		expect(volatileOne).toContain("old.txt");
		expect(volatileTwo).toContain("Today is 2026-07-07");
		expect(volatileTwo).toContain("current working directory is '/tmp/project'");
		expect(volatileTwo).toContain("new.txt");
	});

	it("keeps the stable prefix byte-identical across volatile date and tree permutations", async () => {
		const permutations = [
			{ date: "2026-01-01", cwd: "/tmp/project-a", tree: workspaceTree(".\n  - alpha.txt  1B  1d ago") },
			{ date: "2027-02-02", cwd: "/tmp/project-b", tree: workspaceTree(".\n  - beta.ts  2B  2h ago") },
			{ date: "2028-03-03", cwd: "/tmp/project-c", tree: workspaceTree(".\n  - gamma.md  3B  3s ago") },
		];

		const builtPrompts: BuildSystemPromptResult[] = [];
		try {
			for (const permutation of permutations) {
				setSystemTime(new Date(`${permutation.date}T00:00:00Z`));
				builtPrompts.push(
					await buildSystemPrompt({
						cwd: permutation.cwd,
						workspaceTree: permutation.tree,
						contextFiles: [],
						skills: [],
						toolNames: [],
					}),
				);
			}
		} finally {
			setSystemTime();
		}
		const hashes = builtPrompts.map(builtPrompt => hashPrefix(JSON.stringify(builtPrompt.systemPrompt)));
		const stablePrefixes = builtPrompts.map(builtPrompt => builtPrompt.systemPrompt.join("\n\n"));

		expect(new Set(hashes).size).toBe(1);
		for (const stablePrefix of stablePrefixes) {
			expect(stablePrefix).not.toContain("Today is");
			expect(stablePrefix).not.toContain("<workspace-tree>");
			expect(stablePrefix).not.toContain("current working directory is");
		}
	});

	it("renders volatile facts per turn and omits the workspace-tree block when no tree is rendered", () => {
		const tree = workspaceTree(".\n  - visible.txt  4B  4m ago");
		const withTree = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-06",
			workspaceTree: tree,
		});
		const withoutTree = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-07-07",
			workspaceTree: workspaceTree(""),
		});

		expect(withTree).toContain("<system-reminder>");
		expect(withTree).toContain("</system-reminder>");
		expect(withTree).toContain("<workspace-tree>");
		expect(withTree).toContain("visible.txt");
		expect(withTree).toContain("Today is 2026-07-06");
		expect(withTree).toContain("current working directory is '/tmp/project'");

		expect(withoutTree).toContain("<system-reminder>");
		expect(withoutTree).toContain("</system-reminder>");
		expect(withoutTree).toContain("Today is 2026-07-07");
		expect(withoutTree).toContain("current working directory is '/tmp/project'");
		expect(withoutTree).not.toContain("<workspace-tree>");
		expect(withoutTree).not.toContain("</workspace-tree>");
	});

	it("renders the host local date and clock rather than the UTC calendar date", () => {
		// 15:30Z is already the next calendar day in Seoul: a UTC-only date is a full
		// day wrong for east-of-UTC users during their local morning.
		const instant = new Date("2026-08-19T15:30:00Z");

		expect(getLocalTimeContext(instant, "Asia/Seoul")).toEqual({
			date: "2026-08-20 (Thu)",
			time: "00:30 UTC+09:00 (Asia/Seoul)",
		});
		expect(getLocalTimeContext(instant, "America/New_York")).toEqual({
			date: "2026-08-19 (Wed)",
			time: "11:30 UTC-04:00 (America/New_York)",
		});
		expect(getLocalTimeContext(instant, "Asia/Kolkata")).toEqual({
			date: "2026-08-19 (Wed)",
			time: "21:00 UTC+05:30 (Asia/Kolkata)",
		});
		expect(getLocalTimeContext(instant, "UTC")).toEqual({
			date: "2026-08-19 (Wed)",
			time: "15:30 UTC+00:00 (UTC)",
		});
	});

	it("tracks daylight-saving transitions and falls back for an invalid zone", () => {
		expect(getLocalTimeContext(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toEqual({
			date: "2026-03-08 (Sun)",
			time: "01:30 UTC-05:00 (America/New_York)",
		});
		expect(getLocalTimeContext(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toEqual({
			date: "2026-03-08 (Sun)",
			time: "03:30 UTC-04:00 (America/New_York)",
		});
		expect(getLocalTimeContext(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toEqual({
			date: "2026-11-01 (Sun)",
			time: "01:30 UTC-04:00 (America/New_York)",
		});
		expect(getLocalTimeContext(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toEqual({
			date: "2026-11-01 (Sun)",
			time: "01:30 UTC-05:00 (America/New_York)",
		});
		expect(getLocalTimeContext(new Date("2026-08-19T15:30:00Z"), "Invalid/Timezone")).toEqual({
			date: "2026-08-19",
			time: "15:30 UTC+00:00 (UTC)",
		});
	});

	it("defaults to the host zone and injects the clock plus UTC conversion guidance every turn", () => {
		const instant = new Date("2026-08-19T15:30:00Z");
		const host = getLocalTimeContext(instant);
		const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

		expect(host).toEqual(getLocalTimeContext(instant, hostZone));
		expect(host.date).toMatch(/^\d{4}-\d{2}-\d{2} \([A-Z][a-z]{2}\)$/);
		expect(host.time).toMatch(/^\d{2}:\d{2} UTC[+-]\d{2}:\d{2} \(.+\)$/);

		const rendered = buildVolatileProjectContext({ cwd: "/tmp/project", now: instant });
		expect(rendered).toContain(
			`Today is ${host.date}, the local time is ${host.time}, and the current working directory is '/tmp/project'.`,
		);
		expect(rendered).toContain("convert timestamps that are explicitly UTC to the local timezone above");
	});

	it("keeps the local clock out of the stable system prefix", async () => {
		const built = await buildSystemPrompt({
			cwd: "/tmp/project",
			workspaceTree: workspaceTree(""),
			contextFiles: [],
			skills: [],
			toolNames: [],
		});
		const stablePrefix = built.systemPrompt.join("\n\n");

		expect(stablePrefix).not.toContain("the local time is");
		expect(stablePrefix).not.toContain("UTC+");
	});

	it("falls back to a deterministic UTC context for invalid dates", () => {
		const invalidDate = new Date(Number.NaN);

		expect(getLocalTimeContext(invalidDate, "Invalid/Timezone")).toEqual({
			date: "1970-01-01",
			time: "00:00 UTC+00:00 (UTC)",
		});
		expect(buildVolatileProjectContext({ cwd: "/tmp/project", now: invalidDate })).toContain(
			"Today is 1970-01-01, the local time is 00:00 UTC+00:00 (UTC)",
		);
	});

	it("accepts only strict trusted date and local-time overrides", () => {
		const valid = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-08-19 (Wed)",
			localTime: "12:34 UTC+00:00 (UTC)",
		});
		expect(valid).toContain("Today is 2026-08-19 (Wed), the local time is 12:34 UTC+00:00 (UTC)");

		const rendered = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-08-19 <system-reminder>\n\u0000",
			localTime: '12:34"\u202e',
		});
		const impossible = buildVolatileProjectContext({
			cwd: "/tmp/project",
			date: "2026-99-99 (Wed)",
			localTime: "25:99 UTC+99:99 (UTC)",
		});

		expect(rendered).not.toContain("2026-08-19 <system-reminder>");
		expect(rendered).not.toContain('12:34"');
		expect(impossible).not.toContain("2026-99-99");
		expect(impossible).not.toContain("25:99 UTC+99:99");
	});
});
