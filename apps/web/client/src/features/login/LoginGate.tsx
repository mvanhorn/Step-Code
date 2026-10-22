import { type FormEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { useAppStore } from "../../state/store";
import type { LoginMethod } from "../../state/types";
import { Icon, Spinner } from "../../ui";
import {
	cancelBrowserSignIn,
	continueWithOwnModels,
	loadLoginMethods,
	openLoginPage,
	signInWithApiKey,
	signInWithBrowser,
} from "./actions";

type View = { readonly kind: "choose" } | { readonly kind: "apiKey" } | { readonly kind: "browser"; authUrl: string };

/**
 * Stable element ids for the two ways per region, so tests and old links keep
 * working: `loginStepPlan` / `loginStepPlanGlobal`, `loginApiKey` / `loginApiKeyGlobal`.
 */
const LOGIN_METHOD_IDS: Readonly<Record<string, string>> = {
	step_plan: "loginStepPlan",
	step_plan_oversea: "loginStepPlanGlobal",
	platform_cn: "loginApiKey",
	platform_oversea: "loginApiKeyGlobal",
};

/** Placeholder brand mark: the purple "C" ring with the yellow prompt chevron. */
function StepCodeMark({ className }: { readonly className?: string }) {
	return (
		<svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
			<path
				d="M34.6 13.4A15 15 0 1 0 34.6 34.6"
				fill="none"
				stroke="#8f7cff"
				strokeWidth="7"
				strokeLinecap="round"
			/>
			<path
				d="m21 17.5 6.5 6.5-6.5 6.5"
				fill="none"
				stroke="#f6b73c"
				strokeWidth="4.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * The sign-in gate (`#loginGate`). Shown while bootstrap waits because no model
 * can run: no Step credential and no usable custom model. There is no close
 * button, no backdrop click, and the shell ignores Escape and shortcuts while it
 * is open; "Use your own models" is the way past it without a Step account.
 *
 * Choose: Step Plan (browser) or API key, for the mainland or the
 * international platform, or skip to the models settings (bring your own key).
 * API key: pick the platform, paste the key, and the
 * host validates it before saving; Cancel returns to the choice.
 */
export function LoginGate() {
	const t = useT();
	const open = useAppStore((state) => state.ui.loginRequired);
	const [methods, setMethods] = useState<readonly LoginMethod[]>([]);
	const [methodsStatus, setMethodsStatus] = useState<"idle" | "loading" | "failed">("idle");
	const [view, setView] = useState<View>({ kind: "choose" });
	// The profile a sign-in is running for, so its own row shows the wait.
	const [pendingId, setPendingId] = useState<LoginMethod["id"] | undefined>(undefined);
	// The method whose API key is being entered.
	const [keyMethodId, setKeyMethodId] = useState<LoginMethod["id"] | undefined>(undefined);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const keyInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open || methods.length || methodsStatus === "loading") return;
		setMethodsStatus("loading");
		loadLoginMethods().then(
			(found) => {
				setMethods(found);
				setMethodsStatus("idle");
			},
			(caught: unknown) => {
				setMethodsStatus("failed");
				setError(errorMessage(caught));
			},
		);
	}, [open, methods.length, methodsStatus]);

	useEffect(() => {
		if (view.kind === "apiKey") keyInput.current?.focus();
	}, [view.kind]);

	// The API-key form targets the row that was chosen, not a region toggle.
	const keyMethod = methods.find((method) => method.id === keyMethodId);

	const backToChoice = () => {
		if (view.kind === "browser") cancelBrowserSignIn();
		setView({ kind: "choose" });
		setBusy(false);
		setPendingId(undefined);
		setError("");
	};

	/** Step Plan in the system browser for the chosen region. */
	const startPlan = async (method: LoginMethod) => {
		if (busy) return;
		setError("");
		setBusy(true);
		setPendingId(method.id);
		setView({ kind: "browser", authUrl: "" });
		try {
			const outcome = await signInWithBrowser(method.id, (authUrl) => setView({ kind: "browser", authUrl }));
			// A cancelled sign-in returns to the choice; a completed one closes the gate.
			if (outcome.outcome === "cancelled") backToChoice();
		} catch (caught) {
			setView({ kind: "choose" });
			setBusy(false);
			setPendingId(undefined);
			setError(t("loginBrowserFailed", { error: errorMessage(caught) }));
		}
	};

	/** Paste a platform key for the chosen region. */
	const openApiKey = (method: LoginMethod) => {
		setKeyMethodId(method.id);
		setApiKey("");
		setError("");
		setView({ kind: "apiKey" });
	};

	const submitApiKey = async (event: FormEvent) => {
		event.preventDefault();
		if (!keyMethod || busy) return;
		if (!apiKey.trim()) {
			setError(t("loginEmptyKey"));
			return;
		}
		setBusy(true);
		setError("");
		const outcome = await signInWithApiKey(keyMethod.id, apiKey.trim());
		setBusy(false);
		if (outcome.kind === "invalid") setError(t("loginInvalidKey"));
		else if (outcome.kind === "unavailable") setError(t("loginUnavailable"));
		else if (outcome.kind === "error") setError(t("loginFailed", { error: outcome.message }));
	};

	return (
		<div className="login-gate" id="loginGate" hidden={!open}>
			<section className="login-card" role="dialog" aria-modal="true" aria-labelledby="loginGateTitle">
				<div className="login-logo">
					<StepCodeMark className="login-logo-mark" />
				</div>
				<h1 className="login-title" id="loginGateTitle">
					{t("loginWelcome")}
				</h1>
				<p className="login-subtitle">{t("loginSubtitle")}</p>

				{view.kind === "choose" && (
					<div className="login-body">
						{/*
						 * All four `step login` profiles at once, the same four the settings
						 * page lists: region and method are one choice, not two nested steps.
						 * Choosing says what happens next instead of making the user infer it
						 * from a "region" switch.
						 */}
						<fieldset className="login-methods" aria-label={t("loginMethodsTitle")}>
							{methods.map((method) => {
								const id = LOGIN_METHOD_IDS[method.id] ?? method.id;
								const plan = method.credentialSource === "browser";
								const regionLabel = t(method.region === "cn" ? "loginRegionCn" : "loginRegionGlobal");
								return (
									<button
										type="button"
										key={method.id}
										id={id}
										data-login-profile={method.id}
										data-pending={pendingId === method.id || undefined}
										className={cx("login-method", plan && "plan")}
										disabled={busy}
										onClick={() => (plan ? void startPlan(method) : openApiKey(method))}
									>
										<span className="login-method-icon" aria-hidden="true">
											{pendingId === method.id ? (
												<Spinner />
											) : plan ? (
												<StepCodeMark className="login-method-mark" />
											) : (
												<Icon name="keyRound" size="sm" />
											)}
										</span>
										<span className="login-method-text">
											<strong>{plan ? t("loginStepPlan") : t("loginApiKey")}</strong>
											<small>{regionLabel}</small>
										</span>
										<small className="login-method-hint">
											{t(
												plan
													? method.region === "cn"
														? "loginMethodPlanCnHint"
														: "loginMethodPlanGlobalHint"
													: method.region === "cn"
														? "loginMethodKeyCnHint"
														: "loginMethodKeyGlobalHint",
											)}
										</small>
									</button>
								);
							})}
						</fieldset>
						{methodsStatus !== "idle" && !methods.length ? (
							<p className="login-hint">{methodsStatus === "loading" ? <Spinner /> : t("loginMethodsFailed")}</p>
						) : null}
						{error && (
							<p className="login-error" role="alert">
								{error}
							</p>
						)}
						<p className="login-switch login-own-models">
							{t("loginOwnModelsHint")}{" "}
							<button type="button" className="login-link" id="loginOwnModels" onClick={continueWithOwnModels}>
								{t("loginOwnModels")}
							</button>
						</p>
					</div>
				)}

				{view.kind === "apiKey" && (
					<form className="login-body" onSubmit={(event) => void submitApiKey(event)}>
						<label className="login-label" htmlFor="loginApiKeyInput">
							{t("loginApiKeyLabel")}
						</label>
						<div className="login-key-field">
							<input
								ref={keyInput}
								id="loginApiKeyInput"
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder={t("loginApiKeyPlaceholder")}
								value={apiKey}
								disabled={busy}
								onChange={(event) => {
									setApiKey(event.currentTarget.value);
									setError("");
								}}
							/>
							<button
								type="button"
								className="login-key-link"
								disabled={!keyMethod}
								onClick={() => keyMethod && openLoginPage(keyMethod.keyPageUrl)}
							>
								{t("loginGetApiKey")}
							</button>
						</div>
						{error && (
							<p className="login-error" role="alert">
								{error}
							</p>
						)}
						<button
							type="submit"
							className="login-button primary"
							id="loginApiKeyContinue"
							disabled={busy || !apiKey.trim() || !keyMethod}
						>
							{busy ? t("loginVerifying") : t("loginContinue")}
						</button>
						<button type="button" className="login-button secondary" disabled={busy} onClick={backToChoice}>
							{t("loginCancel")}
						</button>
					</form>
				)}

				{view.kind === "browser" && (
					<div className="login-body">
						<output className="login-waiting">
							<Spinner />
							<span>{view.authUrl ? t("loginBrowserWaiting") : t("loginBrowserStarting")}</span>
						</output>
						{view.authUrl && <p className="login-hint">{t("loginBrowserHint")}</p>}
						{view.authUrl && (
							<button
								type="button"
								className="login-button secondary"
								onClick={() => openLoginPage(view.authUrl)}
							>
								{t("loginBrowserReopen")}
							</button>
						)}
						<button type="button" className="login-button secondary" onClick={backToChoice}>
							{t("loginCancel")}
						</button>
					</div>
				)}
			</section>
		</div>
	);
}
