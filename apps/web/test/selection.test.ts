import assert from "node:assert/strict";
import test from "node:test";
import { FULL_ACCESS_RISK_OPTIONS } from "@step-harness/coding-agent";
import {
	FULL_ACCESS_RISK_CANCEL,
	FULL_ACCESS_RISK_OPTIONS as CLIENT_FULL_ACCESS_RISK_OPTIONS,
} from "../client/src/lib/permissions.ts";
import { SelectionBroker, type SelectionEvent, selectionSelect } from "../src/selection.ts";

const options = ["Yes, this session", "Yes, always", "Cancel"];

test("selection broker relays the question and returns the chosen option verbatim", async () => {
	const events: SelectionEvent[] = [];
	const broker = new SelectionBroker(
		() => "session-1",
		(event) => events.push(event),
	);
	const answer = broker.ask("Enable full access?\n\nRisky.", options);
	const [request] = broker.pendingRequests();
	assert.equal(request?.sessionId, "session-1");
	assert.equal(request?.title, "Enable full access?\n\nRisky.");
	assert.deepEqual(request?.options, options);
	assert.deepEqual(events[0], { type: "selection_required", selection: request });
	assert.equal(broker.respond(request?.id ?? "", "Yes, always"), true);
	assert.equal(await answer, "Yes, always");
	assert.deepEqual(events[1], { type: "selection_resolved", id: request?.id });
	assert.deepEqual(broker.pendingRequests(), []);
	// Settled once: a second answer is a stale page.
	assert.equal(broker.respond(request?.id ?? "", "Cancel"), false);
});

test("an option that was not offered is rejected and the question stays open", async () => {
	const broker = new SelectionBroker(
		() => "session-2",
		() => {},
	);
	const answer = broker.ask("Pick", options);
	const [request] = broker.pendingRequests();
	assert.equal(broker.respond(request?.id ?? "", "Yes"), false);
	assert.equal(broker.respond("unknown", "Cancel"), false);
	assert.equal(broker.pendingRequests().length, 1);
	assert.equal(broker.respond(request?.id ?? "", undefined), true);
	assert.equal(await answer, undefined);
});

test("abort and clear dismiss pending questions", async () => {
	const events: SelectionEvent[] = [];
	const broker = new SelectionBroker(
		() => "session-3",
		(event) => events.push(event),
	);
	const controller = new AbortController();
	const aborted = selectionSelect(broker)("Pick", options, { signal: controller.signal });
	const cleared = broker.ask("Pick again", options);
	controller.abort();
	assert.equal(await aborted, undefined);
	assert.equal(broker.pendingRequests().length, 1);
	broker.clear();
	assert.equal(await cleared, undefined);
	assert.deepEqual(broker.pendingRequests(), []);
	assert.equal(events.filter((event) => event.type === "selection_resolved").length, 2);
	// An already aborted signal never shows a dialog.
	const before = events.length;
	const signal = AbortSignal.abort();
	assert.equal(await broker.ask("Late", options, signal), undefined);
	assert.equal(events.length, before);
});

test("the client's copy of the Full Access risk options matches the kernel", () => {
	// The client cannot import the kernel; it recognises the question by these
	// labels to translate it, and a draft hands one of them back verbatim.
	assert.deepEqual([...CLIENT_FULL_ACCESS_RISK_OPTIONS], [...FULL_ACCESS_RISK_OPTIONS]);
	assert.equal(FULL_ACCESS_RISK_CANCEL, FULL_ACCESS_RISK_OPTIONS[2]);
});
