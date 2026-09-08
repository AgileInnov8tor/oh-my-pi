import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession unavailable provider auth reporting", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-unavailable-auth-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "agent.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
		tempDir.remove();
	});

	test("tells user rate-limit cooldown instead of /login when OAuth credential is blocked", async () => {
		await authStorage.set("google-antigravity", {
			type: "oauth",
			access: "stale-access",
			refresh: "refresh-token",
			expires: Date.now() - 1000,
			email: "neakvary@gmail.com",
		});
		const row = authStorage.listStoredCredentials("google-antigravity")[0];
		if (!row) throw new Error("expected stored row");
		const blockedUntil = Date.now() + 10 * 60_000;
		authStorage.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "google-antigravity:oauth",
			blockScope: "counter:google",
			blockedUntilMs: blockedUntil,
		});

		const model = getBundledModel("google-antigravity", "gemini-3-flash");
		if (!model) throw new Error("expected gemini model");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["test"],
				tools: [],
				messages: [],
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		let thrown: Error | undefined;
		try {
			await session.prompt("hello");
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBeDefined();
		expect(thrown?.message).toContain("rate-limited until");
		expect(thrown?.message).toContain("neakvary@gmail.com");
		expect(thrown?.message).toContain("Do not /login");
		expect(thrown?.message).not.toContain("Use /login");
		expect(thrown?.message).not.toContain("No API key found");
	});

	test("still provides /login guidance when provider has no auth at all", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected anthropic model");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["test"],
				tools: [],
				messages: [],
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		let thrown: Error | undefined;
		try {
			await session.prompt("hello");
		} catch (err) {
			thrown = err as Error;
		}

		expect(thrown).toBeDefined();
		expect(thrown?.message).toContain("No API key found for anthropic");
		expect(thrown?.message).toContain("Use /login");
	});
});
