import { describe, expect, test } from "bun:test";
import {
	acceptsDiscordInbound,
	type DiscordConversation,
	discordConversationKey,
} from "../src/sdk/bus/discord-conversation";
import type { SessionAttachment } from "../src/sdk/router";

function record(): DiscordConversation {
	return {
		generation: 1,
		state: "active",
		appId: "app",
		guildId: "guild",
		parentChannelId: "parent",
		threadId: "thread",
		sessionId: "session",
		endpointGeneration: 4,
		updatedAt: 0,
		seenEventIds: [],
		seenInteractionIds: [],
	};
}

function attachment(sessionId = "session", generation = 4, current = true): SessionAttachment {
	return {
		sessionId,
		generation,
		isCurrent: () => current,
		send: () => {},
		sendMaintenance: () => {},
	};
}

function acceptsAttachment(recordValue: DiscordConversation, value: SessionAttachment): boolean {
	return (
		value.sessionId === recordValue.sessionId &&
		value.isCurrent() &&
		acceptsDiscordInbound(recordValue, recordValue.threadId!, value.generation)
	);
}

describe("Discord conversation identity", () => {
	test("uses the complete app, guild, parent and thread identity", () => {
		expect(
			discordConversationKey({ appId: "app", guildId: "guild", parentChannelId: "parent", threadId: "thread" }),
		).toBe("app:guild:parent:thread");
	});
	test("rejects stale, superseded, archived and generation-mismatched inbound events", () => {
		const active = record();
		expect(acceptsDiscordInbound(active, "thread", 4)).toBe(true);
		expect(acceptsDiscordInbound(active, "other", 4)).toBe(false);
		expect(acceptsDiscordInbound(active, "thread", 5)).toBe(false);
		expect(acceptsDiscordInbound({ ...active, state: "archived" }, "thread", 4)).toBe(false);
		expect(acceptsDiscordInbound({ ...active, supersededByThreadId: "new" }, "thread", 4)).toBe(false);
	});
	test("allows only a current attachment matching the mapped session generation", () => {
		const active = record();
		expect(acceptsAttachment(active, attachment())).toBe(true);
		expect(acceptsAttachment(active, attachment("session", 3))).toBe(false);
		expect(acceptsAttachment(active, attachment("other", 4))).toBe(false);
		expect(acceptsAttachment(active, attachment("session", 4, false))).toBe(false);
	});
});
