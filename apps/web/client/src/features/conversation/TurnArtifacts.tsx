import { useState } from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import type { BrowserMark } from "../../lib/browser-identity";
import type { ArtifactKind } from "../../lib/file-references";
import { basename } from "../../lib/format";
import { activeRightPanel } from "../../state/right-panel";
import { showError } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Icon, IconButton, type IconName, Tooltip } from "../../ui";
import { openInEmbeddedBrowser, openInSystemBrowser, type SystemBrowser, useSystemBrowser } from "../browser";
import { toggleDeliveryFile, workspaceSiteUrl } from "../files/actions";
import type { TurnArtifact } from "./turn-artifacts";

/** Collapsed cards before "N more"; four fill the two-column grid. */
const COLLAPSED_COUNT = 4;

/** Pages the embedded (headless) browser renders. PDF is left out: headless Chromium downloads it instead. */
const EMBEDDED_RENDERABLE = /\.(?:html?|xhtml|svg)$/i;
/** Pages worth handing to the system browser, which also has a PDF viewer. */
const SYSTEM_RENDERABLE = /\.(?:html?|xhtml|svg|pdf)$/i;

const KIND_ICONS: Readonly<Record<ArtifactKind, IconName>> = {
	website: "globe",
	image: "image",
	document: "fileText",
	spreadsheet: "file",
	presentation: "file",
	audio: "file",
	video: "file",
	file: "file",
};

const BROWSER_MARKS: Readonly<Record<BrowserMark, IconName>> = {
	chrome: "browserChrome",
	safari: "browserSafari",
	edge: "browserEdge",
	firefox: "browserFirefox",
};

/** The OS's icon for the browser, else its bundled brand mark, else the generic "open outside" glyph. */
function SystemBrowserIcon({ browser }: { readonly browser: SystemBrowser | null }) {
	if (browser?.image) return <img src={browser.image} alt="" width={16} height={16} draggable={false} />;
	if (browser?.mark) return <Icon name={BROWSER_MARKS[browser.mark]} size="sm" />;
	return <Icon name="openExternal" size="xs" />;
}

/**
 * The finished answer's deliverables, attached under its closing bubble: one
 * card per file (type tile, name, description) in a two-column grid.
 *
 * A page the embedded browser can render opens there when the card is clicked;
 * its actions show the source in the Files preview and open it in the system
 * browser, named and shown with its own icon (Desktop: the default browser;
 * Web: the browser showing the page). Every other file previews on
 * click.
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
	const browser = useSystemBrowser();
	const activePath = useAppStore((state) => {
		const tab = state.preview.tabs[state.preview.active];
		return activeRightPanel(state) === "files" && tab?.kind === "file" && tab.cwd === cwd ? tab.path : null;
	});
	if (!artifacts.length) return null;
	const shown = showAll ? artifacts : artifacts.slice(0, COLLAPSED_COUNT);
	return (
		<section className="message-attachments" aria-label={t("turnOutputs")}>
			<div className="attachment-grid" data-single={artifacts.length === 1 || undefined}>
				{shown.map((artifact) => (
					<AttachmentCard
						key={artifact.path}
						artifact={artifact}
						cwd={cwd}
						sourceOpen={activePath === artifact.path}
						browser={browser}
					/>
				))}
			</div>
			{artifacts.length > COLLAPSED_COUNT ? (
				<button
					type="button"
					className="attachment-more"
					aria-expanded={showAll}
					onClick={() => setShowAll(!showAll)}
				>
					{t(showAll ? "outputsLess" : "outputsMore", { count: artifacts.length - COLLAPSED_COUNT })}
					<Icon name="chevronDown" size="2xs" />
				</button>
			) : null}
		</section>
	);
}

function AttachmentCard({
	artifact,
	cwd,
	sourceOpen,
	browser,
}: {
	readonly artifact: TurnArtifact;
	readonly cwd: string;
	readonly sourceOpen: boolean;
	readonly browser: SystemBrowser | null;
}) {
	const t = useT();
	const [pending, setPending] = useState(false);
	const name = basename(artifact.path);
	const dir = artifact.path.slice(0, artifact.path.length - name.length).replace(/[\\/]+$/, "");
	const embedded = EMBEDDED_RENDERABLE.test(name);
	const system = SYSTEM_RENDERABLE.test(name);
	// A Markdown link label ("贪吃蛇小游戏") describes the file better than its folder does.
	const described = artifact.label && artifact.label !== name && artifact.label !== artifact.path;
	const meta = described ? artifact.label : [t(`deliveryKind.${artifact.kind}`), dir].filter(Boolean).join(" · ");
	const toggleSource = () => void toggleDeliveryFile(cwd, artifact.path);
	// The URL is minted per click: the Host forgets tokens on restart, and a stale one would 404.
	const openPage = (target: (url: string) => void) => {
		if (pending) return;
		setPending(true);
		void workspaceSiteUrl(cwd, artifact.path)
			.then(target)
			.catch((failure: unknown) => showError(t("deliveryOpenFailed", { error: errorMessage(failure) })))
			.finally(() => setPending(false));
	};
	const systemLabel = browser ? t("deliveryOpenIn", { browser: browser.name }) : t("deliveryOpenInBrowser");
	return (
		<div
			className="attachment-card"
			data-kind={artifact.kind}
			data-active={sourceOpen || undefined}
			data-pending={pending || undefined}
		>
			<Tooltip content={artifact.path}>
				<button
					type="button"
					className="attachment-main"
					aria-controls="rightPanel"
					aria-expanded={embedded ? undefined : sourceOpen}
					aria-label={`${t(embedded ? "deliveryPreviewInBrowser" : "toolOpenFile")}: ${artifact.path}`}
					onClick={embedded ? () => openPage(openInEmbeddedBrowser) : toggleSource}
				>
					<span className="attachment-icon" aria-hidden="true">
						<Icon name={KIND_ICONS[artifact.kind]} size="md" />
					</span>
					<span className="attachment-text">
						<span className="attachment-name">{name}</span>
						<span className="attachment-meta">
							<span className="attachment-meta-text">{meta}</span>
							<span className="attachment-hint">
								{t(embedded ? "deliveryPreviewInBrowser" : "deliveryPreview")}
							</span>
						</span>
					</span>
				</button>
			</Tooltip>
			{embedded || system ? (
				<div className="attachment-open-group">
					{embedded ? (
						<Tooltip content={t("deliveryViewSource")}>
							<IconButton
								className="attachment-source"
								icon="code"
								iconSize="xs"
								aria-controls="rightPanel"
								aria-expanded={sourceOpen}
								aria-label={`${t("deliveryViewSource")}: ${artifact.path}`}
								onClick={toggleSource}
							/>
						</Tooltip>
					) : null}
					<Tooltip content={systemLabel}>
						<button
							type="button"
							className="attachment-system"
							aria-label={`${systemLabel}: ${artifact.path}`}
							disabled={pending}
							onClick={() => openPage(openInSystemBrowser)}
						>
							<SystemBrowserIcon browser={browser} />
						</button>
					</Tooltip>
				</div>
			) : null}
		</div>
	);
}
