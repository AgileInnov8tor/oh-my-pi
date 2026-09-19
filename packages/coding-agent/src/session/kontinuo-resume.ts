export function nonemptyResumeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function applyGuardResumeHandoff(args: {
	commandName: string;
	resumeText: string | undefined;
	session: { setKontinuoResumeText?(text: string | undefined): void };
}): void {
	if (args.commandName === "clear") {
		args.session.setKontinuoResumeText?.(nonemptyResumeText(args.resumeText));
		return;
	}
	if (args.commandName === "delete" || args.commandName === "new") {
		args.session.setKontinuoResumeText?.(undefined);
	}
}
