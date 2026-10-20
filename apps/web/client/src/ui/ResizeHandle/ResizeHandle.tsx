import { type ComponentPropsWithRef, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { cx } from "../../lib/format";
import styles from "./ResizeHandle.module.css";

type SizeBound = number | (() => number);

export interface ResizeHandleProps extends Omit<ComponentPropsWithRef<"div">, "onResize"> {
	/** The panel's size in px right now; read when a drag starts and on each key press. */
	readonly getSize: () => number;
	/** 1: dragging right (or down) grows the panel (left sidebar). -1: dragging left (or up) grows it (right panel, bottom dock). */
	readonly direction?: 1 | -1;
	/**
	 * `vertical` (default): a column splitter between side-by-side panels, driven by the x axis and Left/Right.
	 * `horizontal`: a row splitter between stacked panels, driven by the y axis and Up/Down.
	 */
	readonly orientation?: "vertical" | "horizontal";
	/** Live size during a drag. Apply it without persisting. */
	readonly onResize: (size: number) => void;
	/** Final size after a drag or a key press. Clamp, apply and persist here. */
	readonly onCommit: (size: number) => void;
	/** Double-click, typically "back to the default size". */
	readonly onReset?: () => void;
	/** Drag started / ended (legacy toggled `.app.resizing` and the handle's `dragging` class). */
	readonly onDraggingChange?: (dragging: boolean) => void;
	/** Arrow-key step in px; Shift uses `largeStep`. Defaults 8 / 32 (legacy SIDEBAR_KEYBOARD_STEP*). */
	readonly step?: number;
	readonly largeStep?: number;
	/** Home jumps to `min`, End to `max`, when given. Numeric bounds are also exposed as aria-valuemin/max. */
	readonly min?: SizeBound;
	readonly max?: SizeBound;
	/** Current size for `aria-valuenow`, when the owner wants it announced (legacy sidebar resizer). */
	readonly value?: number;
	readonly bare?: boolean;
}

const resolveBound = (bound: SizeBound): number => (typeof bound === "function" ? bound() : bound);

/**
 * Splitter: pointer drag with pointer capture, arrow keys, Home/End
 * and double-click, as legacy `initSidebarResizer` / `initPreviewPanel`. It
 * holds no size of its own: the owner reads and writes the width.
 * While dragging the element carries the legacy `dragging` class.
 */
export function ResizeHandle({
	getSize,
	direction = 1,
	orientation = "vertical",
	onResize,
	onCommit,
	onReset,
	onDraggingChange,
	step = 8,
	largeStep = 32,
	min,
	max,
	value,
	bare = false,
	className,
	...rest
}: ResizeHandleProps) {
	const origin = useRef({ position: 0, size: 0 });
	const horizontal = orientation === "horizontal";
	const [dragging, setDragging] = useState(false);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		origin.current = { position: horizontal ? event.clientY : event.clientX, size: getSize() };
		setDragging(true);
		onDraggingChange?.(true);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		const position = horizontal ? event.clientY : event.clientX;
		onResize(origin.current.size + (position - origin.current.position) * direction);
	};
	const finish = (event: PointerEvent<HTMLDivElement>) => {
		if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
		event.currentTarget.releasePointerCapture(event.pointerId);
		setDragging(false);
		onDraggingChange?.(false);
		onCommit(getSize());
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const amount = event.shiftKey ? largeStep : step;
		let next: number | undefined;
		if (event.key === (horizontal ? "ArrowUp" : "ArrowLeft")) next = getSize() - amount * direction;
		else if (event.key === (horizontal ? "ArrowDown" : "ArrowRight")) next = getSize() + amount * direction;
		else if (event.key === "Home" && min !== undefined) next = resolveBound(min);
		else if (event.key === "End" && max !== undefined) next = resolveBound(max);
		if (next === undefined) return;
		event.preventDefault();
		onCommit(next);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element; `<hr>` cannot take focus or pointer drags.
		<div
			role="separator"
			aria-orientation={orientation}
			aria-valuenow={value}
			aria-valuemin={typeof min === "number" ? min : undefined}
			aria-valuemax={typeof max === "number" ? max : undefined}
			tabIndex={0}
			className={cx(
				!bare && styles.root,
				!bare && horizontal && styles.horizontal,
				dragging && "dragging",
				className,
			)}
			data-dragging={dragging ? "true" : undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={finish}
			onDoubleClick={onReset}
			onKeyDown={onKeyDown}
			{...rest}
		/>
	);
}
