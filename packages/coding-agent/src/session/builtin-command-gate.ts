import type {
	BuiltinCommandGuardContext,
	BuiltinCommandGuardEvent,
	BuiltinCommandGuardHandler,
	BuiltinCommandGuardResult,
} from "../extensibility/extensions/types";
import { canonicalBuiltinCommandName, normalizeBuiltinCommandGuards } from "../slash-commands/builtin-registry";
import type { SessionEntry } from "./session-entries";
import { nonemptyResumeText } from "./kontinuo-resume";

export const BUILTIN_COMMAND_PREP_TIMEOUT_MS = 120_000;

let builtinCommandPrepTimeoutMs = BUILTIN_COMMAND_PREP_TIMEOUT_MS;

/** Test-only: shorten the total preparation deadline. Restore with undefined. */
export function testSetBuiltinCommandPrepTimeoutMs(ms: number | undefined): void {
	builtinCommandPrepTimeoutMs = ms ?? BUILTIN_COMMAND_PREP_TIMEOUT_MS;
}

export function getBuiltinCommandPrepTimeoutMs(): number {
	return builtinCommandPrepTimeoutMs;
}

export type BuiltinCommandRequest = {
	name: string;
	text: string;
	args: string;
};

export type BuiltinCommandRunResult<T> =
	| { status: "executed"; value: T; resumeText?: string }
	| { status: "blocked"; reason: string };

export type BuiltinCommandGateState = "idle" | "preparing" | "executing";

export type BuiltinCommandIdentity = {
	cwd: string;
	sessionId: string;
	leafId: string | null;
};

export interface BuiltinCommandGateHost {
	isBusy(): boolean;
	identity(): BuiltinCommandIdentity;
	requiredGuardIds(canonicalName: string): { ok: true; ids: string[] } | { ok: false; reason: string };
	hasGuard(id: string): boolean;
	invokeGuard(
		id: string,
		event: BuiltinCommandGuardEvent,
		ctx: BuiltinCommandGuardContext,
		timeoutMs: number,
	): Promise<BuiltinCommandGuardResult>;
	createContext(event: BuiltinCommandGuardEvent): BuiltinCommandGuardContext;
	reportAdmission(canonicalName: string): void;
	now(): number;
}

type PrepSlot = {
	name: string;
	requestId: string;
	identity: BuiltinCommandIdentity;
	deadlineAt: number;
	controller: AbortController;
	timer: ReturnType<typeof setTimeout>;
	event: BuiltinCommandGuardEvent;
};

export class BuiltinCommandGate {
	#state: BuiltinCommandGateState = "idle";
	#prep: PrepSlot | undefined;
	#inRun = false;

	constructor(private readonly host: BuiltinCommandGateHost) {}

	get state(): BuiltinCommandGateState {
		return this.#state;
	}

	get isPreparing(): boolean {
		return this.#state === "preparing";
	}

	get isActive(): boolean {
		return this.#state !== "idle";
	}

	get preparingCommandName(): string | undefined {
		return this.#prep?.name;
	}

	admit(request: BuiltinCommandRequest): { ok: true; event: BuiltinCommandGuardEvent } | { ok: false; reason: string } {
		const canonical = canonicalBuiltinCommandName(request.name) ?? request.name;
		if (this.#state !== "idle") {
			return { ok: false, reason: "Checkpoint already in progress; wait or cancel." };
		}
		if (this.host.isBusy()) {
			return { ok: false, reason: `Checkpoint blocked: finish or abort active work, then retry /${canonical}.` };
		}
		const identity = this.host.identity();
		const now = this.host.now();
		const timeoutMs = getBuiltinCommandPrepTimeoutMs();
		const deadlineAt = now + timeoutMs;
		const controller = new AbortController();
		const requestId = crypto.randomUUID();
		const timer = setTimeout(() => {
			controller.abort("timeout");
		}, timeoutMs);
		timer.unref?.();
		const event: BuiltinCommandGuardEvent = {
			name: canonical,
			text: request.text,
			args: request.args,
			requestId,
			cwd: identity.cwd,
			sessionId: identity.sessionId,
			leafId: identity.leafId,
			deadlineAt,
			signal: controller.signal,
		};
		this.#state = "preparing";
		this.#prep = { name: canonical, requestId, identity, deadlineAt, controller, timer, event };
		this.host.reportAdmission(canonical);
		return { ok: true, event };
	}

	cancel(): boolean {
		if (this.#state !== "preparing" || !this.#prep) return false;
		this.#prep.controller.abort("cancel");
		if (!this.#inRun) this.#release();
		return true;
	}

	async run<T>(
		request: BuiltinCommandRequest,
		execute: (handoff?: { resumeText?: string }) => Promise<T>,
		options?: { preAdmitted?: boolean },
	): Promise<BuiltinCommandRunResult<T>> {
		let event: BuiltinCommandGuardEvent;
		if (options?.preAdmitted) {
			if (this.#state !== "preparing" || !this.#prep) {
				return { status: "blocked", reason: "Checkpoint already in progress; wait or cancel." };
			}
			event = this.#prep.event;
		} else {
			const admitted = this.admit(request);
			if (!admitted.ok) return { status: "blocked", reason: admitted.reason };
			event = admitted.event;
		}

		this.#inRun = true;
		try {
			const guards = await this.#runGuards(event);
			if (guards.blocked) return guards.blocked;

			if (this.#prep) clearTimeout(this.#prep.timer);
			const abortReason = this.#abortBlockReason(event.name, event.signal);
			if (abortReason) return abortReason;
			const identityBlock = this.#identityBlock();
			if (identityBlock) return identityBlock;

			this.#state = "executing";
			this.#prep = undefined;
			const resumeText = guards.resumeText;
			const value = await execute(resumeText ? { resumeText } : undefined);
			return resumeText ? { status: "executed", value, resumeText } : { status: "executed", value };
		} catch (error) {
			if (this.#state === "preparing") {
				return { status: "blocked", reason: this.#safeError(error) };
			}
			throw error;
		} finally {
			this.#inRun = false;
			this.#release();
		}
	}

	async #runGuards(
		event: BuiltinCommandGuardEvent,
	): Promise<{ blocked: BuiltinCommandRunResult<never> } | { blocked?: undefined; resumeText?: string }> {
		const required = this.host.requiredGuardIds(event.name);
		if (!required.ok) return { blocked: { status: "blocked", reason: required.reason } };

		let resumeText: string | undefined;
		for (const id of required.ids) {
			const abortReason = this.#abortBlockReason(event.name, event.signal);
			if (abortReason) return { blocked: abortReason };
			const identityBlock = this.#identityBlock();
			if (identityBlock) return { blocked: identityBlock };

			const remainingMs = event.deadlineAt - this.host.now();
			if (remainingMs <= 0) {
				return { blocked: { status: "blocked", reason: "Checkpoint blocked: preparation deadline expired." } };
			}
			if (!this.host.hasGuard(id)) {
				return {
					blocked: {
						status: "blocked",
						reason: `Checkpoint blocked: required guard "${id}" is not registered.`,
					},
				};
			}

			const ctx = this.host.createContext(event);
			const result = await this.host.invokeGuard(id, event, ctx, remainingMs);
			const afterAbort = this.#abortBlockReason(event.name, event.signal);
			if (afterAbort) return { blocked: afterAbort };
			const afterIdentity = this.#identityBlock();
			if (afterIdentity) return { blocked: afterIdentity };

			if (!isBuiltinCommandGuardResult(result)) {
				return {
					blocked: {
						status: "blocked",
						reason: `Checkpoint blocked: guard "${id}" returned a malformed result.`,
					},
				};
			}
			if (!result.allow) {
				return { blocked: { status: "blocked", reason: result.reason } };
			}
			const next = nonemptyResumeText(result.resumeText);
			if (next) resumeText = next;
		}
		return { resumeText };
	}

	#abortBlockReason(name: string, signal?: AbortSignal): BuiltinCommandRunResult<never> | undefined {
		const aborted = signal ?? this.#prep?.controller.signal;
		if (!aborted?.aborted) return undefined;
		if (aborted.reason === "timeout") {
			return { status: "blocked", reason: "Checkpoint blocked: preparation deadline expired." };
		}
		return { status: "blocked", reason: `Checkpoint cancelled; /${name} was not run.` };
	}

	#identityBlock(): BuiltinCommandRunResult<never> | undefined {
		if (!this.#prep) return undefined;
		const current = this.host.identity();
		const expected = this.#prep.identity;
		if (
			current.cwd !== expected.cwd ||
			current.sessionId !== expected.sessionId ||
			current.leafId !== expected.leafId
		) {
			return { status: "blocked", reason: "Checkpoint blocked: session identity changed during preparation." };
		}
		return undefined;
	}

	#safeError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return `Checkpoint blocked: ${message}`;
	}

	#release(): void {
		if (this.#prep) {
			clearTimeout(this.#prep.timer);
			this.#prep = undefined;
		}
		this.#state = "idle";
	}
}

export function requiredGuardIdsFromSettings(
	mapping: unknown,
	canonicalName: string,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
	const normalized = normalizeBuiltinCommandGuards(mapping);
	if (!normalized.ok) {
		return { ok: false, reason: `Checkpoint blocked: ${normalized.error}` };
	}
	return { ok: true, ids: normalized.value[canonicalName] ?? [] };
}

export function isBuiltinCommandGuardResult(value: unknown): value is BuiltinCommandGuardResult {
	if (!value || typeof value !== "object") return false;
	const result = value as { allow?: unknown; reason?: unknown; resumeText?: unknown };
	if (result.allow === true) {
		return result.resumeText === undefined || typeof result.resumeText === "string";
	}
	return result.allow === false && typeof result.reason === "string" && result.reason.length > 0;
}

export function composeGuardSignals(event: BuiltinCommandGuardEvent, signal: AbortSignal): AbortSignal {
	if (event.signal === signal) return signal;
	return AbortSignal.any([event.signal, signal]);
}

export type { BuiltinCommandGuardContext, BuiltinCommandGuardEvent, BuiltinCommandGuardHandler };
