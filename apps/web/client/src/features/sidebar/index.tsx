/**
 * Sidebar feature slots, mounted by App.tsx at their legacy DOM positions
 * (see client/MIGRATION_MAP.md): the brand row, sidebar actions and
 * conversation list inside `aside.sidebar`, the width handle, the session
 * context menu, the tag picker and the global search modal.
 */

import "./sidebar.css";
import "./sessions.css";
import "./overlays.css";
import { BrandRow, ConversationList, SidebarActions } from "./SidebarNav";

export { SearchModal } from "./SearchModal";
export { SessionMenu } from "./SessionMenu";
export { SidebarResizer } from "./SidebarResizer";
export { TagPicker } from "./TagPicker";
export { WorkspaceMenu } from "./WorkspaceMenu";

/** `.brand-row`, `nav.sidebar-actions`, `section.conversation-list` (legacy index.html 539-640). */
export function SidebarNav() {
	return (
		<>
			<BrandRow />
			<SidebarActions />
			<ConversationList />
		</>
	);
}
