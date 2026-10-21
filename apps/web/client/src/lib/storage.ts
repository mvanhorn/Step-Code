/**
 * localStorage access that never throws: private windows, blocked site data and
 * quota errors all degrade to "nothing stored".
 */

/** Keys the legacy client persisted; kept verbatim so existing preferences survive. */
export const STORAGE_KEYS = {
	theme: "stepcode.theme",
	locale: "stepcode.locale",
	previewWrap: "stepcode.previewWrap",
	previewWidth: "stepcode.previewWidth",
	sidebarWidth: "stepcode.sidebarWidth",
	terminalHeight: "stepcode.terminalHeight",
	pinnedModels: "stepcode.pinnedModels",
} as const;

export function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeStorage(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage is a convenience; a failed write must not break the UI.
	}
}

export function removeStorage(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// See writeStorage.
	}
}

/** Integer stored under `key`, or undefined when absent or not a number. */
export function readStoredInt(key: string): number | undefined {
	const parsed = Number.parseInt(readStorage(key) ?? "", 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}
