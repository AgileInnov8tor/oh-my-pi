import { describe, expect, test } from "bun:test";
import {
	RpcExtensionUserMessageTracker,
	reportLocalOnlyPromptResult,
	watchAndReportLocalOnlyPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { ExtensionActions } from "../src/extensibility/extensions/types";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { AgentSession } from "../src/session/agent-session";

async function waitForPromptHandlers(prompt: Promise<unknown>): Promise<void> {
	await prompt.catch(() => undefined);
	await Promise.resolve();
}

async function waitForTrackedPromptHandlers(trackedPrompt: {
	prompt: Promise<unknown>;
	waitForAgentMessageTasks: () => Promise<void>;
}): Promise<void> {
	await trackedPrompt.prompt.catch(() => undefined);
	await trackedPrompt.waitForAgentMessageTasks();
	await Promise.resolve();
	await Promise.resolve();
}

describe("reportLocalOnlyPromptResult", () => {
	test("emits prompt_result when prompt resolves without invoking the agent or extension user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("does not emit false prompt_result when an extension command schedules a user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
	});

	test("does not emit false prompt_result when an extension command schedules a triggerTurn custom message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
	});

	test("ignores extension user messages scheduled before the watched prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.markAgentMessageTask();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("marks triggerTurn extension custom messages as agent work", async () => {
		let extensionActions: ExtensionActions | undefined;
		let markCount = 0;
		let sentOptions: { triggerTurn?: boolean } | undefined;
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendCustomMessage: async (_message: unknown, options?: { triggerTurn?: boolean }) => {
				sentOptions = options;
				return true;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			markAgentInvokingMessage: () => {
				markCount += 1;
			},
		});
		extensionActions?.sendMessage(
			{
				customType: "test",
				content: "context",
				display: true,
				details: "context",
				attribution: "user",
			},
			{ triggerTurn: true },
		);
		// markAgentInvokingMessage now fires off the tracked send's resolution (gated on the
		// boolean result) rather than synchronously, so let it settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(markCount).toBe(1);
		expect(sentOptions).toEqual({ triggerTurn: true });
	});

	test("does not suppress prompt_result when an aside sendMessage starts no turn (e.g. idle plan-mode fold)", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			// Mirrors AgentSession.sendCustomMessage's aside contract: `false` iff no turn started.
			sendCustomMessage: async () => false,
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendMessage(
				{ customType: "test", content: "context", display: true, details: "context", attribution: "agent" },
				{ deliverAs: "aside" },
			);
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_aside_no_turn",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		// A `false` result means sendCustomMessage provably started no turn — the RPC host must
		// still get its completion signal instead of waiting forever on agent events that never
		// arrive.
		expect(output).toEqual([{ type: "prompt_result", id: "req_aside_no_turn", agentInvoked: false }]);
	});

	test("suppresses prompt_result when an aside sendMessage starts a turn", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendCustomMessage: async () => true,
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendMessage(
				{ customType: "test", content: "context", display: true, details: "context", attribution: "agent" },
				{ deliverAs: "aside" },
			);
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_aside_turn",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(output).toEqual([]);
	});

	test("suppresses prompt_result when extension sendUserMessage succeeds", async () => {
		let extensionActions: ExtensionActions | undefined;
		let sentContent: unknown;
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async (content: unknown) => {
				sentContent = content;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_success",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(sentContent).toBe("start work");
		expect(output).toEqual([]);
	});

	test("emits prompt_result when extension sendUserMessage rejects", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const reportedErrors: Error[] = [];
		const thrown = new Error("missing model");
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async () => {
				throw thrown;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				reportedErrors.push(error);
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_rejected",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(reportedErrors).toEqual([thrown]);
		expect(output).toEqual([{ type: "prompt_result", id: "req_rejected", agentInvoked: false }]);
	});

	test("does not emit when prompt invokes the agent", async () => {
		const output: object[] = [];
		const prompt = Promise.resolve(true);

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([]);
	});

	test("reports prompt rejection without emitting output", async () => {
		const output: object[] = [];
		const thrown = new Error("boom");
		const prompt = Promise.reject(thrown);
		let reported: Error | undefined;

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				reported = error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(reported).toBe(thrown);
		expect(output).toEqual([]);
	});
});

describe("initializeExtensions invokingTask rejection safety", () => {
	test("does not crash the process when an extension send starts no turn outside any active prompt scope", async () => {
		let extensionActions: ExtensionActions | undefined;
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			// Mirrors AgentSession.sendCustomMessage's contract: `false` iff no turn started,
			// e.g. an idle steer superseded by a concurrent turn's preflight generation check.
			sendCustomMessage: async () => false,
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
			// Wired exactly like RPC mode: trackAgentInvokingMessage delegates to the tracker,
			// which only attaches a handler to the task while a prompt scope is active
			// (`#activePromptScopes`). No `watchPrompt` call below, so that set is empty.
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			if (!extensionActions) throw new Error("extensions not initialized");
			// No active prompt scope: a controller idle wake calling an extension action
			// directly (not inside an RPC prompt) hits this exact path.
			extensionActions.sendMessage(
				{ customType: "test", content: "context", display: true, details: "context", attribution: "agent" },
				{ deliverAs: "aside" },
			);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});
});

describe("watchAndReportLocalOnlyPromptResult", () => {
	test("reports builtin residual prompts that complete locally", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(false);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("does not report builtin residual prompts that invoke the agent", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(true);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([]);
	});
});

describe("RPC protected builtin command guards", () => {
	test("RPC abort during generation cancels preparation and does not run the native command", async () => {
		const output: string[] = [];
		const { promise: hang, resolve } = Promise.withResolvers<void>();
		let executed = 0;
		let cancelled = false;
		const session = {
			admitBuiltinCommand: () => ({ ok: true as const }),
			cancelBuiltinCommandPreparation: () => {
				cancelled = true;
				resolve();
				return true;
			},
			runBuiltinCommand: async (
				_request: { name: string; text: string; args: string },
				execute: () => Promise<unknown>,
			) => {
				await hang;
				if (cancelled) {
					return { status: "blocked" as const, reason: "Checkpoint cancelled; /compact was not run." };
				}
				return { status: "executed" as const, value: await execute() };
			},
			compact: async () => {
				executed += 1;
			},
		};
		const scheduled: Array<Promise<void>> = [];
		const runtime = {
			session,
			cwd: "/tmp",
			output: async (text: string) => {
				output.push(text);
			},
			runCommandInBackground: (task: () => Promise<void>) => {
				scheduled.push(task());
			},
		};
		const result = await executeAcpBuiltinSlashCommand("/compact", runtime as never);
		expect(result).toEqual({ consumed: true });
		session.cancelBuiltinCommandPreparation();
		await Promise.all(scheduled);
		expect(executed).toBe(0);
		expect(cancelled).toBe(true);
		expect(output).toEqual(["Checkpoint cancelled; /compact was not run."]);
	});

	test("rejects a second protected RPC command while the first is executing", async () => {
		const output: string[] = [];
		let state: "idle" | "preparing" | "executing" = "idle";
		const { promise: releaseExecute, resolve: resolveExecute } = Promise.withResolvers<void>();
		const session = {
			admitBuiltinCommand: () => {
				if (state !== "idle") {
					return { ok: false as const, reason: "Checkpoint already in progress; wait or cancel." };
				}
				state = "preparing";
				return { ok: true as const };
			},
			runBuiltinCommand: async (
				_request: { name: string; text: string; args: string },
				execute: () => Promise<unknown>,
			) => {
				state = "executing";
				const value = await execute();
				state = "idle";
				return { status: "executed" as const, value };
			},
			compact: async () => {
				await releaseExecute;
			},
			handoff: async () => ({ document: "nope" }),
		};
		const scheduled: Array<Promise<void>> = [];
		const runtime = {
			session,
			cwd: "/tmp",
			output: async (text: string) => {
				output.push(text);
			},
			runCommandInBackground: (task: () => Promise<void>) => {
				scheduled.push(task());
			},
		};
		const first = await executeAcpBuiltinSlashCommand("/compact", runtime as never);
		const second = await executeAcpBuiltinSlashCommand("/handoff", runtime as never);
		expect(first).toEqual({ consumed: true });
		expect(second).toEqual({ consumed: true });
		expect(output).toEqual(["Checkpoint already in progress; wait or cancel."]);
		resolveExecute();
		await Promise.all(scheduled);
	});
});
