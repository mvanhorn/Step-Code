import { useT } from "../../i18n";
import { sessionTitle } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import { Icon, IconButton, LEGACY_ICONS, Popover, Tooltip } from "../../ui";
import { SessionMenu } from "../sidebar/SessionMenu";

/**
 * `#streamHeader`: the session strip above the conversation, mounted by
 * App.tsx only while the session has content (`hasSessionContent`). The
 * title mirrors the sidebar row; the more button opens the same rename /
 * archive / delete menu (`#streamMenu`).
 */
export function StreamHeader() {
	const t = useT();
	const session = useAppStore((state) => state.current);
	const menuOpen = useAppStore((state) => state.ui.streamMenu);
	// The snapshot carries no `firstMessage` (that is a list-row field), so the
	// merged row of the same session titles the strip like the sidebar does.
	const listed = useAppStore((state) => (session ? state.sessions.find((row) => row.id === session.id) : undefined));
	if (!session) return null;
	const title = sessionTitle(listed ?? session);
	return (
		<header className="stream-header" id="streamHeader">
			<div className="stream-header-row">
				<span className="stream-header-title" title={title}>
					{title}
				</span>
				{/* Escape belongs to the shell's chain. */}
				<Popover
					bare
					className="sidebar-menu session-menu"
					id="streamMenu"
					role="menu"
					aria-label={t("moreActions")}
					placement="bottom-end"
					open={menuOpen}
					onClose={() => setUi({ streamMenu: false })}
					dismissOn="click"
					closeOnEscape={false}
					content={<SessionMenu session={session} onAction={() => setUi({ streamMenu: false })} />}
				>
					{/* No hint while its menu is open: the menu already says what the button did. */}
					<Tooltip content={menuOpen ? null : t("moreActions")}>
						<IconButton
							className="stream-header-menu-button"
							aria-label={t("moreActions")}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							aria-controls="streamMenu"
							onClick={() =>
								setUi((ui) => ({
									streamMenu: !ui.streamMenu,
									sessionMenu: null,
									workspaceMenu: null,
									tagPicker: null,
								}))
							}
						>
							<Icon {...LEGACY_ICONS.more} />
						</IconButton>
					</Tooltip>
				</Popover>
			</div>
		</header>
	);
}
