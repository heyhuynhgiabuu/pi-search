import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext7Tool } from "../../src/tools/context7.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

describe("context7 tool", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) delete process.env[key];
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
	});

	it("has the expected schema and label", () => {
		const tool = createContext7Tool({} as never);
		expect(tool.name).toBe("context7");
		expect(tool.label).toBe("Context7 Docs");
	});

	it("rejects missing libraryName with validation_error", async () => {
		const tool = createContext7Tool({} as never);
		const result = await tool.execute("id", {}, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
		expect((result.details as { error: { message: string } }).error.message).toMatch(/libraryName/);
	});

	it("resolves library ID then fetches docs", async () => {
		const mockFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ results: [{ id: "/reactjs/react.dev", title: "React" }] }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: "# Hooks\nuseState...",
						metadata: { title: "React Hooks", url: "https://react.dev" },
					}),
					{ status: 200 },
				),
			);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const tool = createContext7Tool({} as never);
		const result = await tool.execute("id", { libraryName: "react", topic: "hooks" }, undefined, undefined);
		expect(result.content[0].text).toContain("useState");
		expect((result.details as { libraryId: string }).libraryId).toBe("/reactjs/react.dev");
	});

	it("respects context7 disabledTools", async () => {
		process.env.PI_SEARCH_DISABLED_TOOLS = "context7";
		const tool = createContext7Tool({} as never);
		const result = await tool.execute("id", { libraryName: "react" }, undefined, undefined);
		expect((result.details as { error: { code: string } }).error.code).toBe("validation_error");
	});
});
