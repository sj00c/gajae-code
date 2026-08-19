import { expect, test } from "bun:test";
import { AcpSdkAdapter } from "../src/sdk/acp";
import type { SessionAttachment } from "../src/sdk/router";

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

test("ACP provider activation retries the current Router attachment after rotation during registration", async () => {
	let currentGeneration = 1;
	const firstRegistration = Promise.withResolvers<Record<string, unknown>>();
	const registrations: Array<{
		frame: Record<string, unknown>;
		generation: number | undefined;
		attachment: SessionAttachment | undefined;
	}> = [];
	const router = {
		request: async (
			_sessionId: string,
			frame: Record<string, unknown>,
			generation?: number,
			attachment?: SessionAttachment,
		) => {
			registrations.push({ frame, generation, attachment });
			if (registrations.length === 1) return await firstRegistration.promise;
			return {
				ok: true,
				result: { leaseId: typeof frame.expectedLeaseId === "string" ? frame.expectedLeaseId : "lease-1" },
			};
		},
	};
	const attachment = (generation: number): SessionAttachment => ({
		authorityId: `session-1:${generation}`,
		sessionId: "session-1",
		generation,
		isCurrent: () => currentGeneration === generation,
		send: async () => {},
		sendMaintenance: () => {},
	});
	const firstAttachment = attachment(1);
	const secondAttachment = attachment(2);
	const adapter = new AcpSdkAdapter({
		router: router as never,
		attachment: firstAttachment,
		sessionId: firstAttachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	const start = adapter.start();
	try {
		await waitFor(() => registrations.length === 1, "initial provider registration");
		currentGeneration = 2;
		adapter.acceptAttachment(secondAttachment);
		firstRegistration.resolve({ ok: true, result: { leaseId: "lease-1" } });
		await start;
		await waitFor(() => registrations.length === 2, "provider registration on rotated attachment");
		expect(registrations[0]).toMatchObject({ generation: 1, attachment: firstAttachment });
		expect(registrations[1]).toMatchObject({
			generation: 2,
			attachment: secondAttachment,
			frame: { type: "register_provider", capability: "ui" },
		});
	} finally {
		await adapter.close();
	}
});

test("ACP provider readiness renews leases on the same attachment after transport reconnect", async () => {
	const registrations: Record<string, unknown>[] = [];
	const attachment: SessionAttachment = {
		authorityId: "session-1:stable",
		sessionId: "session-1",
		generation: 1,
		isCurrent: () => true,
		send: async () => {},
		sendMaintenance: () => {},
	};
	const adapter = new AcpSdkAdapter({
		router: {
			request: async (_sessionId: string, frame: Record<string, unknown>) => {
				registrations.push(frame);
				return { ok: true, result: { leaseId: "lease-1" } };
			},
		} as never,
		attachment,
		sessionId: attachment.sessionId,
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
	});
	try {
		await adapter.start();
		expect(registrations).toHaveLength(1);
		await adapter.attachmentReady(attachment);
		expect(registrations).toHaveLength(2);
		expect(registrations[1]).toMatchObject({
			type: "register_provider",
			capability: "ui",
			expectedLeaseId: "lease-1",
		});
	} finally {
		await adapter.close();
	}
});

test("Broker lifecycle client cannot activate per-session providers", async () => {
	const client = {
		connectionId: "broker-connection",
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		connect: async () => {},
		global: async () => ({ ok: true }),
		close: async () => {},
	};
	const adapter = new AcpSdkAdapter({
		client: client as never,
		providers: [{ capability: "ui", definitions: [] }],
	});
	await expect(adapter.start()).rejects.toMatchObject({ code: "operation_prohibited" });
	await adapter.close();
});
