import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { sessionTitle } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import { Icon } from "../../ui";

/**
 * `#sessionHeader`: the conversation's fixed title bar — what this session is, where it runs
 * (project folder, Git branch) and whether it is working. A draft shows its folder only; the
 * branch arrives with the session snapshot (host `src/git-branch.ts`).
 */
export function SessionHeader() {
	const t = useT();
	const view = useAppStore(
		(state) => ({
			// The list summary carries the first message the snapshot lacks, so the bar names the session
			// exactly as its sidebar row does.
			title: state.current
				? sessionTitle({ ...state.sessions.find((session) => session.id === state.current?.id), ...state.current })
				: t("newConversation"),
			cwd: state.current?.cwd || state.draftCwd || state.bootstrapCwd,
			branch: state.current?.gitBranch ?? "",
			status: state.current?.status ?? "",
		}),
		shallowEqual,
	);
	const project = basename(view.cwd);
	return (
		<header className="session-header" id="sessionHeader">
			<h1 className="session-header-title" title={view.title}>
				{view.title}
			</h1>
			{project ? (
				<span className="session-header-chip" title={view.cwd}>
					<Icon name="folder" size="xs" />
					{project}
				</span>
			) : null}
			{view.branch ? (
				<span className="session-header-chip mono" title={view.branch}>
					<Icon name="fork" size="xs" />
					<span className="session-header-chip-text">{view.branch}</span>
				</span>
			) : null}
			{view.status ? (
				<span className="session-header-status" data-status={view.status}>
					<i aria-hidden="true" />
					{t(view.status)}
				</span>
			) : null}
		</header>
	);
}
