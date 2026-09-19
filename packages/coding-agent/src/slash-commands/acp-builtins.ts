import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandResult, SlashCommandRuntime } from "./types";
import { applyGuardResumeHandoff } from "../session/kontinuo-resume";

export type { AcpBuiltinSlashCommandResult } from "./types";

/**
 * All names (primary + aliases) that are reserved by ACP builtins. Used to
 * filter out extension commands that would shadow a builtin or its alias at
 * dispatch time (e.g. `models` is an alias for `/model`, so an extension
 * registering `models` would appear in the palette but execute the builtin).
 */
export const ACP_BUILTIN_RESERVED_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMANDS_INTERNAL.filter(c => c.handle !== undefined).flatMap(c => [c.name, ...(c.aliases ?? [])]),
);

/**
 * Whether an extension command named `name` would be captured by ACP builtin
 * dispatch before reaching the extension handler. Beyond exact name/alias
 * collisions, `parseSlashCommand` treats `:` as a name/args separator, so a
 * colon-namespaced name whose prefix is a handled builtin (e.g. `model:foo`)
 * executes the `/model` builtin with `foo` as args. Such names must not be
 * advertised to ACP clients.
 */
export function isAcpBuiltinShadowedName(name: string): boolean {
	if (ACP_BUILTIN_RESERVED_NAMES.has(name)) return true;
	const colon = name.indexOf(":");
	return colon !== -1 && ACP_BUILTIN_RESERVED_NAMES.has(name.slice(0, colon));
}

/**
 * Commands advertised to ACP clients. Entries without a text-mode `handle`
 * (e.g. `/quit`, `/login`, dashboards) are filtered out so the client doesn't
 * see commands it cannot drive.
 */
export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
	command => command.handle !== undefined,
).map(command => {
	// Honor mode-specific copy: ACP clients receive concise text-mode
	// descriptions/hints when the spec sets `acpDescription` / `acpInputHint`,
	// otherwise fall back to the unified `description` / `inlineHint`.
	const hint = command.acpInputHint ?? command.inlineHint;
	return {
		name: command.name,
		description: command.acpDescription ?? command.description,
		input: hint ? { hint } : undefined,
	};
});

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no builtin matched (or matched a TUI-only entry); the caller
 *   should forward the input as a prompt.
 * - `{ consumed: true }` when the command handled the input entirely.
 * - `{ prompt }` when the command was handled but a residual prompt should be
 *   sent to the model.
 */
export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) return false;
	const request = { name: command.name, text, args: parsed.args };
	const handleInline = async (inlineRuntime: SlashCommandRuntime): Promise<SlashCommandResult> =>
		(await command.handle!(parsed, inlineRuntime)) ?? undefined;
	const session = runtime.session as {
		runBuiltinCommand?: (
			request: { name: string; text: string; args: string },
			execute: (handoff?: { resumeText?: string }) => Promise<SlashCommandResult>,
			options?: { preAdmitted?: boolean },
		) => Promise<
			{ status: "executed"; value: SlashCommandResult; resumeText?: string } | { status: "blocked"; reason: string }
		>;
		admitBuiltinCommand?: (request: {
			name: string;
			text: string;
			args: string;
		}) => { ok: true } | { ok: false; reason: string };
	};

	if (typeof session.runBuiltinCommand !== "function") {
		const result = await command.handle(parsed, runtime);
		if (result === undefined) return { consumed: true };
		return result;
	}

	if (runtime.runCommandInBackground) {
		if (typeof session.admitBuiltinCommand !== "function") {
			await runtime.output("Checkpoint blocked: builtin command guard admission is not available.");
			return { consumed: true };
		}
		const admitted = session.admitBuiltinCommand(request);
		if (!admitted.ok) {
			await runtime.output(admitted.reason);
			return { consumed: true };
		}
		const { runCommandInBackground: _ignored, ...inlineRuntime } = runtime;
		runtime.runCommandInBackground(async () => {
			const gated = await session.runBuiltinCommand!(
				request,
				handoff => {
					applyGuardResumeHandoff({
						commandName: command.name,
						resumeText: handoff?.resumeText,
						session: inlineRuntime.session,
					});
					return handleInline(inlineRuntime);
				},
				{
					preAdmitted: true,
				},
			);
			if (gated.status === "blocked") {
				await runtime.output(gated.reason);
			}
		});
		return { consumed: true };
	}

	const gated = await session.runBuiltinCommand(request, handoff => {
		applyGuardResumeHandoff({
			commandName: command.name,
			resumeText: handoff?.resumeText,
			session: runtime.session,
		});
		return handleInline(runtime);
	});
	if (gated.status === "blocked") {
		await runtime.output(gated.reason);
		return { consumed: true };
	}
	if (gated.value === undefined) return { consumed: true };
	return gated.value;
}
