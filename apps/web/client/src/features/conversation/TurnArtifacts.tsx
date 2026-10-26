import { useState } from "react";
import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { activeRightPanel } from "../../state/right-panel";
import { copyText } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Icon, IconButton, Tooltip } from "../../ui";
import { toggleDeliveryFile } from "../files/actions";
import type { TurnArtifact } from "./turn-artifacts";

/**
 * The finished answer's deliverables, attached under its closing bubble like a
 * chat attachment area: one row per file, the eye says clicking previews it.
 * No label and no count — the rows are the reply handing files over.
 */
export function MessageAttachments({
	artifacts,
	cwd,
}: {
	readonly artifacts: readonly TurnArtifact[];
	readonly cwd: string;
}) {
	const t = useT();
	const [showAll, setShowAll] = useState(false);
	const activePath = useAppStore((state) => {
		const tab = state.preview.tabs[state.preview.active];
		return activeRightPanel(state) === "files" && tab?.kind === "file" && tab.cwd === cwd ? tab.path : null;
	});
	if (!artifacts.length) return null;
	return (
		<section className="message-attachments" aria-label={t("turnOutputs")}>
			{(showAll ? artifacts : artifacts.slice(0, 3)).map((artifact) => {
				const name = basename(artifact.path);
				const dir = artifact.path.slice(0, artifact.path.length - name.length).replace(/[\\/]+$/, "");
				return (
					<div className="attachment-row" key={artifact.path}>
						<Tooltip content={artifact.path}>
							<button
								type="button"
								className="attachment-main"
								aria-controls="rightPanel"
								aria-expanded={activePath === artifact.path}
								aria-label={`${t("toolOpenFile")}: ${artifact.path}`}
								onClick={() => void toggleDeliveryFile(cwd, artifact.path)}
							>
								<Icon name="eye" size="xs" />
								<span className="attachment-name">{name}</span>
								{dir ? <span className="attachment-dir">{dir}</span> : null}
							</button>
						</Tooltip>
						<Tooltip content={t("copyPath")}>
							<IconButton
								className="attachment-copy"
								icon="copy"
								iconSize="xs"
								aria-label={`${t("copyPath")}: ${artifact.path}`}
								onClick={() => void copyText(artifact.path)}
							/>
						</Tooltip>
					</div>
				);
			})}
			{artifacts.length > 3 ? (
				<button
					type="button"
					className="attachment-more"
					aria-expanded={showAll}
					onClick={() => setShowAll(!showAll)}
				>
					<Icon name="chevronDown" size="2xs" />
					{t(showAll ? "outputsLess" : "outputsMore", { count: artifacts.length - 3 })}
				</button>
			) : null}
		</section>
	);
}
