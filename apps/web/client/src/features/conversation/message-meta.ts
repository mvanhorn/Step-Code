/**
 * A message's clock time, for the model-and-time row the transcript shows on
 * hover. Kept out of the component file so it can be tested as a pure function.
 */

/** `HH:MM` in the reader's own zone; an unparseable value passes through unchanged. */
export function clockTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
