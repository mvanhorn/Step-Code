import assert from "node:assert/strict";
import test from "node:test";
import { buildLoginReport, loginMethods, WebLoginController } from "../src/login.ts";

const authPath = "/home/me/.stepcode/auth.json";
const planCredential = JSON.stringify({
	step: { type: "oauth", access: "the-token", refresh: "static", expires: 1, profile: "step_plan" },
});
const readCredential = () => planCredential;

test("a stored plan credential is reported with its profile and never its value", () => {
	const report = buildLoginReport({
		status: {
			credentialConfigured: true,
			loginMethod: "step_plan",
			profile: "step_plan",
			account: "uid-1",
			validity: "valid",
			session: { state: "ready" },
		},
		authPath,
		env: {},
		read: readCredential,
		exists: () => true,
	});
	assert.deepEqual(report, {
		source: "auth.json",
		provider: "step",
		profile: "step_plan",
		path: authPath,
		configured: true,
		validity: "valid",
		session: { state: "ready" },
		loginCommand: "step login",
		planUrl: "https://platform.stepfun.com/step-plan",
	});
	// A kernel account label without a matching stored UID is not an identity.
	assert.equal(JSON.stringify(report).includes("uid-1"), false);
	assert.equal(JSON.stringify(report).includes("the-token"), false);
});

test("an unreachable provider still has a credential, and says so", () => {
	// A kernel check that cannot reach the provider reports validity: unavailable.
	// The credential is on disk either way, and telling the user to sign in again
	// would not fix a network problem.
	const report = buildLoginReport({
		status: { credentialConfigured: false, loginMethod: null, validity: "missing" },
		authPath,
		env: {},
		read: readCredential,
		exists: () => true,
	});
	assert.equal(report.configured, true);
	assert.equal(report.source, "auth.json");
	assert.equal(report.profile, "step_plan");
});

test("only a bounded stored OAuth UID matching a valid checked account reaches the report", () => {
	const status = { credentialConfigured: true, loginMethod: "step_plan" as const, profile: "step_plan" as const, account: "uid-fixture", validity: "valid" as const };
	const input = {
		status, authPath, env: {},
		read: () => JSON.stringify({ step: { type: "oauth", access: "secret-fixture", uid: " uid-fixture ", profile: "step_plan" } }),
		exists: () => true,
	};
	const report = buildLoginReport(input);
	assert.equal(report.userId, "uid-fixture");
	assert.equal(JSON.stringify(report).includes("secret-fixture"), false);
	for (const changed of [
		{ ...input, status: { ...status, account: "step_plan" } },
		{ ...input, status: { ...status, validity: "invalid" as const } },
		{ ...input, status: { ...status, validity: "unavailable" as const } },
		{ ...input, status: { ...status, credentialConfigured: false } },
		{ ...input, env: { STEP_API_KEY: "environment-fixture" } },
		{ ...input, read: () => JSON.stringify({ step: { type: "api_key", key: "key-fixture", uid: "uid-fixture" } }) },
		{ ...input, read: () => JSON.stringify({ step: { type: "oauth", access: "secret-fixture", uid: "x".repeat(257) } }) },
	]) assert.equal(buildLoginReport(changed).userId, undefined);
});

test("a rejected token keeps its source and reports the verdict", () => {
	const report = buildLoginReport({
		status: {
			credentialConfigured: true,
			loginMethod: "step_plan",
			profile: "step_plan_oversea",
			validity: "invalid",
			error: "401 Unauthorized",
		},
		authPath,
		env: {},
		// The stored profile is the authoritative record of the region, so the
		// fixture has to agree with the status it is paired with.
		read: () =>
			JSON.stringify({ step: { type: "oauth", access: "t", expires: 1, profile: "step_plan_oversea" } }),
		exists: () => true,
	});
	assert.equal(report.configured, true);
	assert.equal(report.profile, "step_plan_oversea");
	assert.equal(report.validity, "invalid");
	assert.equal("error" in report, false, "the kernel's error text is not part of the report");
});

test("an environment key is reported as coming from the environment", () => {
	const report = buildLoginReport({
		status: { credentialConfigured: true, loginMethod: "api_key", validity: "valid" },
		authPath,
		env: { STEP_API_KEY: "super-secret" },
		read: readCredential,
		exists: () => true,
	});
	assert.equal(report.source, "environment");
	assert.equal(report.configured, true);
	assert.equal("path" in report, false, "the stored file is not the source in use");
	assert.equal(JSON.stringify(report).includes("super-secret"), false);
});

test("an empty or malformed store reports none and names the command that fixes it", () => {
	for (const read of [
		() => { throw new Error("ENOENT"); },
		() => "{not json",
		() => JSON.stringify({ step: { type: "oauth", access: "   " } }),
		() => JSON.stringify({ other: { type: "oauth", access: "x" } }),
	]) {
		const report = buildLoginReport({
			status: { credentialConfigured: false, loginMethod: null, validity: "missing" },
			authPath,
			env: {},
			read,
			exists: () => false,
		});
		assert.deepEqual(report, {
			source: "none",
			configured: false,
			session: { state: "missing" },
			loginCommand: "step login",
			planUrl: "https://platform.stepfun.com/step-plan",
		});
	}
});

test("a plain API-key credential is recognised without a profile", () => {
	const report = buildLoginReport({
		status: { credentialConfigured: false, loginMethod: null, validity: "missing" },
		authPath,
		env: {},
		read: () => JSON.stringify({ step: { type: "api_key", key: "sk-not-echoed" } }),
		exists: () => true,
	});
	assert.deepEqual(report, {
		source: "auth.json",
		provider: "step",
		path: authPath,
		configured: true,
		validity: "missing",
		session: { state: "missing" },
		loginCommand: "step login",
		planUrl: "https://platform.stepfun.com/step-plan",
	});
	assert.equal(JSON.stringify(report).includes("sk-not-echoed"), false);
});

test("Upgrade leads to the Step Plan page of the credential's region", () => {
	const reportFor = (profile: string | undefined, env: Record<string, string | undefined> = {}) =>
		buildLoginReport({
			status: { credentialConfigured: true, loginMethod: "step_plan", validity: "valid" },
			authPath,
			env,
			read: () =>
				JSON.stringify({ step: { type: "api_key", key: "sk", ...(profile ? { profile } : {}) } }),
			exists: () => true,
		}).planUrl;
	assert.equal(reportFor("step_plan"), "https://platform.stepfun.com/step-plan");
	assert.equal(reportFor("platform_cn"), "https://platform.stepfun.com/step-plan");
	assert.equal(reportFor("step_plan_oversea"), "https://platform.stepfun.ai/step-plan");
	assert.equal(reportFor("platform_oversea"), "https://platform.stepfun.ai/step-plan");
	// No recorded region: the mainland platform, like the provider default.
	assert.equal(reportFor(undefined), "https://platform.stepfun.com/step-plan");
	assert.equal(reportFor("step_plan", { STEP_API_KEY: "sk-env" }), "https://platform.stepfun.com/step-plan");
	// The same endpoint overrides `step login` honours.
	assert.equal(
		reportFor("step_plan_oversea", { STEPCODE_DEVCENTER_AUTH_OVERSEA_URL: "https://dev.example.test/" }),
		"https://dev.example.test/step-plan",
	);
});

test("the desktop dialog offers the four step login profiles, split by region", () => {
	const methods = loginMethods({});
	assert.deepEqual(
		methods.map((method) => [method.id, method.credentialSource, method.region]),
		[
			["step_plan", "browser", "cn"],
			["step_plan_oversea", "browser", "global"],
			["platform_cn", "apiKey", "cn"],
			["platform_oversea", "apiKey", "global"],
		],
	);
	assert.equal(methods.find((method) => method.id === "platform_cn")?.keyPageUrl, "https://platform.stepfun.com/interface-key");
	assert.equal(
		methods.find((method) => method.id === "platform_oversea")?.keyPageUrl,
		"https://platform.stepfun.ai/interface-key",
	);
});

test("an API key sign-in reports the verdict and drops the cached report only on success", async () => {
	let saved = 0;
	const verdicts = ["invalid", "unavailable", "valid"] as const;
	const calls: string[] = [];
	const controller = new WebLoginController({
		authPath: () => authPath,
		onSaved: () => saved++,
		loginWithApiKey: async (input) => {
			calls.push(`${input.profile}:${input.apiKey}:${input.authPath}`);
			return { validity: verdicts[calls.length - 1] ?? "valid" };
		},
	});
	assert.equal(controller.isApiKeyMethod("platform_cn"), true);
	assert.equal(controller.isApiKeyMethod("step_plan"), false);
	assert.deepEqual(await controller.withApiKey("platform_cn", "sk-1"), {
		ok: false,
		code: "invalid_key",
		error: "The API key was rejected",
	});
	assert.equal((await controller.withApiKey("platform_cn", "sk-1")).ok, false);
	assert.equal(saved, 0);
	assert.deepEqual(await controller.withApiKey("platform_oversea", "sk-2"), { ok: true });
	assert.equal(saved, 1);
	assert.deepEqual(calls.at(-1), `platform_oversea:sk-2:${authPath}`);
});

test("a browser sign-in answers with the authorize URL, completes in the background, and can be cancelled", async () => {
	let saved = 0;
	let finish!: () => void;
	const controller = new WebLoginController({
		authPath: () => authPath,
		onSaved: () => saved++,
		loginInBrowser: (input) => {
			input.onAuthUrl(`https://platform.stepfun.com/cli-login-remote?profile=${input.profile}`);
			return new Promise<void>((resolve, reject) => {
				finish = resolve;
				input.signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
	});
	assert.equal(controller.isBrowserMethod("step_plan"), true);
	assert.equal(controller.isBrowserMethod("platform_cn"), false);
	const started = await controller.startBrowser("step_plan");
	assert.deepEqual(started, {
		state: "pending",
		profile: "step_plan",
		authUrl: "https://platform.stepfun.com/cli-login-remote?profile=step_plan",
	});
	finish();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(controller.browserState(), { state: "completed", profile: "step_plan" });
	assert.equal(saved, 1);

	await controller.startBrowser("step_plan_oversea");
	controller.cancelBrowser();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(controller.browserState(), { state: "idle" });
	assert.equal(saved, 1);
});

test("cancelAll waits for sign-ins that are still writing, and their success is not reported", async () => {
	let saved = 0;
	let finishKey!: () => void;
	let finishBrowser!: () => void;
	const order: string[] = [];
	const controller = new WebLoginController({
		authPath: () => authPath,
		onSaved: () => saved++,
		// Both stand-ins ignore the abort, like a sign-in already past its last
		// abort check and busy writing the credential.
		loginWithApiKey: () =>
			new Promise((resolve) => {
				finishKey = () => {
					order.push("key written");
					resolve({ validity: "valid" });
				};
			}),
		loginInBrowser: (input) => {
			input.onAuthUrl("https://platform.stepfun.com/cli-login-remote");
			return new Promise((resolve) => {
				finishBrowser = () => {
					order.push("browser written");
					resolve({ session: "saved" });
				};
			});
		},
	});
	const key = controller.withApiKey("platform_cn", "sk-1");
	await controller.startBrowser("step_plan");
	const cancelled = controller.cancelAll().then(() => order.push("cancelled"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(order, [], "cancelAll is still waiting");
	finishBrowser();
	finishKey();
	await cancelled;
	assert.deepEqual(order, ["browser written", "key written", "cancelled"]);
	assert.deepEqual(await key, { ok: false, code: "unavailable", error: "The sign-in was cancelled" });
	assert.deepEqual(controller.browserState(), { state: "idle" });
	assert.equal(saved, 0);
	await controller.cancelAll();
});

test("a browser sign-in that fails before a URL reports the failure", async () => {
	const controller = new WebLoginController({
		authPath: () => authPath,
		onSaved: () => {},
		loginInBrowser: async () => {
			throw new Error("init failed");
		},
	});
	assert.deepEqual(await controller.startBrowser("step_plan"), {
		state: "failed",
		profile: "step_plan",
		error: "init failed",
	});
});
