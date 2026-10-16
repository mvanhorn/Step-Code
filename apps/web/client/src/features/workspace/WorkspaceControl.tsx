import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { knownWorkspaces, startDraft } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import { EmptyState, Icon, Popover } from "../../ui";
import { chooseWorkspaceFolder, closeWorkspacePopover, openWorkspacePopover } from "./actions";

/**
 * `#workspaceControl`: the draft's folder pill just above the composer card,
 * outside it. The popover lists the known workspaces, the current one
 * checked, then "Add workspace…". It opens downward over the prompt; when the
 * composer sits too close to the bottom of the window for the list to fit
 * there, it opens upward instead of running off screen.
 *
 * Hidden while a session is open. Before bootstrap there is no folder yet, and
 * `basename()` would render its "recent" placeholder as if it were a workspace
 * name, so the neutral "Workspace" label stays until a real path arrives.
 */
export function WorkspaceControl() {
	const t = useT();
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const [placement, setPlacement] = useState<"below" | "above">("below");
	const view = useAppStore(
		(state) => ({
			hidden: Boolean(state.current),
			cwd: state.draftCwd || state.bootstrapCwd,
			draftCwd: state.draftCwd,
			open: state.ui.workspacePopoverOpen,
		}),
		shallowEqual,
	);
	const workspaces = useAppStore(knownWorkspaces, shallowEqual);
	// Measured before paint, so an upward list never flashes below first.
	useLayoutEffect(() => {
		const button = buttonRef.current;
		const popover = popoverRef.current;
		if (!view.open || !button || !popover) return;
		const trigger = button.getBoundingClientRect();
		const below = window.innerHeight - trigger.bottom;
		setPlacement(popover.offsetHeight + 12 <= below || below >= trigger.top ? "below" : "above");
	}, [view.open]);
	return (
		<div className="workspace-control" id="workspaceControl" hidden={view.hidden}>
			<button
				ref={buttonRef}
				id="workspaceButton"
				className="workspace-pill"
				type="button"
				aria-haspopup="listbox"
				aria-expanded={view.open}
				aria-label={`${t("workspacePickerLabel")}: ${view.cwd || "Workspace"}`}
				onClick={() => (view.open ? closeWorkspacePopover() : openWorkspacePopover())}
			>
				<Icon name="folder" size="sm" />
				<span id="workspaceButtonName">{view.cwd ? basename(view.cwd) : "Workspace"}</span>
				<Icon name="chevronDown" size="2xs" className="chevron" />
			</button>
			<Popover
				bare
				ref={popoverRef}
				data-placement={placement}
				className="workspace-popover"
				id="workspacePopover"
				open={view.open}
				onClose={() => closeWorkspacePopover()}
				ignoreRefs={[buttonRef]}
				dismissOn="click"
				closeOnEscape={false}
			>
				<div className="workspace-popover-title">{t("recentFolders")}</div>
				<div id="workspaceRecentList" role="listbox" aria-label={t("recentFolders")}>
					{workspaces.map((path) => (
						<RecentItem key={path} path={path} selected={path === view.draftCwd} />
					))}
					{workspaces.length ? null : <EmptyState>{t("emptyDirectory")}</EmptyState>}
				</div>
				<div className="workspace-popover-divider" />
				<button
					className="workspace-browse-button"
					id="workspaceBrowseButton"
					type="button"
					onClick={() => {
						closeWorkspacePopover();
						void chooseWorkspaceFolder();
					}}
				>
					<Icon name="plus" size="sm" />
					<span>{t("addWorkspaceEllipsis")}</span>
				</button>
			</Popover>
		</div>
	);
}

/** One workspace: its folder name; the full path is the tooltip, for same-named folders. */
function RecentItem({ path, selected }: { readonly path: string; readonly selected: boolean }) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			className={`workspace-recent-item${selected ? " selected" : ""}`}
			title={path}
			onClick={() => {
				startDraft(path);
				closeWorkspacePopover();
			}}
		>
			<Icon name="folder" size="sm" />
			<span>{basename(path)}</span>
			{selected ? <Icon name="check" size="sm" className="workspace-check" /> : null}
		</button>
	);
}
