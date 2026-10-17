import type { CSSProperties } from "react";
import { Composer, SelectionDialog } from "./features/composer";
import { ChildAgentView, ConversationStream, FeedbackModal, TaskBanner } from "./features/conversation";
import { FileTreePanel, PreviewPanel, PreviewShowButton } from "./features/files";
import { LoginGate } from "./features/login";
import { CronView, MarketView } from "./features/market";
import { SettingsView } from "./features/settings";
import { AuthBanner, ErrorToast, LoggedOutOverlay, ShellEffects, SidebarShowButton, UserArea } from "./features/shell";
import { SearchModal, SessionMenu, SidebarNav, SidebarResizer, TagPicker } from "./features/sidebar";
import { RemoveWorkspaceModal, WorkspaceBrowserModal, WorkspaceControl } from "./features/workspace";
import { I18nProvider } from "./i18n";
import { cx } from "./lib/format";
import { shallowEqual, useAppStore } from "./state/store";
import { IconSprite } from "./ui";

/**
 * The legacy page skeleton (public/index.html), one slot per feature at its
 * original DOM position:
 *
 *   svg.icon-sprite
 *   div.app[.sidebar-hidden][.preview-open][.resizing]  (--sidebar-width, --preview-width)
 *     aside.sidebar      sidebar nav | files tree | shell user area (account, remote control, settings gear)
 *     #sidebarResizer    sidebar
 *     main.main          shell show button | files show button | conversation banner | market cron/market views
 *                        | conversation #childAgentView (read-only child transcript over stream and composer) | stream
 *                        | .composer-zone > composer form (workspace pill above the card) | sidebar session menu
 *                        | shell toast + auth banner
 *     aside#previewPanel files
 *   #settingsView      settings: full-window settings page (menu + page) over the workspace
 *   #tagPicker, #feedbackModal, #searchModal, #workspaceBrowserModal, #removeWorkspaceModal, #selectionDialog,
 *   #loggedOutOverlay
 *   #loginGate         login: Desktop sign-in, above everything while no credential exists
 */
export function App() {
	const layout = useAppStore(
		(state) => ({
			sidebarHidden: state.ui.sidebarHidden,
			sidebarWidth: state.ui.sidebarWidth,
			previewWidth: state.ui.previewWidth,
			resizing: state.ui.resizing,
			previewOpen: state.preview.open,
		}),
		shallowEqual,
	);
	const style: Record<string, string> = {};
	if (layout.sidebarWidth !== null) style["--sidebar-width"] = `${layout.sidebarWidth}px`;
	if (layout.previewWidth !== null) style["--preview-width"] = `${layout.previewWidth}px`;
	return (
		<I18nProvider>
			<IconSprite />
			<div
				className={cx(
					"app",
					layout.sidebarHidden && "sidebar-hidden",
					layout.previewOpen && "preview-open",
					layout.resizing && "resizing",
				)}
				style={style as CSSProperties}
			>
				<aside className="sidebar">
					<SidebarNav />
					<FileTreePanel />
					<UserArea />
				</aside>
				<SidebarResizer />
				<main className="main">
					<SidebarShowButton />
					<PreviewShowButton />
					<TaskBanner />
					<CronView />
					<MarketView />
					<ChildAgentView />
					<ConversationStream />
					<div className="composer-zone">
						<Composer workspaceControl={<WorkspaceControl />} />
					</div>
					<SessionMenu />
					<ErrorToast />
					<AuthBanner />
				</main>
				<PreviewPanel />
			</div>
			<SettingsView />
			<TagPicker />
			<FeedbackModal />
			<SearchModal />
			<WorkspaceBrowserModal />
			<RemoveWorkspaceModal />
			<SelectionDialog />
			<LoggedOutOverlay />
			<LoginGate />
			<ShellEffects />
		</I18nProvider>
	);
}
