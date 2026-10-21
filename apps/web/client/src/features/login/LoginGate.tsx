import { type FormEvent, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { useAppStore } from "../../state/store";
import type { LoginMethod } from "../../state/types";
import { Spinner } from "../../ui";
import {
	cancelBrowserSignIn,
	continueWithOwnModels,
	loadLoginMethods,
	openLoginPage,
	signInWithApiKey,
	signInWithBrowser,
} from "./actions";

type Region = LoginMethod["region"];
type View = { readonly kind: "choose" } | { readonly kind: "apiKey" } | { readonly kind: "browser"; authUrl: string };

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

function methodFor(methods: readonly LoginMethod[], region: Region, source: LoginMethod["credentialSource"]) {
	return methods.find((method) => method.region === region && method.credentialSource === source);
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
	const [region, setRegion] = useState<Region>("cn");
	const [view, setView] = useState<View>({ kind: "choose" });
	const [keyRegion, setKeyRegion] = useState<Region>("cn");
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const keyInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open || methods.length) return;
		loadLoginMethods().then(setMethods, (caught: unknown) => setError(errorMessage(caught)));
	}, [open, methods.length]);

	useEffect(() => {
		if (view.kind === "apiKey") keyInput.current?.focus();
	}, [view.kind]);

	const plan = methodFor(methods, region, "browser");
	const keyMethod = methodFor(methods, keyRegion, "apiKey");

	const backToChoice = () => {
		if (view.kind === "browser") cancelBrowserSignIn();
		setView({ kind: "choose" });
		setBusy(false);
		setError("");
	};

	const startPlan = async () => {
		if (!plan) return;
		setError("");
		setView({ kind: "browser", authUrl: "" });
		try {
			await signInWithBrowser(plan.id, (authUrl) => setView({ kind: "browser", authUrl }));
		} catch (caught) {
			setView({ kind: "choose" });
			setError(t("loginBrowserFailed", { error: errorMessage(caught) }));
		}
	};

	const openApiKey = () => {
		setKeyRegion(region);
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
						<button
							type="button"
							className="login-button primary"
							id="loginStepPlan"
							disabled={!plan}
							onClick={() => void startPlan()}
						>
							<StepCodeMark className="login-button-mark" />
							<span>{t("loginStepPlan")}</span>
							<span className="login-badge">{t(region === "cn" ? "loginRegionCn" : "loginRegionGlobal")}</span>
						</button>
						<button
							type="button"
							className="login-button secondary"
							id="loginApiKey"
							disabled={!methods.length}
							onClick={openApiKey}
						>
							{t("loginApiKey")}
						</button>
						{error && (
							<p className="login-error" role="alert">
								{error}
							</p>
						)}
						<p className="login-switch">
							{t(region === "cn" ? "loginSwitchToGlobalHint" : "loginSwitchToCnHint")}{" "}
							<button
								type="button"
								className="login-link"
								id="loginSwitchRegion"
								onClick={() => {
									setRegion(region === "cn" ? "global" : "cn");
									setError("");
								}}
							>
								{t(region === "cn" ? "loginSwitchToGlobal" : "loginSwitchToCn")}
							</button>
						</p>
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
