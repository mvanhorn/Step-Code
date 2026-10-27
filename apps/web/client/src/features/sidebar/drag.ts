/**
 * The row being dragged in the sidebar, for the duration of one HTML5 drag.
 *
 * A drop target may not read `DataTransfer` data while a row is over it (the
 * browser keeps the payload private until the drop), so the list the row came
 * from rides here instead. Reordering only moves a row inside its own list: a
 * row dropped on another project's row does nothing, and inside the grouped
 * view the event is left to the `GroupedSection` underneath, which retags the
 * session instead.
 */

export interface DraggedSession {
	readonly sessionId: string;
	/** The list the row was grabbed from (a project folder, Recent, or a tag section). */
	readonly listId: string;
}

let dragged: DraggedSession | null = null;

export function beginSessionDrag(sessionId: string, listId: string): void {
	dragged = { sessionId, listId };
}

export function endSessionDrag(): void {
	dragged = null;
}

export function draggedSession(): DraggedSession | null {
	return dragged;
}

/** Whether `sessionId`'s row may take this drag: the same list, and a different row. */
export function canReorder(source: DraggedSession | null, listId: string, sessionId: string): source is DraggedSession {
	return source !== null && source.listId === listId && source.sessionId !== sessionId;
}

/**
 * Which side of `element` a drag at `clientY` asks for: the half a released
 * pointer is over decides whether the row lands above or below it. That half is
 * also what decides the drop's part of the list — above a pinned row means
 * "pinned here", below the last pinned row means "unpinned here".
 */
export function dropPlaceAt(element: Element, clientY: number): "before" | "after" {
	const rect = element.getBoundingClientRect();
	return clientY < rect.top + rect.height / 2 ? "before" : "after";
}
