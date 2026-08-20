import { persistCoordinatorRuntimeStateFromEvent } from "../../src/gjc-runtime/session-state-sidecar";

const stateFile = process.argv[2];
if (!stateFile) throw new Error("state file required");
const context = { sessionId: "155-FinalA4", cwd: process.cwd(), sessionFile: null };
await persistCoordinatorRuntimeStateFromEvent({ type: "agent_start" }, context);
await persistCoordinatorRuntimeStateFromEvent({ type: "tool_execution_start", toolCallId: "fixture-call" }, context, {
	label: "bash",
	observedAt: "2026-08-20T00:00:01.000Z",
});
await persistCoordinatorRuntimeStateFromEvent({ type: "tool_execution_end", toolCallId: "fixture-call" }, context, {
	label: "bash",
	observedAt: "2026-08-20T00:00:02.000Z",
});
await persistCoordinatorRuntimeStateFromEvent(
	{
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fixture" }] }],
	},
	context,
);
