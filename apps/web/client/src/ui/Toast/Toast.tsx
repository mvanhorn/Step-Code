import type { ComponentPropsWithRef } from "react";
import { cx } from "../../lib/format";
import styles from "./Toast.module.css";

export type ToastTone = "danger" | "neutral";

export interface ToastProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
	/** Text to show; null or "" hides the toast (it stays mounted). */
	readonly message: string | null | undefined;
	readonly tone?: ToastTone;
}

/**
 * `role="alert"` toast with `data-tone`, as the legacy `#errorToast`: fixed at
 * the top centre of the window. Timing is the caller's job.
 */
export function Toast({ message, tone = "danger", className, ...rest }: ToastProps) {
	return (
		<div className={cx(styles.root, className)} role="alert" data-tone={tone} hidden={!message} {...rest}>
			{message ?? ""}
		</div>
	);
}
