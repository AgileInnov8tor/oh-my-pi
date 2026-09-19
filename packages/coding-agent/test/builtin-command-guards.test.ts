import { afterEach, describe, expect, it } from "bun:test";
import type {
	BuiltinCommandGuardContext,
	BuiltinCommandGuardEvent,
	BuiltinCommandGuardResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	BuiltinCommandGate,
	isBuiltinCommandGuardResult,
	type BuiltinCommandGateHost,
	testSetBuiltinCommandPrepTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/session/builtin-command-gate";
import { applyGuardResumeHandoff } from "@oh-my-pi/pi-coding-agent/session/kontinuo-resume";
import {
	canonicalBuiltinCommandName,
	normalizeBuiltinCommandGuards,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function emptyContext(): BuiltinCommandGuardContext {
	return {
		getBranch: () => [],
		reportStatus: async () => {},
		runEphemeralTurn: async () => ({ replyText: "", stopReason: "stop" }),
	};
}

function createHost(options?: {
	busy?: boolean;
	guards?: Record<string, (event: BuiltinCommandGuardEvent, ctx: BuiltinCommandGuardContext) => Promise<unknown>>;
	required?: Record<string, string[]>;
	identity?: () => { cwd: string; sessionId: string; leafId: string | null };
	now?: () => number;
}): BuiltinCommandGateHost & { lastEvent?: BuiltinCommandGuardEvent; lastTimeoutMs?: number } {
	const host: BuiltinCommandGateHost & { lastEvent?: BuiltinCommandGuardEvent; lastTimeoutMs?: number } = {
		isBusy: () => options?.busy === true,
		identity: options?.identity ?? (() => ({ cwd: "/tmp/project", sessionId: "sess-1", leafId: "leaf-1" })),
		requiredGuardIds: canonicalName => ({ ok: true, ids: options?.required?.[canonicalName] ?? [] }),
		hasGuard: id => options?.guards?.[id] !== undefined,
		invokeGuard: async (id, event, ctx, timeoutMs) => {
			host.lastEvent = event;
			host.lastTimeoutMs = timeoutMs;
			const handler = options?.guards?.[id];
			if (!handler) {
				return { allow: false, reason: `Checkpoint blocked: required guard "${id}" is not registered.` };
			}
			const result = await handler(event, ctx);
			if (result && typeof result === "object" && "allow" in result) {
				return result as BuiltinCommandGuardResult;
			}
			return { allow: false, reason: `Checkpoint blocked: guard "${id}" returned a malformed result.` };
		},
		createContext: () => emptyContext(),
		reportAdmission: () => {},
		now: options?.now ?? (() => Date.now()),
	};
	return host;
}

describe("canonicalBuiltinCommandName", () => {
	it("maps /q to quit", () => {
		expect(canonicalBuiltinCommandName("q")).toBe("quit");
		expect(canonicalBuiltinCommandName("quit")).toBe("quit");
		expect(canonicalBuiltinCommandName("exit")).toBe("exit");
	});
});

describe("normalizeBuiltinCommandGuards", () => {
	it("accepts empty mapping and rewrites aliases to canonical names", () => {
		expect(normalizeBuiltinCommandGuards(undefined)).toEqual({ ok: true, value: {} });
		expect(normalizeBuiltinCommandGuards({ q: ["kontinuo"] })).toEqual({
			ok: true,
			value: { quit: ["kontinuo"] },
		});
	});

	it("rejects unknown commands and empty guard ids", () => {
		expect(normalizeBuiltinCommandGuards({ nope: ["kontinuo"] }).ok).toBe(false);
		expect(normalizeBuiltinCommandGuards({ quit: [""] }).ok).toBe(false);
	});
});

describe("BuiltinCommandGate", () => {
	afterEach(() => {
		testSetBuiltinCommandPrepTimeoutMs(undefined);
	});

	it("does not run the native callback while a guard is unresolved", async () => {
		let release!: (result: BuiltinCommandGuardResult) => void;
		const pending = new Promise<BuiltinCommandGuardResult>(resolve => {
			release = resolve;
		});
		const host = createHost({
			required: { dump: ["kontinuo"] },
			guards: { kontinuo: () => pending },
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const run = gate.run({ name: "dump", text: "/dump", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		await Bun.sleep(20);
		expect(executed).toBe(0);
		expect(gate.state).toBe("preparing");
		release({ allow: true });
		const result = await run;
		expect(result).toEqual({ status: "executed", value: "ran" });
		expect(executed).toBe(1);
	});

	it("releases exactly one callback after a single allow:true", async () => {
		const host = createHost({
			required: { new: ["kontinuo"] },
			guards: { kontinuo: async () => ({ allow: true }) },
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const result = await gate.run({ name: "new", text: "/new", args: "" }, async () => {
			executed += 1;
			return executed;
		});
		expect(result).toEqual({ status: "executed", value: 1 });
		expect(executed).toBe(1);
		expect(gate.state).toBe("idle");
	});

	it("forwards nonempty resumeText to execute and the executed result", async () => {
		const host = createHost({
			required: { new: ["kontinuo"] },
			guards: { kontinuo: async () => ({ allow: true, resumeText: "  Kontinuo resume: sha256:jcs:abc  " }) },
		});
		const gate = new BuiltinCommandGate(host);
		let seen: string | undefined;
		const result = await gate.run({ name: "new", text: "/new", args: "" }, async handoff => {
			seen = handoff?.resumeText;
			return "ok";
		});
		expect(seen).toBe("Kontinuo resume: sha256:jcs:abc");
		expect(result).toEqual({
			status: "executed",
			value: "ok",
			resumeText: "Kontinuo resume: sha256:jcs:abc",
		});
	});

	it("omits blank resumeText from the executed result", async () => {
		const host = createHost({
			required: { new: ["kontinuo"] },
			guards: { kontinuo: async () => ({ allow: true, resumeText: "   " }) },
		});
		const gate = new BuiltinCommandGate(host);
		const result = await gate.run({ name: "new", text: "/new", args: "" }, async () => "ok");
		expect(result).toEqual({ status: "executed", value: "ok" });
	});

	it("treats non-string resumeText as a malformed allow result", async () => {
		const host = createHost({
			required: { new: ["kontinuo"] },
			guards: { kontinuo: async () => ({ allow: true, resumeText: 1 }) },
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const result = await gate.run({ name: "new", text: "/new", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		expect(executed).toBe(0);
		expect(result).toEqual({
			status: "blocked",
			reason: 'Checkpoint blocked: guard "kontinuo" returned a malformed result.',
		});
	});

	it("never implicit-allows on deny, throw, missing registration, or undefined result", async () => {
		let executed = 0;
		const execute = async () => {
			executed += 1;
			return "ran";
		};

		const denied = new BuiltinCommandGate(
			createHost({
				required: { quit: ["kontinuo"] },
				guards: { kontinuo: async () => ({ allow: false, reason: "nope" }) },
			}),
		);
		expect(await denied.run({ name: "quit", text: "/quit", args: "" }, execute)).toEqual({
			status: "blocked",
			reason: "nope",
		});

		const thrown = new BuiltinCommandGate(
			createHost({
				required: { quit: ["kontinuo"] },
				guards: {
					kontinuo: async () => {
						throw new Error("boom");
					},
				},
			}),
		);
		const thrownResult = await thrown.run({ name: "quit", text: "/quit", args: "" }, execute);
		expect(thrownResult.status).toBe("blocked");

		const missing = new BuiltinCommandGate(createHost({ required: { quit: ["kontinuo"] }, guards: {} }));
		const missingResult = await missing.run({ name: "quit", text: "/quit", args: "" }, execute);
		expect(missingResult.status).toBe("blocked");
		if (missingResult.status === "blocked") {
			expect(missingResult.reason).toContain("not registered");
		}

		const malformed = new BuiltinCommandGate(
			createHost({
				required: { quit: ["kontinuo"] },
				guards: { kontinuo: async () => undefined },
			}),
		);
		const malformedResult = await malformed.run({ name: "quit", text: "/quit", args: "" }, execute);
		expect(malformedResult.status).toBe("blocked");
		if (malformedResult.status === "blocked") {
			expect(malformedResult.reason).toContain("malformed");
		}

		expect(executed).toBe(0);
		expect(denied.state).toBe("idle");
		expect(thrown.state).toBe("idle");
		expect(missing.state).toBe("idle");
		expect(malformed.state).toBe("idle");
	});

	it("does not enter executing after cancel, and late allow does not run the callback", async () => {
		let resolveGuard!: (result: BuiltinCommandGuardResult) => void;
		const pending = new Promise<BuiltinCommandGuardResult>(resolve => {
			resolveGuard = resolve;
		});
		const host = createHost({
			required: { restart: ["kontinuo"] },
			guards: { kontinuo: () => pending },
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const run = gate.run({ name: "restart", text: "/restart", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		await Bun.sleep(10);
		expect(gate.cancel()).toBe(true);
		resolveGuard({ allow: true });
		const result = await run;
		expect(result.status).toBe("blocked");
		if (result.status === "blocked") {
			expect(result.reason).toBe("Checkpoint cancelled; /restart was not run.");
		}
		expect(executed).toBe(0);
		expect(gate.state).toBe("idle");
	});

	it("rejects a second command while preparing and releases the lock after error", async () => {
		let resolveGuard!: (result: BuiltinCommandGuardResult) => void;
		const pending = new Promise<BuiltinCommandGuardResult>(resolve => {
			resolveGuard = resolve;
		});
		const host = createHost({
			required: { dump: ["kontinuo"] },
			guards: { kontinuo: () => pending },
		});
		const gate = new BuiltinCommandGate(host);
		const first = gate.run({ name: "dump", text: "/dump", args: "" }, async () => "one");
		const second = await gate.run({ name: "new", text: "/new", args: "" }, async () => "two");
		expect(second).toEqual({
			status: "blocked",
			reason: "Checkpoint already in progress; wait or cancel.",
		});
		resolveGuard({ allow: false, reason: "fail" });
		expect(await first).toEqual({ status: "blocked", reason: "fail" });
		expect(gate.state).toBe("idle");
		const third = await gate.run({ name: "new", text: "/new", args: "" }, async () => "three");
		expect(third).toEqual({ status: "executed", value: "three" });
	});

	it("blocks busy sessions and canonicalizes q to quit in the busy message", async () => {
		const gate = new BuiltinCommandGate(createHost({ busy: true }));
		const result = await gate.run({ name: "q", text: "/q", args: "" }, async () => "ran");
		expect(result).toEqual({
			status: "blocked",
			reason: "Checkpoint blocked: finish or abort active work, then retry /quit.",
		});
	});

	it("times out with an injectable shortened deadline and never runs the callback", async () => {
		testSetBuiltinCommandPrepTimeoutMs(40);
		const host = createHost({
			required: { compact: ["kontinuo"] },
			guards: {
				kontinuo: async event => {
					await Bun.sleep(80);
					if (event.signal.aborted) return { allow: false, reason: "aborted" };
					return { allow: true };
				},
			},
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const result = await gate.run({ name: "compact", text: "/compact", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		expect(result.status).toBe("blocked");
		if (result.status === "blocked") {
			expect(result.reason).toContain("deadline expired");
		}
		expect(executed).toBe(0);
		expect(gate.state).toBe("idle");
	});

	it("passes a remaining budget above the 30s extension-handler cap", async () => {
		const host = createHost({
			required: { dump: ["kontinuo"] },
			guards: { kontinuo: async () => ({ allow: true }) },
		});
		const gate = new BuiltinCommandGate(host);
		const result = await gate.run({ name: "dump", text: "/dump", args: "" }, async () => "ran");
		expect(result).toEqual({ status: "executed", value: "ran" });
		expect(host.lastTimeoutMs).toBeGreaterThan(30_000);
	});

	it("allows a preparation that lasts longer than 30 seconds", async () => {
		// Real delay: BuiltinCommandGate.admit uses a live setTimeout for the 120s
		// deadline, which fake timers cannot advance without also rewriting the gate.
		const host = createHost({
			required: { dump: ["kontinuo"] },
			guards: {
				kontinuo: async () => {
					await Bun.sleep(31_000);
					return { allow: true };
				},
			},
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const result = await gate.run({ name: "dump", text: "/dump", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		expect(result).toEqual({ status: "executed", value: "ran" });
		expect(executed).toBe(1);
	}, 40_000);

	it("blocks when the conversation leaf changes during preparation", async () => {
		let leafId: string | null = "msg-1";
		const host = createHost({
			required: { clear: ["kontinuo"] },
			identity: () => ({ cwd: "/tmp/project", sessionId: "sess-1", leafId }),
			guards: {
				kontinuo: async () => {
					leafId = "msg-2";
					return { allow: true };
				},
			},
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const result = await gate.run({ name: "clear", text: "/clear", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		expect(executed).toBe(0);
		expect(result).toEqual({
			status: "blocked",
			reason: "Checkpoint blocked: session identity changed during preparation.",
		});
	});

	it("allows preparation when only metadata leaf drift occurs and identity tracks conversation leaf", async () => {
		const conversationLeaf = "msg-2";
		const host = createHost({
			required: { clear: ["kontinuo"] },
			identity: () => ({ cwd: "/tmp/project", sessionId: "sess-1", leafId: conversationLeaf }),
			guards: { kontinuo: async () => ({ allow: true }) },
		});
		const gate = new BuiltinCommandGate(host);
		let executed = 0;
		const result = await gate.run({ name: "clear", text: "/clear", args: "" }, async () => {
			executed += 1;
			return "ran";
		});
		expect(result).toEqual({ status: "executed", value: "ran" });
		expect(executed).toBe(1);
	});

	it("admits synchronously so a duplicate RPC request cannot start a second job", () => {
		const host = createHost({
			required: { compact: ["kontinuo"] },
			guards: { kontinuo: async () => ({ allow: true }) },
		});
		const gate = new BuiltinCommandGate(host);
		const first = gate.admit({ name: "compact", text: "/compact", args: "" });
		const second = gate.admit({ name: "handoff", text: "/handoff", args: "" });
		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: false, reason: "Checkpoint already in progress; wait or cancel." });
		expect(gate.cancel()).toBe(true);
	});
});

describe("isBuiltinCommandGuardResult", () => {
	it("accepts allow:true with optional string resumeText", () => {
		expect(isBuiltinCommandGuardResult({ allow: true })).toBe(true);
		expect(isBuiltinCommandGuardResult({ allow: true, resumeText: "Kontinuo resume: id" })).toBe(true);
		expect(isBuiltinCommandGuardResult({ allow: true, resumeText: 1 })).toBe(false);
	});
});

describe("applyGuardResumeHandoff", () => {
	it("installs clear resume text and clears absent text", () => {
		const session: { stored?: string } = {};
		applyGuardResumeHandoff({
			commandName: "clear",
			resumeText: "Kontinuo resume: id-1",
			session: {
				setKontinuoResumeText: text => {
					session.stored = text;
				},
			},
		});
		expect(session.stored).toBe("Kontinuo resume: id-1");

		applyGuardResumeHandoff({
			commandName: "clear",
			resumeText: undefined,
			session: {
				setKontinuoResumeText: text => {
					session.stored = text;
				},
			},
		});
		expect(session.stored).toBeUndefined();
	});

	it("clears stored text on delete and new", () => {
		for (const commandName of ["delete", "new"] as const) {
			const session: { stored?: string } = { stored: "stale" };
			applyGuardResumeHandoff({
				commandName,
				resumeText: "Kontinuo resume: id",
				session: {
					setKontinuoResumeText: text => {
						session.stored = text;
					},
				},
			});
			expect(session.stored).toBeUndefined();
		}
	});

	it("ignores fresh, restart, dump, compact, and handoff", () => {
		for (const commandName of ["fresh", "restart", "dump", "compact", "handoff"] as const) {
			const session: { stored?: string } = { stored: "keep" };
			applyGuardResumeHandoff({
				commandName,
				resumeText: "Kontinuo resume: id",
				session: {
					setKontinuoResumeText: text => {
						session.stored = text;
					},
				},
			});
			expect(session.stored).toBe("keep");
		}
	});

	it("does not stage legacy OMP_KONTINUO_RESUME", () => {
		const env: NodeJS.ProcessEnv = {};
		applyGuardResumeHandoff({
			commandName: "restart",
			resumeText: "Kontinuo resume: leaked",
			session: {
				setKontinuoResumeText: () => {
					env.OMP_KONTINUO_RESUME = "should-not-write";
				},
			},
		});
		expect(env.OMP_KONTINUO_RESUME).toBeUndefined();
		expect(process.env.OMP_KONTINUO_RESUME).toBeUndefined();
	});
});
