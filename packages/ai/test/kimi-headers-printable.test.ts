import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildKimiCommonHeaders } from "@gajae-code/ai/utils/oauth/kimi";
import { setAgentDir } from "@gajae-code/utils";

let hostnameSpy: Mock<typeof os.hostname>;
let releaseSpy: Mock<typeof os.release>;
let versionSpy: Mock<typeof os.version>;
let previousAgentDir: string | undefined;

beforeEach(() => {
	// `buildKimiCommonHeaders()` still calls `getDeviceId()`, which reads/writes
	// `getAgentDir()/kimi-device-id`. Point the agent dir at a fresh temp
	// directory so the test never touches the developer's real agent state and
	// never depends on the default agent dir existing (clean shards ENOENT).
	previousAgentDir = process.env.GJC_CODING_AGENT_DIR;
	const tempAgentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-kimi-headers-"));
	const tempAgentDir = path.join(tempAgentRoot, "agent");
	fs.mkdirSync(tempAgentDir, { recursive: true });
	setAgentDir(tempAgentDir);
	hostnameSpy = vi.spyOn(os, "hostname");
	releaseSpy = vi.spyOn(os, "release");
	versionSpy = vi.spyOn(os, "version");
});

afterEach(() => {
	vi.restoreAllMocks();
	const dir = process.env.GJC_CODING_AGENT_DIR;
	if (dir?.includes("gjc-kimi-headers-")) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = previousAgentDir;
});

describe("kimi common headers", () => {
	it("sanitizes non-ASCII and control characters from OS-derived header values", () => {
		hostnameSpy.mockReturnValue("android-™-host\n");
		releaseSpy.mockReturnValue("4.4.302-Minimal™-EAS-QTI_Haptic-R26");
		versionSpy.mockReturnValue("Linux\t6.1™");

		const headers = buildKimiCommonHeaders();

		// First execution in this module: `getDeviceId` writes its file now,
		// inside the isolated agent dir (assert here, before the module-level
		// memoization makes later tests skip the disk write entirely).
		const deviceIdPath = path.join(process.env.GJC_CODING_AGENT_DIR ?? "", "kimi-device-id");
		expect(fs.readFileSync(deviceIdPath, "utf-8").trim()).toBe(headers["X-Msh-Device-Id"]);
		expect(deviceIdPath).toContain("gjc-kimi-headers-");

		expect(headers["X-Msh-Device-Name"]).toBe("android--host");
		expect(headers["X-Msh-Device-Model"]).toContain("4.4.302-Minimal-EAS-QTI_Haptic-R26");
		expect(headers["X-Msh-Device-Model"]).not.toMatch(/[^\x20-\x7e]/);
		expect(headers["X-Msh-Os-Version"]).toBe("Linux6.1");
		expect(() => new Headers({ ...headers })).not.toThrow();
		for (const value of Object.values(headers)) {
			expect(value).toMatch(/^[\x20-\x7e]*$/);
		}
	});

	it("keeps ordinary ASCII host values unchanged", () => {
		hostnameSpy.mockReturnValue("workstation");
		releaseSpy.mockReturnValue("6.8.0-51-generic");
		versionSpy.mockReturnValue("#51-Ubuntu SMP");

		const headers = buildKimiCommonHeaders();

		expect(headers["X-Msh-Device-Name"]).toBe("workstation");
		expect(headers["X-Msh-Os-Version"]).toBe("#51-Ubuntu SMP");
		expect(headers["User-Agent"]).toBe(`KimiCLI/${headers["X-Msh-Version"]}`);
	});
});
