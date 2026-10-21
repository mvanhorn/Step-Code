/**
 * General: interface language. Account actions live on the Account page.
 */

import { useT } from "../../i18n";
import type { Locale } from "../../i18n/messages";
import { cx } from "../../lib/format";
import { useAppStore } from "../../state/store";
import { applyLocale } from "../shell/actions";
import { PageHeader, SettingRow, SettingsCard } from "./parts";

/** Language names are shown in their own language, never translated. */
const LANGUAGE_CHOICES: ReadonlyArray<{ readonly value: Locale; readonly label: string }> = [
	{ value: "zh-CN", label: "简体中文" },
	{ value: "en-US", label: "English" },
];

export function GeneralPage() {
	const t = useT();
	const locale = useAppStore((state) => state.locale);
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
		</>
	);
}
