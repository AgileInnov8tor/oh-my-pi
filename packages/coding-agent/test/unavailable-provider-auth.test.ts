import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	formatUnavailableProviderAuth,
	inspectUnavailableProviderAuth,
	unavailableProviderAuthMessage,
} from "@oh-my-pi/pi-coding-agent/session/unavailable-provider-auth";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("unavailable provider auth", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	test("missing grant still tells the user to /login", () => {
		const message = formatUnavailableProviderAuth(
			{ kind: "missing", provider: "google-antigravity" },
			"/tmp/agent.db",
		);
		expect(message).toContain("No API key found for google-antigravity");
		expect(message).toContain("Use /login");
	});

	test("blocked stored OAuth does not tell the user to /login", async () => {
		const dir = path.join(os.tmpdir(), `omp-unavailable-auth-${Date.now()}`);
		dirs.push(dir);
		const dbPath = path.join(dir, "agent.db");
		const storage = await AuthStorage.create(dbPath);
		await storage.set("google-antigravity", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			email: "neakvary@gmail.com",
		});
		const row = storage.listStoredCredentials("google-antigravity")[0];
		if (row === undefined) throw new Error("expected stored oauth row");
		const retryAtMs = Date.now() + 5 * 60_000;
		storage.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "google-antigravity:oauth",
			blockScope: "counter:google",
			blockedUntilMs: retryAtMs,
		});

		const reason = inspectUnavailableProviderAuth(storage, "google-antigravity");
		expect(reason).toEqual({
			kind: "blocked",
			provider: "google-antigravity",
			retryAtMs,
			emails: ["neakvary@gmail.com"],
		});

		const message = unavailableProviderAuthMessage(storage, "google-antigravity", dbPath);
		expect(message).toContain("rate-limited until");
		expect(message).toContain("neakvary@gmail.com");
		expect(message).toContain("Do not /login");
		expect(message).not.toContain("Use /login");
		expect(message).not.toContain("No API key found");
	});

	test("stored OAuth without an active block is unusable, not missing", async () => {
		const dir = path.join(os.tmpdir(), `omp-unavailable-auth-unusable-${Date.now()}`);
		dirs.push(dir);
		const dbPath = path.join(dir, "agent.db");
		const storage = await AuthStorage.create(dbPath);
		await storage.set("google-antigravity", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			email: "neakvary@gmail.com",
		});
		const reason = inspectUnavailableProviderAuth(storage, "google-antigravity");
		expect(reason.kind).toBe("stored-unusable");
		const message = unavailableProviderAuthMessage(storage, "google-antigravity", dbPath);
		expect(message).toContain("stored OAuth grant");
		expect(message).toContain("Do not /login");
		expect(message).not.toContain("Use /login");
		expect(message).not.toContain("No API key found");
	});
});
