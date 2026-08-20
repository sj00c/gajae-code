import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendCoordinatorFile,
	CoordinatorPublicationUncertainError,
	isUnsupportedWindowsDirectorySyncError,
	syncCoordinatorDirectory,
	syncCoordinatorFile,
	writeCoordinatorAtomic,
} from "../src/coordinator-mcp/durability";

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("Coordinator durability", () => {
	it("accepts a documented Windows directory barrier failure while opening", async () => {
		const calls: string[] = [];
		await syncCoordinatorDirectory("state", {
			platform: "win32",
			openDirectory: async () => {
				calls.push("directory-open");
				throw errno("EPERM");
			},
		});
		expect(calls).toEqual(["directory-open"]);
	});

	it("accepts a Windows EACCES directory barrier while opening and syncing", async () => {
		await syncCoordinatorDirectory("state", {
			platform: "win32",
			openDirectory: async () => Promise.reject(errno("EACCES")),
		});
		const handle = {
			async sync(): Promise<void> {
				throw errno("EACCES");
			},
			async close(): Promise<void> {},
		} as fs.FileHandle;
		await syncCoordinatorDirectory("state", { platform: "win32", openDirectory: async () => handle });
	});

	it("keeps unexpected Windows directory open failures fail-closed", async () => {
		await expect(
			syncCoordinatorDirectory("state", {
				platform: "win32",
				openDirectory: async () => Promise.reject(errno("EIO")),
			}),
		).rejects.toMatchObject({ code: "EIO" });
	});

	it("keeps Windows directory close failures fail-closed", async () => {
		const handle = {
			async sync(): Promise<void> {},
			async close(): Promise<void> {
				throw errno("EIO");
			},
		} as fs.FileHandle;
		await expect(
			syncCoordinatorDirectory("state", { platform: "win32", openDirectory: async () => handle }),
		).rejects.toMatchObject({ code: "EIO" });
	});

	it("preserves both directory sync and close failures", async () => {
		const handle = {
			async sync(): Promise<void> {
				throw errno("EIO");
			},
			async close(): Promise<void> {
				throw errno("EACCES");
			},
		} as fs.FileHandle;
		await expect(
			syncCoordinatorDirectory("state", { platform: "linux", openDirectory: async () => handle }),
		).rejects.toBeInstanceOf(AggregateError);
	});

	it("accepts only unsupported Windows directory barriers after file durability", async () => {
		const calls: string[] = [];
		const handle = {
			async sync(): Promise<void> {
				calls.push("directory-sync");
				throw errno("EPERM");
			},
			async close(): Promise<void> {
				calls.push("directory-close");
			},
		} as fs.FileHandle;
		await syncCoordinatorDirectory("state", { platform: "win32", openDirectory: async () => handle });
		expect(calls).toEqual(["directory-sync", "directory-close"]);
	});

	it("keeps unexpected and non-Windows directory failures fail-closed", async () => {
		for (const [platform, code] of [
			["win32", "EIO"],
			["linux", "EPERM"],
		] as const) {
			const handle = {
				async sync(): Promise<void> {
					throw errno(code);
				},
				async close(): Promise<void> {},
			} as fs.FileHandle;
			await expect(
				syncCoordinatorDirectory("state", { platform, openDirectory: async () => handle }),
			).rejects.toMatchObject({ code });
		}
	});

	it("propagates unsupported-code lookalikes at both directory barriers", async () => {
		for (const code of ["ENOTSUP", "EOPNOTSUPP", "EINVAL"] as const) {
			await expect(
				syncCoordinatorDirectory("state", {
					platform: "win32",
					openDirectory: async () => Promise.reject(errno(code)),
				}),
			).rejects.toMatchObject({ code });
			const handle = {
				async sync(): Promise<void> {
					throw errno(code);
				},
				async close(): Promise<void> {},
			} as fs.FileHandle;
			await expect(
				syncCoordinatorDirectory("state", { platform: "win32", openDirectory: async () => handle }),
			).rejects.toMatchObject({ code });
		}
	});

	it("never classifies file fsync failures as unsupported directory failures", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const handle = await fs.open(path.join(root, "state.json"), "w");
			try {
				await expect(
					syncCoordinatorFile(handle, { syncFile: async () => Promise.reject(errno("EPERM")) }),
				).rejects.toMatchObject({
					code: "EPERM",
				});
			} finally {
				await handle.close();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("appends a journal record only after file durability and its parent barrier", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const file = path.join(root, "event-journal.jsonl");
			const calls: string[] = [];
			await appendCoordinatorFile(file, "event\n", {
				syncFile: async () => {
					calls.push("file-sync");
				},
				openDirectory: async () => {
					calls.push("directory-open");
					return {
						async sync(): Promise<void> {
							calls.push("directory-sync");
						},
						async close(): Promise<void> {},
					} as fs.FileHandle;
				},
			});
			expect(await fs.readFile(file, "utf8")).toBe("event\n");
			expect(calls).toEqual(["file-sync", "directory-open", "directory-sync"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps append file sync failures fail-closed without a directory barrier", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const file = path.join(root, "event-journal.jsonl");
			const calls: string[] = [];
			let failSync = true;
			await expect(
				appendCoordinatorFile(file, "event\n", {
					syncFile: async () => {
						calls.push("file-sync");
						if (failSync) {
							failSync = false;
							throw errno("EIO");
						}
					},
					openDirectory: async () => {
						calls.push("directory-open");
						throw errno("directory barrier must not run");
					},
				}),
			).rejects.toMatchObject({ code: "EIO" });
			expect(calls).toEqual(["file-sync", "file-sync"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves append write and close failures and leaves no staged artifact", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		const file = path.join(root, "event-journal.jsonl");
		const realOpen = fs.open;
		const open = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === file)
				return {
					async writeFile(): Promise<void> {
						throw errno("EIO");
					},
					async close(): Promise<void> {
						throw errno("EACCES");
					},
				} as unknown as fs.FileHandle;
			return await realOpen(...args);
		});
		try {
			await expect(appendCoordinatorFile(file, "event\n")).rejects.toBeInstanceOf(AggregateError);
		} finally {
			open.mockRestore();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rolls back a partial append before surfacing the write failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		const file = path.join(root, "event-journal.jsonl");
		await fs.writeFile(file, "prior\n");
		const realOpen = fs.open;
		const open = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === file)
				return {
					async writeFile(): Promise<void> {
						await fs.appendFile(file, "partial");
						throw errno("EIO");
					},
					async truncate(length: number): Promise<void> {
						await fs.truncate(file, length);
					},
					async sync(): Promise<void> {},
					async close(): Promise<void> {},
				} as unknown as fs.FileHandle;
			return await realOpen(...args);
		});
		try {
			await expect(appendCoordinatorFile(file, "next\n")).rejects.toMatchObject({ code: "EIO" });
			expect(await fs.readFile(file, "utf8")).toBe("prior\n");
		} finally {
			open.mockRestore();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("publishes coordinator state only after file durability and accepts Windows directory EPERM", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const file = path.join(root, "state.json");
			const calls: string[] = [];
			await writeCoordinatorAtomic(file, "state", {
				platform: "win32",
				syncFile: async () => {
					calls.push("file-sync");
				},
				rename: async (source, destination) => {
					calls.push("rename");
					await fs.rename(source, destination);
				},
				openDirectory: async directory => {
					calls.push("directory-open");
					const handle = await fs.open(directory, "r");
					return Object.assign(handle, {
						async sync(): Promise<void> {
							calls.push("directory-sync");
							throw errno("EPERM");
						},
					});
				},
			});
			expect(await fs.readFile(file, "utf8")).toBe("state");
			expect(calls).toEqual(["file-sync", "rename", "directory-open", "directory-sync"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not publish a coordinator state file when file sync fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const file = path.join(root, "state.json");
			await expect(
				writeCoordinatorAtomic(file, "state", { syncFile: async () => Promise.reject(errno("EIO")) }),
			).rejects.toMatchObject({ code: "EIO" });
			expect(await Bun.file(file).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cleans up the temporary file after rename failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const file = path.join(root, "state.json");
			await expect(
				writeCoordinatorAtomic(file, "state", { rename: async () => Promise.reject(errno("EIO")) }),
			).rejects.toMatchObject({ code: "EIO" });
			expect((await fs.readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reports an uncertain outcome after rename when the parent barrier fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-durability-"));
		try {
			const file = path.join(root, "state.json");
			await expect(
				writeCoordinatorAtomic(file, "state", {
					openDirectory: async () =>
						({
							async sync(): Promise<void> {
								throw errno("EIO");
							},
							async close(): Promise<void> {},
						}) as fs.FileHandle,
				}),
			).rejects.toBeInstanceOf(CoordinatorPublicationUncertainError);
			expect(await fs.readFile(file, "utf8")).toBe("state");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("classifies only documented Windows directory error codes", () => {
		for (const code of ["EPERM", "EACCES"])
			expect(isUnsupportedWindowsDirectorySyncError(errno(code), "win32")).toBe(true);
		expect(isUnsupportedWindowsDirectorySyncError(errno("EIO"), "win32")).toBe(false);
		for (const code of ["ENOTSUP", "EOPNOTSUPP", "EINVAL"])
			expect(isUnsupportedWindowsDirectorySyncError(errno(code), "win32")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError(errno("EACCES"), "linux")).toBe(false);
		expect(isUnsupportedWindowsDirectorySyncError(errno("EPERM"), "linux")).toBe(false);
	});
});
