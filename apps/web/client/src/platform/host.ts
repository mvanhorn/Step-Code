import type { StepcodeDesktopBridge } from "./desktop-bridge";

export type { DesktopBrowserInfo, StepcodeDesktopBridge } from "./desktop-bridge";

/** The desktop shell's bridge (apps/desktop preload), or undefined in a plain browser. */
export function getDesktopBridge(): StepcodeDesktopBridge | undefined {
	return typeof window === "undefined" ? undefined : window.stepcodeDesktop;
}

export function isDesktopHost(): boolean {
	return getDesktopBridge() !== undefined;
}

/**
 * Mark the document with the host so CSS can adapt (macOS traffic-light inset,
 * draggable title strip): `<html data-host="desktop" data-platform="darwin">`.
 * A plain browser gets `data-host="browser"` and no platform.
 */
export function applyHostAttributes(root: HTMLElement = document.documentElement): void {
	const bridge = getDesktopBridge();
	if (!bridge) {
		root.dataset.host = "browser";
		return;
	}
	root.dataset.host = "desktop";
	root.dataset.platform = bridge.platform;
}
