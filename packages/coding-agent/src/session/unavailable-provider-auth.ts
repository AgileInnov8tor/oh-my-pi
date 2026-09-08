/**
 * Classify why getApiKey returned nothing: missing grant vs stored-but-blocked.
 * Blocked OAuth must not tell the user to /login.
 */
import type { AuthStorage } from "./auth-storage";

export type UnavailableProviderAuth =
	| { kind: "missing"; provider: string }
	| { kind: "blocked"; provider: string; retryAtMs: number; emails: string[] }
	| { kind: "stored-unusable"; provider: string; emails: string[] };

function oauthEmails(storage: AuthStorage, provider: string): string[] {
	const emails: string[] = [];
	for (const row of storage.listStoredCredentials(provider)) {
		if (row.credential.type !== "oauth") continue;
		const email = row.credential.email?.trim();
		if (email && !emails.includes(email)) emails.push(email);
	}
	return emails;
}

export function inspectUnavailableProviderAuth(
	storage: AuthStorage,
	provider: string,
	nowMs = Date.now(),
): UnavailableProviderAuth {
	const oauthRows = storage.listStoredCredentials(provider).filter(row => row.credential.type === "oauth");
	if (oauthRows.length === 0) {
		return { kind: "missing", provider };
	}
	const emails = oauthEmails(storage, provider);
	const blocks = storage
		.listCredentialBlocks(oauthRows.map(row => row.id))
		.filter(block => block.blockedUntilMs > nowMs);
	const blockedIds = new Set(blocks.map(block => block.credentialId));
	if (oauthRows.every(row => blockedIds.has(row.id)) && blocks.length > 0) {
		return {
			kind: "blocked",
			provider,
			retryAtMs: Math.min(...blocks.map(block => block.blockedUntilMs)),
			emails,
		};
	}
	return { kind: "stored-unusable", provider, emails };
}

export function formatUnavailableProviderAuth(
	reason: UnavailableProviderAuth,
	agentDbPath: string,
	nowMs = Date.now(),
): string {
	if (reason.kind === "missing") {
		return (
			`No API key found for ${reason.provider}.\n\n` +
			`Use /login, set an API key environment variable, or create ${agentDbPath}`
		);
	}
	const account =
		reason.emails.length > 0
			? ` Account still signed in (${reason.emails.join(", ")}).`
			: " An OAuth account is still stored.";
	if (reason.kind === "blocked") {
		const remainingMin = Math.max(1, Math.ceil(Math.max(0, reason.retryAtMs - nowMs) / 60_000));
		return (
			`${reason.provider} is rate-limited until ${new Date(reason.retryAtMs).toISOString()} (~${remainingMin}m).` +
			account +
			" Do not /login — wait, or switch model."
		);
	}
	return (
		`${reason.provider} has a stored OAuth grant but no usable token right now.` +
		account +
		` Do not /login unless \`omp token ${reason.provider} --list\` is empty. Retry shortly, or switch model.`
	);
}

export function unavailableProviderAuthMessage(
	storage: AuthStorage,
	provider: string,
	agentDbPath: string,
	nowMs = Date.now(),
): string {
	return formatUnavailableProviderAuth(inspectUnavailableProviderAuth(storage, provider, nowMs), agentDbPath, nowMs);
}
