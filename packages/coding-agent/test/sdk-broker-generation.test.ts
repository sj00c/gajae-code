import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerDiscovery } from "../src/sdk/broker/discovery";
import { brokerOwnerForTest, ensureBroker } from "../src/sdk/broker/ensure";
import { resolveSdkInternalSpawnCommandForTest, resolveSdkPackageGeneration } from "../src/sdk/broker/runtime";

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-generation-"));

async function cleanup(dir: string, broker?: Broker): Promise<void> {
	await broker?.stop().catch(() => {});
	await brokerOwnerForTest(dir)
		?.stop()
		.catch(() => {});
	await fs.rm(dir, { recursive: true, force: true });
}

describe("sdk broker package generation", () => {
	it("is stable for the current package tree and shaped like a digest", () => {
		const first = resolveSdkPackageGeneration();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(resolveSdkPackageGeneration()).toBe(first);
	});

	it("binds compiled generation to content, not only size and mtime", async () => {
		const dir = await temp();
		const executable = path.join(dir, "gjc-copy");
		try {
			await fs.copyFile(process.execPath, executable);
			const markerName = "internal-source-marker-2178-abcd.txt";
			const evidence = {
				execPath: executable,
				markerPath: `/$bunfs/root/${markerName}`,
				embeddedFiles: [{ name: markerName }],
			} as const;
			const before = resolveSdkInternalSpawnCommandForTest("broker-internal", evidence);
			const stat = await fs.stat(executable);
			const bytes = await fs.readFile(executable);
			bytes[0] ^= 0xff;
			await fs.writeFile(executable, bytes);
			await fs.utimes(executable, stat.atime, stat.mtime);
			const after = resolveSdkInternalSpawnCommandForTest("broker-internal", evidence);
			expect(after.generation).not.toBe(before.generation);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reuses a live broker whose generation matches the caller's expectation", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, packageGeneration: "current-gen" });
		try {
			const published = await broker.start();
			const discovery = await ensureBroker({ agentDir: dir, expectedPackageGeneration: "current-gen" });
			expect(discovery.pid).toBe(published.pid);
			expect(discovery.packageGeneration).toBe("current-gen");
		} finally {
			await cleanup(dir, broker);
		}
	}, 15_000);

	it("uses the current package generation by default", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, packageGeneration: resolveSdkPackageGeneration() });
		try {
			const published = await broker.start();
			const discovery = await ensureBroker({ agentDir: dir });
			expect(discovery.pid).toBe(published.pid);
		} finally {
			await cleanup(dir, broker);
		}
	}, 15_000);

	it("retires a stale-generation broker and replaces it with a current one", async () => {
		const dir = await temp();
		const stale = new Broker({ agentDir: dir, packageGeneration: "stale-gen" });
		try {
			const published = await stale.start();
			const expected = resolveSdkPackageGeneration();
			expect(expected).not.toBe("stale-gen");
			const discovery = await ensureBroker({ agentDir: dir, expectedPackageGeneration: expected });
			// The replacement is a freshly spawned broker publishing the generation
			// of the package tree this process would spawn.
			expect(discovery.pid).not.toBe(published.pid);
			expect(discovery.packageGeneration).toBe(expected);
			// The stale broker no longer owns discovery.
			const current = await readBrokerDiscovery(dir);
			expect(current?.pid).toBe(discovery.pid);
			expect(current?.incarnation).toBe(discovery.incarnation);
		} finally {
			await cleanup(dir, stale);
		}
	}, 30_000);

	it("does not reuse a stale broker when retirement cannot be proven", async () => {
		const dir = await temp();
		const stale = new Broker({ agentDir: dir, packageGeneration: "stale-gen" });
		const stop = vi.spyOn(stale, "stop").mockResolvedValue(undefined);
		try {
			await stale.start();
			const expected = resolveSdkPackageGeneration();
			await expect(ensureBroker({ agentDir: dir, expectedPackageGeneration: expected })).rejects.toThrow(
				"stale broker retirement was not verified",
			);
		} finally {
			stop.mockRestore();
			await cleanup(dir, stale);
		}
	}, 15_000);

	it("does not satisfy a concurrent caller with a different generation", async () => {
		const dir = await temp();
		const stale = new Broker({ agentDir: dir, packageGeneration: "stale-gen" });
		try {
			await stale.start();
			const expected = resolveSdkPackageGeneration();
			const first = ensureBroker({ agentDir: dir, expectedPackageGeneration: expected });
			const second = ensureBroker({ agentDir: dir, expectedPackageGeneration: "different-generation" });
			expect((await first).packageGeneration).toBe(expected);
			await expect(second).rejects.toThrow("does not match expected generation different-generation");
		} finally {
			await cleanup(dir, stale);
		}
	}, 30_000);

	it("serializes concurrent stale-broker retirements into one replacement", async () => {
		const dir = await temp();
		const stale = new Broker({ agentDir: dir, packageGeneration: "stale-gen" });
		try {
			const published = await stale.start();
			const expected = resolveSdkPackageGeneration();
			const [first, second] = await Promise.all([
				ensureBroker({ agentDir: dir, expectedPackageGeneration: expected }),
				ensureBroker({ agentDir: dir, expectedPackageGeneration: expected }),
			]);
			expect(first.pid).toBe(second.pid);
			expect(first.pid).not.toBe(published.pid);
		} finally {
			await cleanup(dir, stale);
		}
	}, 30_000);
});
