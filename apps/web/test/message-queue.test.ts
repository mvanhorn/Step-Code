import assert from "node:assert/strict";
import test from "node:test";
import { MessageQueue, SteeringImages } from "../src/message-queue.ts";

const image = { name: "shot.png", mimeType: "image/png", data: "AAAA", kind: "image" as const };

test("message queue keeps send order and reports every change", () => {
	let changes = 0;
	const queue = new MessageQueue(() => changes++);
	const first = queue.add({ text: "first", attachments: [image], files: [{ id: "u1", name: "a.txt" }] });
	queue.add({ text: "second", attachments: [], files: [] });
	assert.equal(changes, 2);
	assert.deepEqual(
		queue.views().map((item) => item.text),
		["first", "second"],
	);
	// Views carry attachment names, never their bytes.
	assert.deepEqual(queue.views()[0], {
		id: first.id,
		text: "first",
		attachments: [{ name: "shot.png", kind: "image" }],
		files: [{ id: "u1", name: "a.txt" }],
	});
	assert.equal(queue.shift()?.text, "first");
	assert.equal(queue.size, 1);
	assert.equal(changes, 3);
});

test("message queue edits and removes by id and refuses unknown ids", () => {
	let changes = 0;
	const queue = new MessageQueue(() => changes++);
	const item = queue.add({ text: "draft", attachments: [image], files: [] });
	assert.equal(queue.edit(item.id, "final"), true);
	assert.equal(queue.views()[0].text, "final");
	// An edit changes the text only; attachments stay with the message.
	assert.equal(queue.views()[0].attachments.length, 1);
	assert.equal(queue.edit("missing", "x"), false);
	assert.equal(queue.take("missing"), undefined);
	const changesBefore = changes;
	assert.equal(queue.take(item.id)?.text, "final");
	assert.equal(changes, changesBefore + 1);
	assert.equal(queue.size, 0);
	assert.equal(queue.shift(), undefined);
});

test("message queue restores refused items and interrupted kernel messages in front", () => {
	const queue = new MessageQueue(() => {});
	const a = queue.add({ text: "a", attachments: [], files: [] });
	const b = queue.add({ text: "b", attachments: [], files: [] });
	const taken = queue.takeAll();
	assert.equal(queue.size, 0);
	queue.add({ text: "c", attachments: [], files: [] });
	queue.restore(taken);
	assert.deepEqual(
		queue.views().map((item) => item.id).slice(0, 2),
		[a.id, b.id],
	);
	queue.prepend([
		{ text: "steered", attachments: [] },
		{ text: "follow-up", attachments: [] },
	]);
	assert.deepEqual(
		queue.views().map((item) => item.text),
		["steered", "follow-up", "a", "b", "c"],
	);
});

test("steering images pair with the kernel's pending texts and drop once delivered", () => {
	const image = { name: "a.png", mimeType: "image/png", data: "AAAA", kind: "image" as const };
	const other = { ...image, name: "b.png", data: "BBBB" };
	const images = new SteeringImages();
	images.record("look", [image]);
	images.record("plain", []);
	images.record("look", [other]);
	assert.deepEqual(
		images.match(["look", "plain", "look"]).map((message) => message.images.map((item) => item.name)),
		[["a.png"], [], ["b.png"]],
	);
	// The kernel delivered the oldest "look" (and "plain"): its record goes, the newer one stays.
	assert.deepEqual(
		images.match(["look"]).map((message) => message.images.map((item) => item.name)),
		[["b.png"]],
	);
	assert.deepEqual(images.match(["look"])[0].images, [other]);
	assert.deepEqual(images.match([]), []);
	assert.deepEqual(images.match(["look"])[0].images, []);
});
