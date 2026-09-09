import { describe, expect, it } from "bun:test";
import {
	type InputItem,
	type RequestBody,
	sanitizeCodexCallId,
	transformRequestBody,
} from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { createCodexModel } from "./helpers";

describe("OpenAI Codex call_id sanitization and 64-char limit", () => {
	it("leaves valid <=64 character call_ids untouched", () => {
		expect(sanitizeCodexCallId("call_1234567890")).toBe("call_1234567890");
		expect(sanitizeCodexCallId("call-abc_def-123")).toBe("call-abc_def-123");
	});

	it("sanitizes an 80-character call_id to length <= 64 with deterministic hash", () => {
		const raw80 = "call_" + "a".repeat(75);
		expect(raw80.length).toBe(80);

		const sanitized = sanitizeCodexCallId(raw80);
		expect(sanitized.length).toBeLessThanOrEqual(64);
		expect(/^[a-zA-Z0-9_-]+$/.test(sanitized)).toBe(true);

		// Deterministic
		expect(sanitizeCodexCallId(raw80)).toBe(sanitized);
	});

	it("strips newline and pipe delimiters from composite tool-call IDs", () => {
		const newlineId = "call-29d8e702-6ebe-4a54-8e74-c5baf40191db-0\nfc_c261ee8d-f7b3-9690-b257-fe38974a7da0_0";
		const pipeId = "call-29d8e702-6ebe-4a54-8e74-c5baf40191db-0|fc_c261ee8d-f7b3-9690-b257-fe38974a7da0_0";

		const sanitizedNewline = sanitizeCodexCallId(newlineId);
		const sanitizedPipe = sanitizeCodexCallId(pipeId);

		expect(sanitizedNewline).toBe("call-29d8e702-6ebe-4a54-8e74-c5baf40191db-0");
		expect(sanitizedPipe).toBe("call-29d8e702-6ebe-4a54-8e74-c5baf40191db-0");
		expect(sanitizedNewline.length).toBeLessThanOrEqual(64);
	});

	it("sanitizes all call_ids in request body input and preserves pairing", async () => {
		const longCallId = "call_" + "x".repeat(75); // 80 chars
		const newlineCallId = "call-3beb4b63-da41-43be-9d9e-ab6de73d451a-1532\nfc_7f6f19ef-e181-98a1-a109-b0be3568bf60_0";

		const body: RequestBody = {
			model: "gpt-6-astra",
			input: [
				{
					type: "function_call",
					call_id: longCallId,
					name: "bash",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: longCallId,
					output: "done",
				},
				{
					type: "function_call",
					call_id: newlineCallId,
					name: "read",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: newlineCallId,
					output: "content",
				},
			],
		};

		const model = createCodexModel("gpt-5.5");
		const transformed = await transformRequestBody(body, model);

		expect(transformed.input).toBeDefined();
		const input = transformed.input!;
		expect(input).toHaveLength(4);

		for (const item of input) {
			if (item.call_id) {
				expect(item.call_id.length).toBeLessThanOrEqual(64);
				expect(/^[a-zA-Z0-9_-]+$/.test(item.call_id)).toBe(true);
			}
		}

		// Verify paired call_ids match exactly between calls and outputs
		expect(input[0].call_id).toBe(input[1].call_id);
		expect(input[2].call_id).toBe(input[3].call_id);
	});

	it("end-to-end: converts session context with 80-char call_ids without exceeding 64 chars", async () => {
		const longId = "call_" + "z".repeat(75); // 80 chars
		const context: Context = {
			systemPrompt: ["You are a test assistant"],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: longId,
							name: "bash",
							arguments: { command: "ls" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: longId,
					toolName: "bash",
					content: [{ type: "text", text: "file.txt" }],
				},
			],
		};

		const model = createCodexModel("gpt-5.5");
		const body = await buildTransformedCodexRequestBody(model, context, undefined);

		expect(body.input).toBeDefined();
		for (let i = 0; i < body.input!.length; i++) {
			const item = body.input![i];
			if (item.call_id) {
				expect(item.call_id.length).toBeLessThanOrEqual(64);
				expect(/^[a-zA-Z0-9_-]+$/.test(item.call_id)).toBe(true);
			}
		}

		// Check tool call and output match
		const callItem = body.input!.find(i => i.type === "function_call");
		const outputItem = body.input!.find(i => i.type === "function_call_output");
		expect(callItem).toBeDefined();
		expect(outputItem).toBeDefined();
		expect(callItem!.call_id).toBe(outputItem!.call_id);
		expect(callItem!.call_id!.length).toBeLessThanOrEqual(64);
	});
});
