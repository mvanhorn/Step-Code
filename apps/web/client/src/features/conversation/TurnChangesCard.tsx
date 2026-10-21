import { memo, useState } from "react";
import { useT } from "../../i18n";
import { splitPath, type TurnChanges } from "../../lib/turn-changes";
import { DiffStat, Icon } from "../../ui";
import { openTurnChanges } from "../files/actions";
import { revertTurn } from "./actions";

/** Files listed before "show all N files". */
const COLLAPSED_FILES = 3;

/**
 * The card under a finished turn: how many files it edited and the line
 * counts, then the files themselves. A file opens its diff in the preview
 * panel; "查看变更" opens the whole turn there. Files without a recorded diff
 * are marked: undo leaves them alone.
 */
export const TurnChangesCard = memo(function TurnChangesCard({
	turn,
	reverted,
}: {
	readonly turn: TurnChanges;
	readonly reverted: boolean;
}) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const hidden = turn.files.length - COLLAPSED_FILES;
	const files = expanded || hidden <= 0 ? turn.files : turn.files.slice(0, COLLAPSED_FILES);
	const revertable = turn.files.some((file) => file.patches.length > 0);
	const undo = async () => {
		setBusy(true);
		await revertTurn(turn.turnId);
		setBusy(false);
	};
	return (
		<section className="turn-changes" data-turn-id={turn.turnId} aria-label={t("turnChanges")}>
			<header className="turn-changes-head">
				<span className="turn-changes-icon" aria-hidden="true">
					<Icon name="fileDiff" />
				</span>
				<div className="turn-changes-summary">
					<strong>{t("turnFilesEdited", { count: turn.files.length })}</strong>
					<DiffStat additions={turn.additions} deletions={turn.deletions} />
				</div>
				<div className="turn-changes-actions">
					<button
						type="button"
						className="turn-changes-undo"
						disabled={reverted || busy || !revertable}
						onClick={() => void undo()}
					>
						{reverted ? t("turnReverted") : t("turnUndo")}
						{reverted ? null : <Icon name="undo" size="sm" />}
					</button>
					<button type="button" className="turn-changes-review" onClick={() => openTurnChanges(turn.turnId)}>
						{t("viewChanges")}
					</button>
				</div>
			</header>
			<ul className="turn-changes-files">
				{files.map((file) => {
					const [directory, name] = splitPath(file.path);
					return (
						<li key={file.path}>
							<button
								type="button"
								className="turn-change-file"
								data-tooltip={file.path}
								onClick={() => openTurnChanges(turn.turnId, file.path)}
							>
								<span className="turn-change-path">
									<span className="turn-change-dir">
										<bdi>{directory}</bdi>
									</span>
									<span className="turn-change-name">{name}</span>
								</span>
								{file.untracked ? (
									<span className="turn-change-untracked">{t("turnFileNotRevertable")}</span>
								) : (
									<DiffStat additions={file.additions} deletions={file.deletions} />
								)}
							</button>
						</li>
					);
				})}
			</ul>
			{hidden > 0 ? (
				<button
					type="button"
					className={expanded ? "turn-changes-more open" : "turn-changes-more"}
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? t("showFewerFiles") : t("showAllFiles", { count: turn.files.length })}
					<Icon name="chevronDown" size="sm" />
				</button>
			) : null}
		</section>
	);
});
