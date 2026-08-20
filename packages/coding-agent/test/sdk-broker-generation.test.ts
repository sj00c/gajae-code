import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { Broker } from "../src/sdk/broker/broker";
import { brokerProcessIncarnation, readBrokerDiscovery, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	canRetireStaleBrokerForTest,
	ensureBroker,
	signalExactBrokerForTest,
} from "../src/sdk/broker/ensure";
import {
	resolveSdkInternalSpawnCommandForTest,
	resolveSdkPackageAuthority,
	resolveSdkPackageGeneration,
} from "../src/sdk/broker/runtime";

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-generation-"));

function olderPackageVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`Test requires a stable package version, got ${version}`);
	return `${match[1]}.${match[2]}.${Math.max(0, Number(match[3]) - 1)}`;
}

function staleBroker(agentDir: string): Broker {
	const authority = resolveSdkPackageAuthority();
	return new Broker({
		agentDir,
		packageGeneration: "stale-gen",
		packageVersion: olderPackageVersion(authority.packageVersion),
		installationIdentity: authority.installationIdentity,
	});
}

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
		const stale = staleBroker(dir);
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
		const stale = staleBroker(dir);
		const stop = vi.spyOn(stale, "stop").mockResolvedValue(undefined);
		try {
			const published = await stale.start();
			const expected = resolveSdkPackageGeneration();
			await expect(ensureBroker({ agentDir: dir, expectedPackageGeneration: expected })).rejects.toThrow(
				"stale broker retirement was not verified",
			);
			const current = await readBrokerDiscovery(dir);
			expect(current?.pid).toBe(published.pid);
		} finally {
			stop.mockRestore();
			await cleanup(dir, stale);
		}
	}, 15_000);

	it("does not satisfy a concurrent caller with a different generation", async () => {
		const dir = await temp();
		const stale = staleBroker(dir);
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

	it("does not signal the ensuring process for an unreachable self-PID discovery", async () => {
		const dir = await temp();
		try {
			const incarnation = brokerProcessIncarnation(process.pid);
			expect(incarnation).toBeString();
			await writeBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "stale-gen",
				ownerId: "self-pid-test",
				pid: process.pid,
				incarnation: incarnation!,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "unreachable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			});
			await expect(
				ensureBroker({ agentDir: dir, expectedPackageGeneration: resolveSdkPackageGeneration() }),
			).rejects.toThrow("stale broker retirement was not verified");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("uses the incarnation-bound native signal for Darwin unknown-operation fallback", () => {
		const originalPlatform = process.platform;
		const processRef = {
			incarnation: "darwin:1700000000:123456",
			signalRoot: vi.fn(() => true),
		};
		const fromPid = vi.spyOn(nativeProcessBindings().Process, "fromPid").mockReturnValue(processRef as never);
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		try {
			expect(signalExactBrokerForTest(4_242, processRef.incarnation)).toBe(true);
			expect(processRef.signalRoot).toHaveBeenCalledWith(os.constants.signals.SIGTERM);
		} finally {
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			fromPid.mockRestore();
		}
	});

	it("retires only a strictly older broker from the same installation", () => {
		const authority = resolveSdkPackageAuthority();
		const base = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "older-generation",
			packageVersion: olderPackageVersion(authority.packageVersion),
			installationIdentity: authority.installationIdentity,
			ownerId: "authority-test",
			pid: 1,
			incarnation: "linux:1",
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "authority-test-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};

		expect(canRetireStaleBrokerForTest(base, authority)).toBe(true);
		expect(canRetireStaleBrokerForTest({ ...base, packageVersion: authority.packageVersion }, authority)).toBe(false);
		expect(
			canRetireStaleBrokerForTest(
				{ ...base, packageVersion: `${Number(authority.packageVersion.split(".")[0]) + 1}.0.0` },
				authority,
			),
		).toBe(false);
		expect(
			canRetireStaleBrokerForTest(
				{ ...base, installationIdentity: `${authority.installationIdentity}-other` },
				authority,
			),
		).toBe(false);
	});

	it("does not signal a newer broker when the caller generation is stale", async () => {
		const dir = await temp();
		const authority = resolveSdkPackageAuthority();
		const signalRoot = vi.fn(() => true);
		const fromPid = vi
			.spyOn(nativeProcessBindings().Process, "fromPid")
			.mockReturnValue({ incarnation: brokerProcessIncarnation(process.pid), signalRoot } as never);
		try {
			const incarnation = brokerProcessIncarnation(process.pid);
			expect(incarnation).toBeString();
			await writeBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "newer-broker-generation",
				packageVersion: `${Number(authority.packageVersion.split(".")[0]) + 1}.0.0`,
				installationIdentity: authority.installationIdentity,
				ownerId: "newer-broker",
				pid: process.pid,
				incarnation: incarnation!,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "newer-broker-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			});
			await expect(
				ensureBroker({ agentDir: dir, expectedPackageGeneration: "older-caller-generation" }),
			).rejects.toThrow("changed before retirement");
			expect(signalRoot).not.toHaveBeenCalled();
		} finally {
			fromPid.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to signal a substituted process incarnation", () => {
		const processRef = {
			incarnation: "darwin:1700000000:999999",
			signalRoot: vi.fn(() => true),
		};
		const fromPid = vi.spyOn(nativeProcessBindings().Process, "fromPid").mockReturnValue(processRef as never);
		try {
			expect(signalExactBrokerForTest(4_242, "darwin:1700000000:123456")).toBe(false);
			expect(processRef.signalRoot).not.toHaveBeenCalled();
		} finally {
			fromPid.mockRestore();
		}
	});

	it("serializes concurrent stale-broker retirements into one replacement", async () => {
		const dir = await temp();
		const stale = staleBroker(dir);
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
