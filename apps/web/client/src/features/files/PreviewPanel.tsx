/**
 * `aside#previewPanel` (legacy index.html 797-809,
 * 1028-1113; app.js `renderPreview` toolbar state 1820-1828 and
 * `initPreviewPanel` 1890-1980).
 */

import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useT } from "../../i18n";
import { isMacPlatform } from "../../lib/format";
import { setUi, useAppStore } from "../../state/store";
import { IconButton, ResizeHandle } from "../../ui";
import {
	applyPreviewWidth,
	copyActivePreview,
	PREVIEW_DEFAULT,
	reloadActivePreview,
	restorePreviewWidth,
	setPreviewOpen,
	togglePreviewRendered,
	togglePreviewWrap,
} from "./actions";
import { ChangesView } from "./ChangesView";
import { isMarkdownPath } from "./highlight";
import { PreviewBody, PreviewPath, useActiveTab } from "./PreviewBody";
import { PreviewTabs } from "./PreviewTabs";

function PreviewTools() {
	const t = useT();
	const tab = useActiveTab();
	const wrap = useAppStore((state) => state.preview.wrap);
	const file = tab?.file;
	const text = file?.kind === "text";
	const markdown = text && isMarkdownPath(file.path);
	return (
		<div className="preview-tools">
			<IconButton
				id="previewMode"
				icon="eye"
				iconSize="sm"
				aria-pressed={Boolean(tab?.rendered)}
				title={t("renderedPreview")}
				aria-label={t("renderedPreview")}
				hidden={!markdown}
				onClick={togglePreviewRendered}
			/>
			<IconButton
				id="previewWrap"
				icon="wrap"
				iconSize="sm"
				aria-pressed={wrap}
				title={t("wrapLines")}
				aria-label={t("wrapLines")}
				hidden={!text || Boolean(markdown && tab?.rendered)}
				// Legacy toggled `.code-view.wrap` in the click handler itself; callers read it right after.
				onClick={() => flushSync(togglePreviewWrap)}
			/>
			<IconButton
				id="previewReload"
				icon="loop"
				iconSize="sm"
				title={t("reloadFile")}
				aria-label={t("reloadFile")}
				hidden={!tab}
				onClick={reloadActivePreview}
			/>
			<IconButton
				id="previewCopy"
				icon="copy"
				iconSize="sm"
				title={t("copyFile")}
				aria-label={t("copyFile")}
				hidden={!text}
				onClick={copyActivePreview}
			/>
		</div>
	);
}

export function PreviewPanel({ embedded = false }: { readonly embedded?: boolean }) {
	const t = useT();
	const open = useAppStore((state) => state.preview.open);
	const changes = useAppStore((state) => state.preview.mode === "changes");
	const panelRef = useRef<HTMLElement>(null);

	// Before the first paint: restoring the width here avoids a jump from the default.
	useLayoutEffect(() => {
		if (!embedded) restorePreviewWidth();
	}, [embedded]);

	const panelWidth = () => panelRef.current?.getBoundingClientRect().width ?? PREVIEW_DEFAULT;

	return (
		<aside
			className="preview-panel"
			id="previewPanel"
			ref={panelRef}
			title={t("filePreview")}
			aria-label={t("filePreview")}
			hidden={!open}
		>
			<ResizeHandle
				bare
				className="preview-resizer"
				id="previewResizer"
				direction={-1}
				getSize={panelWidth}
				onResize={(width) => applyPreviewWidth(width, false)}
				onCommit={(width) => applyPreviewWidth(width)}
				onReset={() => applyPreviewWidth(PREVIEW_DEFAULT)}
				onDraggingChange={(resizing) => setUi({ resizing })}
				hidden={embedded}
			/>
			<ChangesView hidden={!open || !changes} embedded={embedded} />
			<div className="preview-tabs-row" hidden={changes}>
				<PreviewTabs />
				<IconButton
					id="previewClose"
					icon="panelRight"
					title={`${t("closePreview")} ${isMacPlatform() ? "⇧⌘B" : "Ctrl+Shift+B"}`}
					aria-label="收起文件预览"
					onClick={() => setPreviewOpen(false)}
					hidden={embedded}
				/>
			</div>
			<div className="preview-toolbar" hidden={changes}>
				<PreviewPath />
				<PreviewTools />
			</div>
			<PreviewBody hidden={changes} />
		</aside>
	);
}
