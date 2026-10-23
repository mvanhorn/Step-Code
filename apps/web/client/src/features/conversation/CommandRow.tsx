/**
 * `.command-row`: a kernel slash command the user sent, echoed in the stream.
 *
 * Slash commands run without a user message, so this row is the transcript's
 * only record of the typed line. It renders exactly what the composer showed
 * on send — the mode's chip (icon + label) or the plain command chip, then the
 * arguments as ordinary text — no separate design: the flow's record of a
 * prompt looks like the prompt did.
 */

import { useT } from "../../i18n";
import type { CommandTimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { commandLeadIcon, MODES, modeFromCommand } from "../composer";

export function CommandRow({ item }: { readonly item: CommandTimelineItem }) {
	const t = useT();
	const match = /^\/([A-Za-z0-9][\w.:-]*)\s*([\s\S]*)$/u.exec(item.command);
	const name = match?.[1] ?? "";
	const args = (match?.[2] ?? "").trim();
	const mode = modeFromCommand(name.replace(/:$/u, ""));
	const meta = mode ? MODES.find((entry) => entry.id === mode) : undefined;
	return (
		<section className="command-row" data-mode={mode ?? undefined}>
			<span className="command-row-chip">
				<Icon name={meta?.icon ?? commandLeadIcon(name)} size="xs" />
				{meta ? t(meta.labelKey) : `/${name}`}
			</span>
			{args ? <span className="command-row-text">{args}</span> : null}
		</section>
	);
}
