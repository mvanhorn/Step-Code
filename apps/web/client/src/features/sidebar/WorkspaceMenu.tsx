import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { ContextMenu, MenuItem } from "../../ui";
import { requestWorkspaceRemoval } from "../workspace/actions";
import { closeWorkspaceMenu } from "./actions";

/** Workspace actions live outside the sidebar so its scroll container cannot clip the menu. */
export function WorkspaceMenu() {
	const t = useT();
	const menu = useAppStore((state) => state.ui.workspaceMenu);
	const itemRef = useRef<HTMLButtonElement | null>(null);

	useLayoutEffect(() => {
		if (menu) itemRef.current?.focus({ preventScroll: true });
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const dismiss = () => closeWorkspaceMenu();
		const onOutsideClick = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Element && target.closest("#workspaceMenu,.workspace-menu-button")) return;
			dismiss();
		};
		// Capture also sees clicks whose action handlers stop propagation.
		document.addEventListener("click", onOutsideClick, true);
		// Fixed viewport coordinates are no longer valid after the anchor moves.
		const list = document.querySelector(".conversation-list");
		window.addEventListener("resize", dismiss);
		list?.addEventListener("scroll", dismiss);
		return () => {
			document.removeEventListener("click", onOutsideClick, true);
			window.removeEventListener("resize", dismiss);
			list?.removeEventListener("scroll", dismiss);
		};
	}, [menu]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") closeWorkspaceMenu(true);
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			itemRef.current?.focus();
		}
	};

	return (
		<ContextMenu
			id="workspaceMenu"
			role="menu"
			aria-label={t("moreActions")}
			open={Boolean(menu)}
			x={menu?.x ?? 0}
			y={menu?.y ?? 0}
			align="end"
			onKeyDown={onKeyDown}
		>
			<MenuItem
				ref={itemRef}
				className="remove-workspace"
				role="menuitem"
				icon="close-sm"
				onClick={() => {
					if (!menu) return;
					// The confirmation dialog must restore focus to the visible trigger, not this hidden item.
					closeWorkspaceMenu(true);
					requestWorkspaceRemoval(menu.cwd);
				}}
			>
				{t("removeWorkspace")}
			</MenuItem>
		</ContextMenu>
	);
}
