import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@step-harness/coding-agent";

type Select = Pick<ExtensionUIContext, "select">["select"];

/**
 * A selector a kernel callback is waiting on.
 *
 * The options travel verbatim: the kernel owns the wording of its own dialogs
 * (`FULL_ACCESS_RISK_OPTIONS`), lists the choices, and parses the chosen
 * label back. The host only carries the question out and the answer in — it
 * never decides what an answer means.
 */
export interface SelectionRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly options: readonly string[];
}

export type SelectionEvent =
	| { type: "selection_required"; selection: SelectionRequest }
	| { type: "selection_resolved"; id: string };

interface PendingSelection {
	readonly request: SelectionRequest;
	readonly finish: (value: string | undefined) => void;
}

/**
 * Transport for the kernel's `ui.select` dialogs, which the host cannot render
 * itself.
 *
 * This replaces a stub that answered `options[0]`. That default is harmless for
 * an ordinary picker, but the kernel routes its Full Access risk acknowledgment
 * through `select` and reads the first option as "Yes, continue anyway" — so
 * the stub silently granted unrestricted operation, and the host had to keep
 * the tier out of the UI to compensate. Asking the user instead is what lets
 * the tier be offered at all.
 */
export class SelectionBroker {
	private readonly pending = new Map<string, PendingSelection>();
	private readonly sessionId: () => string;
	private readonly emit: (event: SelectionEvent) => void;

	constructor(sessionId: () => string, emit: (event: SelectionEvent) => void) {
		this.sessionId = sessionId;
		this.emit = emit;
	}

	ask(title: string, options: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		const request: SelectionRequest = { id: randomUUID(), sessionId: this.sessionId(), title, options };
		return new Promise((resolve) => {
			const onAbort = () => finish(undefined);
			// A selection settles at most once, whether it was answered, dismissed,
			// or abandoned by an aborted turn.
			const finish = (value: string | undefined) => {
				if (!this.pending.delete(request.id)) return;
				signal?.removeEventListener("abort", onAbort);
				this.emit({ type: "selection_resolved", id: request.id });
				resolve(value);
			};
			this.pending.set(request.id, { request, finish });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emit({ type: "selection_required", selection: request });
		});
	}

	/** Selections still waiting for an answer, oldest first, so a reloaded page can show them again. */
	pendingRequests(): SelectionRequest[] {
		return [...this.pending.values()].map(({ request }) => request);
	}

	/**
	 * Answer a pending selection. `value` is the option the user picked, or
	 * `undefined` when the dialog was dismissed.
	 *
	 * Returns false for an unknown id (a stale page whose dialog was already
	 * answered, or a session that was replaced) and for a value that was not
	 * offered. The caller reports either as 404; the dialog stays pending.
	 */
	respond(id: string, value: string | undefined): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		// The kernel compares the label it gets against the list it offered, so an
		// unoffered string is a malformed reply rather than a choice to interpret.
		if (value !== undefined && !pending.request.options.includes(value)) return false;
		pending.finish(value);
		return true;
	}

	/** Dismiss every pending dialog so a torn-down session leaves no caller hanging. */
	clear(): void {
		for (const { finish } of [...this.pending.values()]) finish(undefined);
	}
}

/** `select` bound to this broker, for `webUiContext`. */
export function selectionSelect(broker: SelectionBroker): Select {
	return (title, options, opts) => broker.ask(title, options, opts?.signal);
}
