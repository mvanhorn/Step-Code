/**
 * `.command-row`: a kernel slash command the user sent, echoed in the stream.
 *
 * Slash commands run without a user message, so this row is the transcript's
 * only record of the typed line (`/goal 整理文件夹`). It reads like the
 * composer's lead chip — the command's icon, its mode's colour for the three
 * session modes, the neutral command purple for everything else — so a command
 * looks the same here as it does at the prompt.
 */

import type { CommandTimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { commandLeadIcon, modeFromCommand } from "../composer";

export function CommandRow({ item }: { readonly item: CommandTimelineItem }) {
	const name = /^\/([A-Za-z0-9][\w.:-]*)/u.exec(item.command)?.[1] ?? "";
	const mode = modeFromCommand(name.replace(/:$/u, ""));
	return (
		<section className="command-row" data-mode={mode ?? undefined}>
			<span className="command-row-icon" aria-hidden="true">
				<Icon name={commandLeadIcon(name)} size="xs" />
			</span>
			<code className="command-row-text">{item.command}</code>
		</section>
	);
}
