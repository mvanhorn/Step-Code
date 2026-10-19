/**
 * `.user-area` at the foot of the sidebar: the signed-in account on the left,
 * and two icon buttons on the right. The phone button is a placeholder for
 * mobile remote control (not available yet); the gear opens the settings view.
 */

import { type TranslateFn, useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { LoginReport } from "../../state/types";
import { Icon, Tooltip } from "../../ui";
import { openSettings } from "../settings/actions";

function accountName(t: TranslateFn, login: LoginReport | null): string {
	if (!login?.configured) return t("footerSignedOut");
	if (login.source === "environment") return t("footerApiKey");
	return login.profile?.startsWith("step_plan") ? "Step Plan" : t("footerApiKey");
}

export function UserArea() {
	const t = useT();
	const login = useAppStore((state) => state.login);
	const name = accountName(t, login);
	return (
		<div className="user-area">
			<button
				type="button"
				className="user-account"
				id="userAccountButton"
				aria-label={t("footerAccount", { name })}
				onClick={() => openSettings("general")}
			>
				<span className="user-avatar" aria-hidden="true">
					{name.slice(0, 1).toUpperCase()}
				</span>
				<span className="user-name">{name}</span>
			</button>
			<div className="user-actions">
				<Tooltip
					id="remoteControlTip"
					className="footer-tooltip"
					content={
						<>
							<strong>{t("remoteControl")}</strong>
							<span>{t("remoteControlOff")}</span>
						</>
					}
				>
					<button
						type="button"
						className="footer-icon-button"
						id="remoteControlButton"
						aria-label={t("remoteControl")}
						aria-disabled="true"
					>
						<Icon name="phone" size="md" />
					</button>
				</Tooltip>
				<Tooltip
					id="settingsButtonTip"
					className="footer-tooltip compact"
					content={<strong>{t("settings")}</strong>}
				>
					<button
						type="button"
						className="footer-icon-button"
						id="settingsButton"
						aria-label={t("settings")}
						onClick={() => openSettings()}
					>
						<Icon name="cog" size="md" />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}
