import type { ComponentPropsWithRef } from "react";
import { cx } from "../../lib/format";
import { Icon, type IconName, type IconSize } from "../Icon/Icon";
import styles from "./IconButton.module.css";

export interface IconButtonProps extends ComponentPropsWithRef<"button"> {
	/** Sprite icon rendered before `children`. */
	readonly icon?: IconName;
	readonly iconSize?: IconSize;
}

/**
 * Square icon button. Always carries the legacy `icon-button` class, which
 * feature CSS and tests select on (e.g. `.preview-tools .icon-button`), and
 * sets no accessible name of its own: pass `aria-label`, and wrap it in a
 * `Tooltip` for a hover hint.
 */
export function IconButton({ icon, iconSize = "md", type = "button", className, children, ...rest }: IconButtonProps) {
	return (
		<button type={type} className={cx(styles.root, "icon-button", className)} {...rest}>
			{icon ? <Icon name={icon} size={iconSize} /> : null}
			{children}
		</button>
	);
}
