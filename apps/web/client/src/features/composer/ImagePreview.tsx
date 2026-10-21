/** `#imagePreview`: a staged image attachment, enlarged (opened from its thumbnail in `#attachmentList`). */

import { useT } from "../../i18n";
import { setUi, useAppStore } from "../../state/store";
import { IconButton, Modal } from "../../ui";

const close = () => setUi({ imagePreview: null });

export function ImagePreview() {
	const t = useT();
	const preview = useAppStore((state) => state.ui.imagePreview);
	return (
		<Modal
			open={preview !== null}
			onClose={close}
			id="imagePreview"
			overlayClassName="image-preview-overlay"
			className="image-preview-dialog"
			dialogProps={{ "aria-label": preview?.name ?? t("previewImage") }}
		>
			{preview && <img src={preview.src} alt={preview.name} />}
			<IconButton
				className="image-preview-close"
				icon="close"
				title={t("closeImagePreview")}
				aria-label={t("closeImagePreview")}
				onClick={close}
			/>
		</Modal>
	);
}
