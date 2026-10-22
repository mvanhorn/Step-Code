import { t, useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { forgetUnlistedSession, refreshSessions, sessionTitle, showError, startDraft } from "../../state/session";
import { getState } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { closeSessionMenu } from "./actions";

type SessionAction = "rename" | "archive" | "delete";

/** Rename / archive / delete one session (legacy `openSessionMenu` click handler, 1297-1328). */
async function runSessionAction(action: SessionAction, session: SessionSummary): Promise<void> {
	try {
		if (action === "rename") {
			const name = window.prompt(t("rename"), sessionTitle(session));
			if (name?.trim()) await apiSend(`/api/v1/sessions/${session.id}/name`, "PATCH", { name: name.trim() });
		}
		if (action === "archive") {
			await apiSend(`/api/v1/sessions/${session.id}/archive`, "PATCH", { archived: !session.archived });
		}
		if (action === "delete" && window.confirm(t("confirmDelete", { name: sessionTitle(session) }))) {
			await apiSend(`/api/v1/sessions/${session.id}`, "DELETE");
			forgetUnlistedSession(session.id);
			const state = getState();
			if (state.current?.id === session.id) startDraft(state.bootstrapCwd);
		}
		await refreshSessions();
	} catch (error) {
		showError(errorMessage(error));
	}
}

/** Content of `#sessionMenu`: rename / archive / delete one session (legacy app.js 1287-1329). */
export function SessionMenu({ session }: { readonly session: SessionSummary }) {
	const translate = useT();
	const run = (action: SessionAction) => {
		closeSessionMenu();
		void runSessionAction(action, session);
	};
	return (
		<>
			<button type="button" data-action="rename" onClick={() => run("rename")}>
				{translate("rename")}
			</button>
			<button type="button" data-action="archive" onClick={() => run("archive")}>
				{session.archived ? translate("restore") : translate("archive")}
			</button>
			<button className="danger" type="button" data-action="delete" onClick={() => run("delete")}>
				{translate("delete")}
			</button>
		</>
	);
}
