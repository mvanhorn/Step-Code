import assert from "node:assert/strict";
import test from "node:test";
import { fileCompletionText, fileQuery, sameFileQuery } from "../client/src/features/composer/file-completion.ts";
import type { TreeEntry } from "../client/src/state/types.ts";

const file: TreeEntry = { name: "app.ts", path: "src/app.ts", kind: "file" };
const directory: TreeEntry = { name: "src", path: "src", kind: "directory" };

test("@ paths trigger at a collapsed caret's word or line boundary, not email or quoted prose", () => {
	for (const text of ["@", "read @src/app", "first line\n@src/", "使用 @文件夹/", "\t@.gitignore"]) {
		const query = fileQuery(text, text.length);
		assert.ok(query, text);
		assert.equal(query.start, text.lastIndexOf("@"));
		assert.equal(query.end, text.length);
		assert.equal(query.query, text.slice(text.lastIndexOf("@") + 1));
	}
	for (const text of ["user@host", "(@src)", '"@src"', "@@src", "read @src/app ", '@"src/app.ts"', '@"notes\nnext', "x\ufffc@src"]) {
		assert.equal(fileQuery(text, text.length), null, text);
	}
	assert.equal(fileQuery("@src", -1), null);
	assert.equal(fileQuery("@src", 5), null);
});

test("quoted paths preserve spaces and completing inside a token replaces only that token", () => {
	const quoted = 'read @"notes space/guide.md" after';
	const cursor = quoted.indexOf("guide") + 2;
	assert.deepEqual(fileQuery(quoted, cursor), {
		start: 5, end: quoted.indexOf('" after') + 1, query: "notes space/gu", quoted: true,
		token: '@"notes space/guide.md"',
	});
	const plain = "🙂 before @src/app.ts after";
	const middle = plain.indexOf("app") + 2;
	const query = fileQuery(plain, middle);
	assert.ok(query);
	assert.equal(query.query, "src/ap");
	assert.equal(query.end, plain.indexOf(" after"));
	assert.equal(query.token, "@src/app.ts");
	assert.equal(fileQuery("@src\ufffcnext", 4)?.end, 4, "a file chip cannot be swallowed by completion");
});

test("file picks settle references; directory Tab drills without a trailing space", () => {
	assert.deepEqual(fileCompletionText(file, false, false), { text: "@src/app.ts ", cursor: 12 });
	assert.deepEqual(fileCompletionText(file, false, true), fileCompletionText(file, false, false));
	assert.deepEqual(fileCompletionText(directory, false, false), { text: "@src/ ", cursor: 6 });
	assert.deepEqual(fileCompletionText(directory, false, true), { text: "@src/", cursor: 5 });
	assert.deepEqual(fileCompletionText(file, true, false), { text: '@"src/app.ts" ', cursor: 14 });
	const spaced: TreeEntry = { name: "notes space", path: "notes space", kind: "directory" };
	const picked = fileCompletionText(spaced, false, false);
	assert.equal(picked.text, '@"notes space/" ');
	assert.equal(picked.cursor, picked.text.length);
	const drilled = fileCompletionText(spaced, false, true);
	assert.equal(drilled.text, '@"notes space/"');
	assert.equal(drilled.cursor, drilled.text.length - 1);
	assert.equal(fileQuery(drilled.text, drilled.cursor)?.query, "notes space/");
});

test("token identity includes the right-hand suffix, rejecting equal-length edits and moved carets", () => {
	const original = fileQuery("@src/app.ts after", 6);
	assert.ok(sameFileQuery(original, { ...original! }));
	assert.equal(sameFileQuery(original, fileQuery("@src/end.ts after", 6)), false);
	assert.equal(sameFileQuery(original, fileQuery("@src/app.ts after", 7)), false);
	assert.equal(sameFileQuery(original, null), false);
	assert.equal(sameFileQuery(null, null), true);
});
