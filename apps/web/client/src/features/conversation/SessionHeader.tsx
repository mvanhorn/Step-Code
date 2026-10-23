import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { sessionTitle } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import { Icon } from "../../ui";

/**
 * `#sessionHeader`: the conversation's fixed title bar — what this session is, which project
 * folder it runs in and whether it is working. The branch is the composer's branch picker's job.
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
			{view.status ? (
				<span className="session-header-status" data-status={view.status}>
					<i aria-hidden="true" />
					{t(view.status)}
				</span>
			) : null}
		</header>
	);
}
