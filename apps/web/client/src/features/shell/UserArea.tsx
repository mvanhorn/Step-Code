/**
 * `.user-area` at the foot of the sidebar: the signed-in account on the left,
 * and two icon buttons on the right. The phone button is a placeholder for
 * mobile remote control (not available yet); the gear opens the settings view.
 *
 * The account shows the nickname and avatar the host reads from the account
 * session (`GET /api/v1/account`). Without one (API-key sign-in, or the
 * developer center unreachable) it falls back to a label for the credential.
 */

import { useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { AccountReport, LoginReport } from "../../state/types";
import { Icon, Tooltip } from "../../ui";
import { openSettings } from "../settings/actions";

function isStepPlan(login: LoginReport | null): boolean {
	return login?.source === "auth.json" && login.profile?.startsWith("step_plan") === true;
}

/** The name to show; empty while a Step Plan account is still being looked up. */
function accountName(t: TranslateFn, login: LoginReport | null, account: AccountReport | null): string {
	if (!login?.configured) return t("footerSignedOut");
	if (account?.account) return account.account.name;
	if (!isStepPlan(login)) return t("footerApiKey");
	return account ? t("footerSignedIn") : "";
}

function AccountAvatar({ name, url }: { name: string; url: string | undefined }) {
	// Remember which URL failed, so a new URL gets a fresh attempt.
	const [brokenUrl, setBrokenUrl] = useState<string>();
	return (
		<span className="user-avatar" aria-hidden="true">
			{url && url !== brokenUrl ? (
				<img
					className="user-avatar-image"
					src={url}
					alt=""
					referrerPolicy="no-referrer"
					draggable={false}
					onError={() => setBrokenUrl(url)}
				/>
			) : (
				name.slice(0, 1).toUpperCase()
			)}
		</span>
	);
}

export function UserArea() {
	const t = useT();
	const login = useAppStore((state) => state.login);
	const account = useAppStore((state) => state.account);
	const name = accountName(t, login, account);
	const avatarUrl = login?.configured ? account?.account?.avatarUrl : undefined;
	return (
		<div className="user-area">
			<button
				type="button"
				className="user-account"
				id="userAccountButton"
				aria-label={t("footerAccount", { name })}
				onClick={() => openSettings("general")}
			>
				<AccountAvatar name={name} url={avatarUrl} />
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
