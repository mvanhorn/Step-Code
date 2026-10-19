/** `#fileDropOverlay`: shown while files from the file manager are dragged over the window. */

import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { Icon } from "../../ui";

/**
 * Purely visual: it ignores the pointer, so the drop reaches whatever is
 * under it (PromptInput owns the drag listeners and stages the files).
 * Portalled to `<body>`: `.composer-card` is a stacking context, and the
 * overlay must cover the sidebar and every panel.
 */
export function FileDropOverlay({ open }: { readonly open: boolean }) {
	const t = useT();
	return createPortal(
		<div id="fileDropOverlay" className="file-drop-overlay" hidden={!open} aria-hidden="true">
			<div className="file-drop-art">
				<span className="file-drop-card file-drop-card--file">
					<Icon name="fileText" />
				</span>
				<span className="file-drop-card file-drop-card--image">
					<Icon name="image" />
				</span>
			</div>
			<p className="file-drop-title">{t("fileDropTitle")}</p>
			<p className="file-drop-hint">{t("fileDropHint")}</p>
		</div>,
		document.body,
	);
}
