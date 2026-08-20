import { describe, expect, it } from "bun:test";
import { OAuthCredentialSelectorError } from "@gajae-code/ai/core";
import { AccountsCommandError, runAccountsCommand, toAccountsCommandError } from "../src/cli/accounts-cli";

function captureStream(stream: NodeJS.WriteStream): { chunks: string[]; restore: () => void } {
	const chunks: string[] = [];
	const original = stream.write.bind(stream);
	stream.write = ((chunk: Uint8Array | string): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof stream.write;
	return {
		chunks,
		restore: () => {
			stream.write = original as typeof stream.write;
		},
	};
}

describe("accounts command error surfacing", () => {
	it("renders AccountsCommandError to stderr with exit code 1 in text mode instead of throwing", async () => {
		const err = captureStream(process.stderr);
		const priorExitCode = process.exitCode;
		try {
			await runAccountsCommand({ action: "pin", flags: {} });
			expect(err.chunks.join("")).toContain("Persistent account pinning requires --persistent.");
			expect(process.exitCode).toBe(1);
		} finally {
			err.restore();
			process.exitCode = priorExitCode ?? 0;
		}
	});

	it("emits exactly one accounts-error JSON document in --json mode", async () => {
		const out = captureStream(process.stdout);
		const err = captureStream(process.stderr);
		const priorExitCode = process.exitCode;
		try {
			await runAccountsCommand({ action: "pin", flags: { json: true } });
			const doc = JSON.parse(out.chunks.join("")) as { ok: boolean; error: { code: string; message: string } };
			expect(doc.ok).toBe(false);
			expect(doc.error.code).toBe("accounts-error");
			expect(doc.error.message).toContain("--persistent");
			expect(err.chunks.join("")).toBe("");
		} finally {
			out.restore();
			err.restore();
			process.exitCode = priorExitCode ?? 0;
		}
	});

	it("maps OAuthCredentialSelectorError to AccountsCommandError preserving the message", () => {
		const message = "Credential 5 is an API-key row and cannot be pinned; choose an OAuth account";
		const mapped = toAccountsCommandError(
			new OAuthCredentialSelectorError("api-key-row", "zai", { kind: "id", value: "5" }, message),
		);
		expect(mapped).toBeInstanceOf(AccountsCommandError);
		expect(mapped?.message).toBe(message);
		expect(toAccountsCommandError(new Error("unrelated"))).toBeUndefined();
	});
});
