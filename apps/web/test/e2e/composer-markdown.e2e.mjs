/** Real Chrome checks for the composer's Markdown preview and formatting shortcuts, with a local client fixture. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureId = join(webRoot, "client", "composer-markdown-fixture.tsx").replaceAll("\\", "/");
const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
	"C:/Program Files/Google/Chrome/Application/chrome.exe"].find((path) => path && existsSync(path));
const skip = chromePath ? false : "No installed Chrome; set CHROME_PATH";
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import "/src/styles/global.css";
import {IconSprite} from "/src/ui";
import {Composer} from "/src/features/composer/index.tsx";
import {ShellEffects} from "/src/features/shell/ShellEffects.tsx";
import {createInitialState, getState, setState} from "/src/state/store.ts";
import {promptText} from "/src/features/composer/prompt-editor.ts";
import {htmlToMarkdown} from "/src/features/composer/html-to-markdown.ts";
setState({...createInitialState(),bootstrapCwd:"/fixture",draftCwd:"/fixture",locale:"en-US"});
window.fixture = {getState, setState, promptText, htmlToMarkdown};
createRoot(document.getElementById("root")).render(<><IconSprite/><ShellEffects/><div className="composer-zone"><Composer/></div></>);
`;
let vite;
let browser;
let url;
before(async () => {
	if (skip) return;
	vite = await createServer({
		configFile: join(webRoot, "vite.config.ts"), root: join(webRoot, "client"),
		server: { host: "127.0.0.1", port: 0, proxy: {} },
		plugins: [{
			name: "composer-markdown-regression",
			resolveId(id) { if (id === "/composer-markdown-fixture.js" || id === fixtureId) return fixtureId; },
			load(id) { if (id === fixtureId) return fixture; },
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== "/composer-markdown-fixture") return next();
					res.setHeader("Content-Type", "text/html");
					res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>#root{display:flex;align-items:flex-end;height:100vh;width:100%;} .composer-zone{width:100%;}</style></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/composer-markdown-fixture.js"></script></body></html>`);
				});
			},
		}],
	});
	await vite.listen();
	url = `http://127.0.0.1:${vite.httpServer.address().port}/composer-markdown-fixture`;
	browser = await chromium.launch({ executablePath: chromePath, headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

async function pageFixture() {
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
	await page.route("**/api/**", (route) => route.fulfill({ json: { models: [], skills: [], servers: [] } }));
	await page.goto(url);
	await page.waitForFunction(() => window.fixture && document.querySelector("#prompt"));
	return page;
}

/** Replace the prompt with plain text and select [start, end). */
async function setPrompt(page, text, start = text.length, end = start) {
	await page.evaluate(({ text, start, end }) => {
		const editor = document.querySelector("#prompt");
		editor.replaceChildren(document.createTextNode(text));
		editor.focus();
		const range = document.createRange();
		range.setStart(editor.firstChild, start);
		range.setEnd(editor.firstChild, end);
		getSelection().removeAllRanges();
		getSelection().addRange(range);
		editor.dispatchEvent(new Event("input", { bubbles: true }));
	}, { text, start, end });
}
const promptValue = (page) => page.evaluate(() => window.fixture.promptText(document.querySelector("#prompt")));
const toggle = (page) => page.locator(".prompt-preview-toggle");
const preview = (page) => page.locator(".prompt-preview");

async function pressMod(page, key) {
	await page.evaluate((key) => {
		document.querySelector("#prompt").dispatchEvent(new KeyboardEvent("keydown", {
			key, metaKey: true, bubbles: true, cancelable: true,
		}));
	}, key);
}

test("the toggle renders the draft as Markdown and Escape returns to the editor", { skip }, async () => {
	const page = await pageFixture();
	try {
		const draft = "**加粗** 和 *斜体* 与 ~~删除~~\n\n# 标题\n\n- 列表";
		await setPrompt(page, draft);
		await toggle(page).click();
		await preview(page).waitFor();
		assert.equal(await preview(page).locator("strong").textContent(), "加粗");
		assert.equal(await preview(page).locator("em").textContent(), "斜体");
		assert.equal(await preview(page).locator("del").textContent(), "删除");
		assert.equal(await preview(page).locator("h2").textContent(), "标题");
		assert.equal(await preview(page).locator(".md-li").textContent(), "列表");
		// The editor keeps the text (only hidden), so the send path still reads it.
		assert.equal(await promptValue(page), draft);
		await page.waitForFunction(() => document.activeElement?.classList.contains("prompt-preview"));
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector(".prompt-preview"));
		assert.equal(await promptValue(page), draft);
		assert.equal(await page.evaluate(() => document.activeElement.id), "prompt");
	} finally { await page.close(); }
});

test("clicking rendered text returns to editing, links keep their own click", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "# 标题\n\n[文档](https://example.com)");
		await toggle(page).click();
		await preview(page).waitFor();
		await preview(page).locator("a").click();
		assert.equal(await preview(page).count(), 1, "a link click must not close the preview");
		await preview(page).locator("h2").click();
		await page.waitForFunction(() => !document.querySelector(".prompt-preview"));
	} finally { await page.close(); }
});

test("Cmd/Ctrl+B and I wrap and unwrap the selection with Markdown markers", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "make this bold", 5, 9);
		await pressMod(page, "b");
		assert.equal(await promptValue(page), "make **this** bold");
		await pressMod(page, "b");
		assert.equal(await promptValue(page), "make this bold");
		await pressMod(page, "i");
		assert.equal(await promptValue(page), "make *this* bold");
		// Inline code around a word renders in the preview.
		await setPrompt(page, "run now", 0, 3);
		await pressMod(page, "e");
		assert.equal(await promptValue(page), "`run` now");
		await toggle(page).click();
		await preview(page).waitFor();
		assert.equal(await preview(page).locator("code").textContent(), "run");
	} finally { await page.close(); }
});

test("Cmd/Ctrl+K links a selection but leaves a bare shortcut to the global search", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "see docs here", 4, 8);
		await pressMod(page, "k");
		assert.equal(await promptValue(page), "see [docs](url) here");
		assert.equal(await page.evaluate(() => getSelection().toString()), "url");
		await setPrompt(page, "no selection");
		await pressMod(page, "k");
		assert.equal(await promptValue(page), "no selection");
	} finally { await page.close(); }
});

test("Enter in the preview submits and Cmd/Ctrl+Enter steers", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "**发送我**");
		await toggle(page).click();
		await preview(page).waitFor();
		await page.evaluate(() => {
			window.__submits = 0;
			document.querySelector("#composer").addEventListener("submit", (event) => {
				event.preventDefault();
				event.stopPropagation();
				window.__submits += 1;
			}, { capture: true });
		});
		await page.waitForFunction(() => document.activeElement?.classList.contains("prompt-preview"));
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => window.__submits === 1);
		assert.equal(await promptValue(page), "**发送我**");
	} finally { await page.close(); }
});

test("an empty draft disables the toggle", { skip }, async () => {
	const page = await pageFixture();
	try {
		assert.equal(await toggle(page).isDisabled(), true);
		await setPrompt(page, "text");
		assert.equal(await toggle(page).isDisabled(), false);
	} finally { await page.close(); }
});

test("HTML paste conversion keeps blocks, inline marks, tables and app-rendered Markdown", { skip }, async () => {
	const page = await pageFixture();
	try {
		const cases = [
			["<p>Hello <b>bold</b> and <i>it</i></p>", "Hello **bold** and *it*"],
			["<h2>Title</h2><p>text</p>", "## Title\n\ntext"],
			["<ul><li>one</li><li>two <code>x</code></li></ul>", "- one\n- two `x`"],
			["<ol start=\"3\"><li>three</li><li>four</li></ol>", "3. three\n4. four"],
			["<ul><li>a<ul><li>b</li></ul></li></ul>", "- a\n  - b"],
			["<blockquote><p>quote</p></blockquote>", "> quote"],
			["<pre><code class=\"language-ts\">const a = 1;\n</code></pre>", "```ts\nconst a = 1;\n```"],
			["<p><a href=\"https://example.com\">docs</a> and <a href=\"/local\">x</a></p>", "[docs](https://example.com) and x"],
			["<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>", "| A | B |\n| --- | --- |\n| 1 | 2 |"],
			["<p><button>复制</button><script>bad()</script><svg><path/></svg><img alt=\"pic\" src=\"https://x/p.png\"></p>", "pic"],
			["<div class=\"code-block\"><div class=\"code-block-header\"><span>ts</span><button class=\"copy-code\">Copy</button></div><pre><code>const x = 1;</code></pre></div>", "```\nconst x = 1;\n```"],
			["<p><b>keep</b> <del>gone</del> <code>a`b</code></p>", "**keep** ~~gone~~ ``a`b``"],
			["<p>first<span class=\"md-gap\"></span>second</p>", "first\n\nsecond"],
		];
		for (const [html, expected] of cases) {
			const actual = await page.evaluate((html) => window.fixture.htmlToMarkdown(html), html);
			assert.equal(actual, expected, html);
		}
		assert.equal(await page.evaluate(() => window.fixture.htmlToMarkdown("")), null);
	} finally { await page.close(); }
});

async function paste(page, { html, text, file }) {
	await page.evaluate(({ html, text, file }) => {
		const editor = document.querySelector("#prompt");
		editor.focus();
		const transfer = new DataTransfer();
		if (file) transfer.items.add(new File(["img"], file, { type: "image/png" }));
		if (html) transfer.setData("text/html", html);
		if (text) transfer.setData("text/plain", text);
		editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
	}, { html, text, file });
}

test("pasting rich text inserts Markdown; an Office copy keeps its plain text", { skip }, async () => {
	const page = await pageFixture();
	try {
		await setPrompt(page, "");
		await paste(page, {
			html: "<p>Hello <b>bold</b> and <a href=\"https://example.com\">docs</a></p>",
			text: "Hello bold and docs",
		});
		assert.equal(await promptValue(page), "Hello **bold** and [docs](https://example.com)");
		// Word/Excel pair the rich text with a rendered image file: the text wins.
		await setPrompt(page, "");
		await paste(page, { html: "<p><b>rich</b></p>", text: "plain rich", file: "image.png" });
		assert.equal(await promptValue(page), "plain rich");
	} finally { await page.close(); }
});
