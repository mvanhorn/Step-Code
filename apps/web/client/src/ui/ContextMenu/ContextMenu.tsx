import { type ComponentPropsWithRef, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useMergedRef } from "../hooks/useMergedRef";
import styles from "./ContextMenu.module.css";

export interface ContextMenuProps extends ComponentPropsWithRef<"div"> {
	readonly open: boolean;
	/** Viewport x of the anchor: the menu's left edge (`start`) or right edge (`end`). */
	readonly x: number;
	/** Viewport y of the menu's top edge. */
	readonly y: number;
	readonly align?: "start" | "end";
	/** Minimum distance kept from the right and bottom viewport edges. Default 8. */
	readonly margin?: number;
	readonly bare?: boolean;
}

/**
 * Fixed-position menu at (x, y), clamped into the viewport once it has been
 * measured (legacy `openSessionMenu` / `positionTagPicker`). Stays mounted and
 * toggles `hidden`; dismissal belongs to the owner (see useDismiss).
 */
export function ContextMenu({
	open,
	x,
	y,
	align = "start",
	margin = 8,
	bare = false,
	className,
	style,
	ref,
	children,
	...rest
}: ContextMenuProps) {
	const own = useRef<HTMLDivElement | null>(null);
	const mergedRef = useMergedRef(own, ref);
	const [position, setPosition] = useState({ left: x, top: y });
	useLayoutEffect(() => {
		const element = own.current;
		if (!open || !element) return;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		const left = align === "end" ? x - width : x;
		setPosition({
			left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
			top: Math.min(y, window.innerHeight - height - margin),
		});
	}, [open, x, y, align, margin]);
	return (
		<div
			ref={mergedRef}
			className={cx(!bare && styles.root, className)}
			style={{ ...style, left: `${position.left}px`, top: `${position.top}px` }}
			hidden={!open}
			{...rest}
		>
			{children}
		</div>
	);
}
