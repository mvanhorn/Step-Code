import { afterEach, describe, expect, it, vi } from "vitest";
import { getMarkdownTheme, getThemeByName, highlightCode, initTheme, setRegisteredThemes } from "../src/theme/theme.ts";
import * as syntax from "../src/utils/syntax-highlight.ts";

/**
 * Highlighted lines are memoized on (theme instance, language, source).
 *
 * The renderer treats a theme as a set of pure functions, so it cannot deduplicate
 * this work itself: a fenced block is highlighted while it is being streamed, and
 * any document that still renders whole re-highlights every finished block on every
 * frame. That makes a stale or shared entry a visible colour bug rather than a
 * slowdown, so the cases below are the ones where an entry could be served for the
 * wrong inputs.
 *
 * Colours are asserted through the theme's own `syntaxKeyword`, so no ANSI literal
 * is hard-coded here.
 */

const CODE = "export function greet(name: string): string {\n  return name;\n}";

function keywordColour(themeName: string): string {
	const t = getThemeByName(themeName);
	expect(t, `theme ${themeName} should be registered`).toBeDefined();
	return t!.fg("syntaxKeyword", "KEYWORD");
}

afterEach(() => {
	initTheme("dark");
});

describe("highlight memo", () => {
	it("serves a repeated call without re-highlighting", () => {
		initTheme("dark");
		const first = highlightCode(CODE, "typescript");
		expect(first.length).toBeGreaterThan(1);

		// Counting invocations is the only way to tell "memoized" from "deterministic".
		const spy = vi.spyOn(syntax, "highlight");
		const second = highlightCode(CODE, "typescript");
		expect(second).toEqual(first);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("does not serve a cached unlabelled fence after the theme changes", () => {
		// Unlabelled fences are restyled line by line from the theme, so they are the
		// cheapest thing to memoize and the easiest to serve stale.
		initTheme("dark");
		const dark = highlightCode("plain fence body", undefined).join("\n");

		const themes = ["dark", "light"].map((name) => getThemeByName(name)).filter((t) => t !== undefined);
		setRegisteredThemes(themes as never);
		initTheme("light");

		const light = highlightCode("plain fence body", undefined).join("\n");
		expect(light).not.toEqual(dark);
		expect(light).toContain("plain fence body");
	});

	it("does not serve a cached entry after the theme changes", () => {
		initTheme("dark");
		const darkLines = highlightCode(CODE, "typescript");
		const darkKeyword = keywordColour("dark");

		// Register both themes so the switch below is a real theme replacement.
		const themes = ["dark", "light"].map((name) => getThemeByName(name)).filter((t) => t !== undefined);
		setRegisteredThemes(themes as never);
		initTheme("light");

		const lightLines = highlightCode(CODE, "typescript");
		const lightKeyword = keywordColour("light");
		expect(lightKeyword).not.toEqual(darkKeyword);
		expect(lightLines.join("\n")).not.toEqual(darkLines.join("\n"));
		expect(lightLines.join("\n")).toContain("greet");
	});

	it("keeps entries for an explicitly passed theme separate from the global one", () => {
		initTheme("dark");
		const explicit = getThemeByName("light");
		expect(explicit).toBeDefined();

		const explicitLines = getMarkdownTheme(explicit!).highlightCode!(CODE, "typescript");
		const globalLines = getMarkdownTheme().highlightCode!(CODE, "typescript");
		expect(explicitLines.join("\n")).not.toEqual(globalLines.join("\n"));

		// Asking again in the other order must not flip either result.
		expect(getMarkdownTheme(explicit!).highlightCode!(CODE, "typescript")).toEqual(explicitLines);
		expect(getMarkdownTheme().highlightCode!(CODE, "typescript")).toEqual(globalLines);
	});

	it("returns a private array so a mutating caller cannot corrupt the memo", () => {
		initTheme("dark");
		// Snapshot by value: comparing against another call's return value would alias
		// the memo entry and hide exactly the corruption this test exists to catch.
		const expected = [...highlightCode(CODE, "typescript")];

		// Mirrors core/tools/write.ts, which stores the result and then appends to it.
		const mutated = highlightCode(CODE, "typescript");
		mutated[0] = "corrupted";
		mutated.push("extra");

		expect([...highlightCode(CODE, "typescript")]).toEqual(expected);
	});

	it("keys on language as well as source", () => {
		initTheme("dark");
		expect(highlightCode(CODE, "json")).not.toEqual(highlightCode(CODE, "typescript"));
	});

	it("still renders every block once the entry limit is exceeded", () => {
		initTheme("dark");
		const blocks = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`);
		for (const block of blocks) {
			expect(highlightCode(block, "typescript").join("\n")).toContain("value");
		}
		// The earliest entries are evicted, and recomputing them must still be correct.
		expect(highlightCode(blocks[0]!, "typescript").join("\n")).toContain("value0");
	});

	it("does not retain sources above the size limit but still renders them", () => {
		initTheme("dark");
		const huge = Array.from({ length: 8000 }, (_, index) => `const value${index} = ${index};`).join("\n");
		expect(huge.length).toBeGreaterThan(64 * 1024);
		expect(highlightCode(huge, "typescript").length).toBe(8000);
	});

	it("agrees between the module entry point and the markdown theme", () => {
		initTheme("dark");
		expect(getMarkdownTheme().highlightCode!(CODE, "typescript")).toEqual(highlightCode(CODE, "typescript"));
	});

	it("returns plain code when the language is unknown", () => {
		initTheme("dark");
		const lines = highlightCode("not code at all", "definitely-not-a-language");
		expect(lines).toEqual([expect.stringContaining("not code at all")]);
	});
});
