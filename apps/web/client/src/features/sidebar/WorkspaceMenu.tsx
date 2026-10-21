import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { MenuItem } from "../../ui";
import { requestWorkspaceRemoval } from "../workspace/actions";
import { closeWorkspaceMenu } from "./actions";

/** Content of `#workspaceMenu`: actions for one project. Mounted on open, so its item takes focus then. */
export function WorkspaceMenu({ cwd }: { readonly cwd: string }) {
	const t = useT();
	const itemRef = useRef<HTMLButtonElement | null>(null);
	useLayoutEffect(() => itemRef.current?.focus({ preventScroll: true }), []);
	return (
		<MenuItem
			ref={itemRef}
			className="remove-workspace"
			role="menuitem"
			icon="close-sm"
			onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
				// Tab leaves the menu (focus back on the trigger); arrows / Home / End stay on its only item.
				if (event.key === "Tab") closeWorkspaceMenu(true);
				if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) event.preventDefault();
			}}
			onClick={() => {
				// The confirmation dialog must restore focus to the trigger, not this unmounted item.
				closeWorkspaceMenu(true);
				requestWorkspaceRemoval(cwd);
			}}
		>
			{t("removeWorkspace")}
		</MenuItem>
	);
}
