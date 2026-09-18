export const KONTINUO_RESUME_ENV = "OMP_KONTINUO_RESUME";

export function nonemptyResumeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function consumeKontinuoResumeEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const text = nonemptyResumeText(env[KONTINUO_RESUME_ENV]);
	delete env[KONTINUO_RESUME_ENV];
	return text;
}

export function applyGuardResumeHandoff(args: {
	commandName: string;
	resumeText: string | undefined;
	session: { setKontinuoResumeText?(text: string | undefined): void };
	env?: NodeJS.ProcessEnv;
}): void {
	const text = nonemptyResumeText(args.resumeText);
	const env = args.env ?? process.env;
	if (args.commandName === "restart") {
		if (text) env[KONTINUO_RESUME_ENV] = text;
		else delete env[KONTINUO_RESUME_ENV];
		return;
	}
	if (args.commandName !== "new" && args.commandName !== "delete") return;
	args.session.setKontinuoResumeText?.(text);
}
