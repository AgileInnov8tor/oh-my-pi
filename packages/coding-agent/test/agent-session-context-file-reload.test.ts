import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "context-reload-model",
		name: "Context Reload Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

async function expectContextReload(reset: (session: AgentSession) => Promise<unknown>): Promise<void> {
	using tempDir = TempDir.createSync("@pi-context-reload-");
	const marker = Bun.nanoseconds().toString(36);
	const original = `ORIGINAL_RULES_${marker}`;
	const updated = `UPDATED_RULES_${marker}`;
	const agentsMd = path.join(tempDir.path(), "AGENTS.md");
	await fs.writeFile(agentsMd, original);

	const api = `context-reload-${marker}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		skills: [],
		// contextFiles intentionally omitted so discovery runs against disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	try {
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt.join("\n")).toContain(original);

		await fs.writeFile(agentsMd, updated);
		expect(await reset(session)).toBeTruthy();

		const rebuilt = session.systemPrompt.join("\n");
		expect(rebuilt).toContain(updated);
		expect(rebuilt).not.toContain(original);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("AgentSession context-file reload on session reset", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-reads an edited AGENTS.md after newSession()", async () => {
		await expectContextReload(session => session.newSession());
	});

	it("re-reads an edited AGENTS.md after resetSessionContext()", async () => {
		await expectContextReload(session => session.resetSessionContext());
	});
});

const RESUME_MARKER = "Kontinuo resume: sha256:jcs:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

async function createReloadSession(tempDir: TempDir): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const api = `context-reload-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { session, authStorage };
}

describe("AgentSession Kontinuo resume text on session reset", () => {
	afterEach(() => {
		delete process.env.OMP_KONTINUO_RESUME;
		vi.restoreAllMocks();
	});

	it("delivers stored resume text in the rebuilt prompt after resetSessionContext()", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-clear-resume-");
		const { session, authStorage } = await createReloadSession(tempDir);
		try {
			session.setKontinuoResumeText(RESUME_MARKER);
			expect(await session.resetSessionContext()).toBeTruthy();
			expect(session.systemPrompt.join("\n")).toContain(RESUME_MARKER);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("drops stored resume text from the successor prompt after newSession()", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-new-resume-");
		const { session, authStorage } = await createReloadSession(tempDir);
		try {
			session.setKontinuoResumeText(RESUME_MARKER);
			expect(await session.newSession()).toBe(true);
			expect(session.systemPrompt.join("\n")).not.toContain(RESUME_MARKER);
			expect(session.getKontinuoResumeText()).toBeUndefined();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("ignores a pre-set legacy OMP_KONTINUO_RESUME at session start", async () => {
		process.env.OMP_KONTINUO_RESUME = RESUME_MARKER;
		using tempDir = TempDir.createSync("@pi-kontinuo-legacy-env-");
		const { session, authStorage } = await createReloadSession(tempDir);
		try {
			expect(session.systemPrompt.join("\n")).not.toContain(RESUME_MARKER);
			expect(session.getKontinuoResumeText()).toBeUndefined();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
