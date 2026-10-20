/**
 * General: interface language, and the account: its plan and region, the Step
 * Plan upgrade link (the account's own platform, so overseas accounts go to
 * platform.stepfun.ai) and sign out. The sidebar's account menu offers the
 * same two actions.
 */

import { type TranslateFn, useT } from "../../i18n";
import type { Locale } from "../../i18n/messages";
import { cx } from "../../lib/format";
import { useAppStore } from "../../state/store";
import type { LoginReport } from "../../state/types";
import { Icon } from "../../ui";
import { applyLocale, logout, stepPlanUrl } from "../shell/actions";
import { PageHeader, SectionHeader, SettingRow, SettingsCard } from "./parts";

/** Language names are shown in their own language, never translated. */
const LANGUAGE_CHOICES: ReadonlyArray<{ readonly value: Locale; readonly label: string }> = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en-US", label: "English" },
];

const PROFILE_LABELS: Readonly<Record<string, string>> = {
	step_plan: "settingsAccountStepPlanCn",
	step_plan_oversea: "settingsAccountStepPlanGlobal",
	platform_cn: "settingsAccountPlatformCn",
	platform_oversea: "settingsAccountPlatformGlobal",
};

function accountLabel(t: TranslateFn, login: LoginReport | null): string {
	if (!login?.configured) return t("settingsAccountNone");
	if (login.source === "environment") return t("settingsAccountEnvironment");
	const key = login.profile ? PROFILE_LABELS[login.profile] : undefined;
	return key ? t(key) : (login.provider ?? t("settingsAccountSignedIn"));
}

export function GeneralPage() {
	const t = useT();
	const locale = useAppStore((state) => state.locale);
	const login = useAppStore((state) => state.login);
	return (
		<>
			<PageHeader title={t("settingsGeneral")} description={t("settingsGeneralDesc")} />
			<SettingsCard>
				<SettingRow
					title={t("settingsLanguage")}
					description={t("settingsLanguageDesc")}
					control={
						<div className="settings-choice-group">
							{LANGUAGE_CHOICES.map((choice) => (
								<button
									key={choice.value}
									type="button"
									aria-pressed={locale === choice.value}
									className={cx("settings-choice", locale === choice.value && "active")}
									data-language-choice={choice.value}
									onClick={() => applyLocale(choice.value)}
								>
									{choice.label}
								</button>
							))}
						</div>
					}
				/>
			</SettingsCard>

			<SectionHeader title={t("settingsAccount")} />
			<SettingsCard>
				<SettingRow
					title={t("settingsAccountCurrent")}
					description={<span id="settingsAccountLabel">{accountLabel(t, login)}</span>}
					control={
						<a
							className="settings-btn"
							id="stepPlanLink"
							href={stepPlanUrl(login)}
							target="_blank"
							rel="noopener noreferrer"
						>
							<Icon name="upgrade" size="xs" />
							{t("upgrade")}
							<Icon name="external" size="xs" />
						</a>
					}
				/>
				<SettingRow
					title={t("logout")}
					description={t("settingsLogoutDesc")}
					control={
						<button type="button" className="settings-btn danger" id="logoutButton" onClick={logout}>
							<Icon name="logout" size="xs" />
							{t("logout")}
						</button>
					}
				/>
			</SettingsCard>
		</>
	);
}
