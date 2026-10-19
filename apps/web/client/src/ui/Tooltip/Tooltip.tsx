import { type CSSProperties, cloneElement, type ReactElement, type ReactNode, useId } from "react";
import { cx } from "../../lib/format";
import styles from "./Tooltip.module.css";

/** Props the tooltip sets on its trigger; the trigger element must forward them to its DOM node. */
export interface TooltipTriggerProps {
	readonly style?: CSSProperties;
	readonly "aria-describedby"?: string;
	readonly "aria-label"?: string;
}

export interface TooltipProps {
	/** Text or elements shown above the trigger. `null`, `undefined`, `false` or `""` render the trigger alone. */
	readonly content: ReactNode;
	/** One element that forwards `style` and `aria-describedby`, e.g. a `<button>` or an `IconButton`. */
	readonly children: ReactElement<TooltipTriggerProps>;
	/** Id of the hint element; generated when omitted. */
	readonly id?: string;
	/** Extra classes on the hint element, for feature-specific surface styles. */
	readonly className?: string;
}

/**
 * Hover and keyboard-focus hint, placement "top": centered over its trigger and
 * shifted sideways only when a viewport edge leaves no room.
 *
 * The hint is rendered as the trigger's next sibling, not inside it and with no
 * wrapper, so the trigger's own layout and the selectors on it stay unchanged;
 * the hint is `position: fixed` and out of flow. It follows the trigger through
 * a unique CSS `anchor-name` set inline on the trigger, and is shown by CSS
 * (`:hover + hint`, `:focus-visible + hint`), so hovering costs no re-render.
 * It stays mounted while `content` is set.
 *
 * `aria-describedby` points at the hint unless the hint repeats the trigger's
 * `aria-label` word for word, which would only make a screen reader say it twice.
 */
export function Tooltip({ content, children, id, className }: TooltipProps) {
	const autoId = useId();
	const hintId = id ?? `tooltip-${autoId}`;
	const anchorName = `--tooltip-${autoId.replace(/[^\w-]/g, "")}`;
	const shown = content !== null && content !== undefined && content !== false && content !== "";
	const repeatsLabel = typeof content === "string" && content === children.props["aria-label"];
	const describedBy = cx(children.props["aria-describedby"], shown && !repeatsLabel && hintId) || undefined;
	const trigger = cloneElement(children, {
		style: { ...children.props.style, anchorName },
		"aria-describedby": describedBy,
	});
	// The array keeps one shape whether or not the hint shows, so toggling `content` never remounts the trigger.
	return (
		<>
			{trigger}
			{shown ? (
				<span
					className={cx(styles.root, className)}
					id={hintId}
					role="tooltip"
					style={{ positionAnchor: anchorName }}
				>
					{content}
				</span>
			) : null}
		</>
	);
}
