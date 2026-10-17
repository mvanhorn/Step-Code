import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@step-harness/coding-agent";

/**
 * The Step CLI entry that subagent and workflow children run.
 *
 * Children are spawned with `--mode rpc`, which only the CLI accepts. Without
 * an explicit entry the runner relaunches the current `argv[1]`, which for this
 * host is the Web server: the child then fails before it reads its first
 * command and the parent only sees "Subagent exited with code 1".
 *
 * - Source host (`pnpm web`, `*.ts` entry): the CLI source next to this app, so
 *   children run the same working tree under the forwarded tsx loader.
 * - Compiled host (`dist/*.js`): the coding-agent package's `bin.step` bundle.
 *
 * Returns the source entry when it exists, otherwise the bundle path even if it
 * is missing, so the runner reports the missing file instead of starting the
 * Web server again.
 */
export function resolveSubagentCliPath(
	hostModuleUrl: string = import.meta.url,
	codingAgentDir: string = getPackageDir(),
): string {
	const hostFile = fileURLToPath(hostModuleUrl);
	if (/\.[cm]?ts$/u.test(hostFile)) {
		const sourceEntry = fileURLToPath(new URL("../../cli/src/main.ts", hostModuleUrl));
		if (existsSync(sourceEntry)) return sourceEntry;
	}
	return join(codingAgentDir, "dist", "bundle", "step.js");
}
