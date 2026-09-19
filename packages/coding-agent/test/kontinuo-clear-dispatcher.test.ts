import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
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
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";

// Opt-in live integration: needs the fleet guard module on disk (KONTINUO_GUARD_MODULE).
// Metadata-only leaf drift is covered in builtin-command-guards.test.ts for CI.
const GUARD_MODULE = process.env.KONTINUO_GUARD_MODULE ?? "";
const KONTINUO_BIN = process.env.KONTINUO_BIN ?? "kontinuo";
const KONTINUO_HOME = process.env.HOME ?? "/tmp";
const e2eEnabled = process.env.KONTINUO_E2E === "1" && GUARD_MODULE !== "" && existsSync(GUARD_MODULE);
const CHECKPOINT_ID = "sha256:jcs:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESUME = `Kontinuo resume: ${CHECKPOINT_ID}`;
const REPLY = JSON.stringify({
	goal: "Ship fail-closed Kontinuo checkpoints",
	exact_stopping_point: "Extension package written; installer unapplied",
	next_action: "Run bun test on the new package",
	completed: [{ text: "Parsed model JSON", evidence: "file:checkpoint.ts" }],
	not_done: [{ text: "Live --apply", evidence: "missing-evidence:installer-apply" }],
	partially_done: [],
	deferred: [
		{
			text: "Semantic live-model check",
			evidence: "missing-evidence:operator-approval",
			reopen_condition: "Operator authorizes one disposable /dump",
		},
	],
	verification: [{ text: "Unit tests cover deny paths", evidence: "test:checkpoint.test.ts" }],
});

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "clear-e2e-model",
		name: "Clear E2E Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

async function writeExtension(dir: string, statsPath: string): Promise<string> {
	const extPath = path.join(dir, "kontinuo-e2e-extension.ts");
	const source = `
import { handleKontinuoGuard } from ${JSON.stringify(GUARD_MODULE)};
import { appendFileSync, writeFileSync } from "node:fs";

const BIN = ${JSON.stringify(KONTINUO_BIN)};
const STORE = "/tmp/kontinuo-e2e-store";
const CHECKPOINT_ID = ${JSON.stringify(CHECKPOINT_ID)};
const statsPath = ${JSON.stringify(statsPath)};
const HOME = ${JSON.stringify(KONTINUO_HOME)};

function record(event: string, extra: Record<string, unknown> = {}) {
  appendFileSync(statsPath, JSON.stringify({ event, ...extra }) + "\\n");
}

function makeMcp() {
  let stored: Record<string, unknown> | undefined;
  let writes = 0;
  return {
    env: { KONTINUO_BIN: BIN, KONTINUO_STORE: STORE, HOME },
    homedir: () => HOME,
    now: () => Date.now(),
    loadAllMCPConfigs: async () => ({
      configs: {
        kontinuo: { type: "stdio", command: BIN, args: ["--store", STORE, "mcp"] },
      },
    }),
    connectToServer: async () => ({ ok: true }),
    disconnectServer: async () => undefined,
    callTool: async (_connection: unknown, tool: string, args?: Record<string, unknown>) => {
      record("callTool", { tool, session_id: args?.session_id });
      if (tool === "handoff_write") {
        writes += 1;
        stored = {
          session_id: args?.session_id,
          status: "current",
          checkpoint: { id: CHECKPOINT_ID, ...(args?.checkpoint as object) },
        };
        writeFileSync(statsPath + ".writes", String(writes));
        return { structuredContent: { ok: true } };
      }
      if (tool === "handoff_resolve") return { structuredContent: { ok: true } };
      if (tool === "handoff_read") {
        return { structuredContent: { entries: stored ? [stored] : [] } };
      }
      return { isError: true };
    },
  };
}

export default function kontinuoE2e(pi: { registerBuiltinCommandGuard: Function }) {
  pi.registerBuiltinCommandGuard("kontinuo", async (event: unknown, ctx: unknown) => {
    record("guard", { name: (event as { name?: string }).name });
    return handleKontinuoGuard(event as never, ctx as never, makeMcp());
  });
}
`;
	await fs.writeFile(extPath, source);
	await fs.writeFile(statsPath, "");
	return extPath;
}

function seedTranscript(session: AgentSession): void {
	const user = {
		role: "user",
		content: [{ type: "text", text: "nonempty e2e transcript" }],
		timestamp: Date.now(),
	};
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "acknowledged the e2e transcript" }],
		timestamp: Date.now(),
		stopReason: "end_turn",
	};
	session.sessionManager.appendMessage(user as never);
	session.sessionManager.appendMessage(assistant as never);
	session.agent.replaceMessages([user, assistant] as never);
}

function stubEphemeralTurn(session: AgentSession, options?: { simulateMetadataDrift?: boolean }): void {
	session.runEphemeralTurn = (async () => {
		if (options?.simulateMetadataDrift) {
			const conversationLeaf = session.sessionManager.getConversationLeafId();
			await session.sessionManager.setSessionName("Background generated title", "auto");
			session.sessionManager.appendModelUsage(
				{
					purpose: "auto-thinking",
					role: "default",
					api: "openai-responses",
					provider: "managed-primary",
					model: "clear-e2e-model",
					stopReason: "stop",
					usage: {
						input: 1,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{ sessionId: session.sessionManager.getSessionId(), parentId: conversationLeaf },
			);
			expect(session.sessionManager.getConversationLeafId()).toBe(conversationLeaf);
			expect(session.sessionManager.getLeafId()).not.toBe(conversationLeaf);
		}
		return {
			replyText: REPLY,
			assistantMessage: { role: "assistant", content: [{ type: "text", text: REPLY }], stopReason: "end_turn" },
		};
	}) as unknown as typeof session.runEphemeralTurn;
}

function tuiRuntime(session: AgentSession): TuiSlashCommandRuntime {
	return {
		ctx: {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			editor: { setText() {} },
			showError() {},
			showStatus() {},
			showWarning() {},
			refreshSlashCommandState() {},
			async handleResetContextCommand() {
				await session.resetSessionContext();
			},
			async handleFreshCommand() {
				session.freshSession();
			},
			async handleClearCommand() {
				await session.newSession();
			},
			async handleDeleteCommand() {
				await session.newSession();
			},
			async restart() {},
			async handleCompactCommand() {},
			async handleHandoffCommand() {},
			clearTransientSessionUi() {},
			resetTranscript() {},
			statusLine: { invalidate() {} },
			updateEditorBorderColor() {},
			present() {},
			ui: { requestRender() {} },
		},
	} as unknown as TuiSlashCommandRuntime;
}

async function createE2eSession(tempDir: TempDir, extPath: string) {
	const api = `clear-e2e-${Bun.nanoseconds().toString(36)}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({
			"compaction.enabled": false,
			builtinCommandGuards: { clear: ["kontinuo"] },
		}),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		additionalExtensionPaths: [extPath],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { session, authStorage };
}

function writeCount(statsPath: string): number {
	try {
		return Number(require("node:fs").readFileSync(statsPath + ".writes", "utf8")) || 0;
	} catch {
		return 0;
	}
}

describe("TUI dispatcher /clear Kontinuo policy availability", () => {
	it("defaults to skip without KONTINUO_E2E=1 and KONTINUO_GUARD_MODULE", () => {
		expect(e2eEnabled).toBe(process.env.KONTINUO_E2E === "1" && GUARD_MODULE !== "" && existsSync(GUARD_MODULE));
	});
});

describe.skipIf(!e2eEnabled)("TUI dispatcher /clear Kontinuo policy", () => {
	afterEach(() => {
		delete process.env.OMP_KONTINUO_RESUME;
	});

	it("clear writes once and delivers checkpoint id in the rebuilt prompt", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-clear-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			seedTranscript(session);
			stubEphemeralTurn(session);
			expect(session.agent.state.messages.length).toBeGreaterThan(0);
			const sessionId = session.sessionManager.getSessionId();
			const handled = await executeBuiltinSlashCommand("/clear", tuiRuntime(session));
			expect(handled).toBe(true);
			expect(writeCount(statsPath)).toBe(1);
			expect(session.sessionManager.getSessionId()).toBe(sessionId);
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(RESUME);
			expect(session.getKontinuoResumeText()).toBe(RESUME);
			expect(session.agent.state.messages.length).toBe(0);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("fresh/restart/delete/new/compact/handoff do not write or inject resume", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-neg-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			seedTranscript(session);
			stubEphemeralTurn(session);
			const runtime = tuiRuntime(session);
			for (const cmd of ["/fresh", "/restart", "/delete", "/new", "/compact", "/handoff"]) {
				await executeBuiltinSlashCommand(cmd, runtime);
			}
			expect(writeCount(statsPath)).toBe(0);
			expect(session.getKontinuoResumeText()).toBeUndefined();
			expect(session.systemPrompt.join("\n")).not.toContain("Kontinuo resume:");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("clear then new drops stale checkpoint from the successor prompt", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-clear-new-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			seedTranscript(session);
			stubEphemeralTurn(session);
			const runtime = tuiRuntime(session);
			expect(await executeBuiltinSlashCommand("/clear", runtime)).toBe(true);
			expect(session.systemPrompt.join("\n")).toContain(RESUME);
			expect(await executeBuiltinSlashCommand("/new", runtime)).toBe(true);
			expect(writeCount(statsPath)).toBe(1);
			expect(session.getKontinuoResumeText()).toBeUndefined();
			expect(session.systemPrompt.join("\n")).not.toContain(RESUME);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("clear then fresh keeps resume without a second write", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-clear-fresh-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			seedTranscript(session);
			stubEphemeralTurn(session);
			const runtime = tuiRuntime(session);
			expect(await executeBuiltinSlashCommand("/clear", runtime)).toBe(true);
			expect(session.getKontinuoResumeText()).toBe(RESUME);
			expect(await executeBuiltinSlashCommand("/fresh", runtime)).toBe(true);
			expect(writeCount(statsPath)).toBe(1);
			expect(session.getKontinuoResumeText()).toBe(RESUME);
			expect(session.systemPrompt.join("\n")).toContain(RESUME);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("clear then delete drops stale checkpoint from the successor prompt", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-clear-delete-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			seedTranscript(session);
			stubEphemeralTurn(session);
			const runtime = tuiRuntime(session);
			expect(await executeBuiltinSlashCommand("/clear", runtime)).toBe(true);
			expect(session.systemPrompt.join("\n")).toContain(RESUME);
			expect(await executeBuiltinSlashCommand("/delete", runtime)).toBe(true);
			expect(writeCount(statsPath)).toBe(1);
			expect(session.getKontinuoResumeText()).toBeUndefined();
			expect(session.systemPrompt.join("\n")).not.toContain(RESUME);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("clear succeeds when metadata-only leaf drift happens during guard preparation", async () => {
		using tempDir = TempDir.createSync("@pi-kontinuo-clear-drift-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			seedTranscript(session);
			stubEphemeralTurn(session, { simulateMetadataDrift: true });
			const runtime = tuiRuntime(session);
			expect(await executeBuiltinSlashCommand("/clear", runtime)).toBe(true);
			expect(writeCount(statsPath)).toBe(1);
			expect(session.systemPrompt.join("\n")).toContain(RESUME);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("ignores a pre-set legacy OMP_KONTINUO_RESUME", async () => {
		process.env.OMP_KONTINUO_RESUME = RESUME;
		using tempDir = TempDir.createSync("@pi-kontinuo-legacy-e2e-");
		const statsPath = tempDir.join("stats.ndjson");
		const extPath = await writeExtension(tempDir.path(), statsPath);
		const { session, authStorage } = await createE2eSession(tempDir, extPath);
		try {
			expect(session.systemPrompt.join("\n")).not.toContain(RESUME);
			expect(session.getKontinuoResumeText()).toBeUndefined();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
