import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../client/src/lib/markdown.ts";

const labels = { code: "Code", copy: "Copy" };

test("renders named sources with escaped URLs and safe new-tab attributes", () => {
	const html = renderMarkdown("- [今日金价](https://example.com/price?a=1&b=2)", labels);
	assert.equal(
		html,
		'<span class="md-li"><a href="https://example.com/price?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">今日金价</a></span>',
	);
});

test("supports parentheses in destinations and bare URLs beside punctuation", () => {
	const html = renderMarkdown(
		"[Source](https://example.com/wiki/Gold_(metal)) (https://example.com/price). https://example.com/报价。",
		labels,
	);
	assert.match(html, /href="https:\/\/example.com\/wiki\/Gold_\(metal\)"/);
	assert.match(html, /href="https:\/\/example.com\/price"[^>]*>https:\/\/example.com\/price<\/a>\)\./);
	assert.match(html, /href="https:\/\/example.com\/报价"[^>]*>https:\/\/example.com\/报价<\/a>。/);
});

test("preserves inline and fenced code without links or emphasis", () => {
	const html = renderMarkdown(
		"`[**Source**](https://example.com)`\n\n```md\n[Source](https://example.com)\n```",
		labels,
	);
	assert.doesNotMatch(html, /<a |<strong>/);
	assert.match(html, /<code>\[\*\*Source\*\*\]\(https:\/\/example.com\)<\/code>/);
	assert.match(html, /<pre><code>\[Source\]\(https:\/\/example.com\)<\/code><\/pre>/);
});

test("rejects executable and local destinations while escaping HTML and attributes", () => {
	for (const url of ["javascript:alert(1)", "data:text/html,evil", "file:///tmp/example", "//example.com"]) {
		assert.doesNotMatch(renderMarkdown(`[Source](${url})`, labels), /<a /);
	}
	const html = renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com/"onclick="evil)', labels);
	assert.doesNotMatch(html, /<img|"onclick=/);
	assert.match(html, /&lt;img/);
	assert.match(html, /&quot;onclick=&quot;/);
});

test("handles incomplete streaming Markdown and keeps surrounding formatting", () => {
	assert.equal(renderMarkdown("[Source](https://", labels), "[Source](https://");
	assert.equal(
		renderMarkdown("## Sources\n**Read [source](https://example.com)**", labels),
		'<h3>Sources</h3><strong>Read <a href="https://example.com" target="_blank" rel="noopener noreferrer">source</a></strong>',
	);
});

test("renders GFM pipe tables with alignment, inline formatting and escaped cells", () => {
	const html = renderMarkdown(
		"我用加载器实验复现了：\n\n| 场景 | 结果 |\n|---|--:|\n| 父目录 + `a|b` | **成功** |\n| <b>x</b> \\| y | 退出码 1 |\n\n后文",
		labels,
	);
	assert.match(html, /<table class="md-table"><thead><tr><th>场景<\/th><th style="text-align:right">结果<\/th><\/tr><\/thead>/);
	assert.match(html, /<td>父目录 \+ <code>a\|b<\/code><\/td><td style="text-align:right"><strong>成功<\/strong><\/td>/);
	assert.match(html, /<td>&lt;b&gt;x&lt;\/b&gt; \| y<\/td>/);
	assert.match(html, /^我用加载器实验复现了：<div class="md-table-wrap">/);
	assert.match(html, /<\/table><\/div>后文$/);
});

test("leaves pipes without a delimiter row as text", () => {
	assert.equal(renderMarkdown("| a | b |", labels), "| a | b |");
	assert.equal(renderMarkdown("| a | b |\n|---|", labels), "| a | b |<br>|---|");
});
