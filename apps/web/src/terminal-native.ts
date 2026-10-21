import { constants } from "node:fs";
import { access, chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type TerminalSupport = { available: true } | { available: false; reason: string };

/** The directories node-pty's own loader probes, in the same order. */
function nativeDirectories(root: string, platform: NodeJS.Platform, arch: string): string[] {
	return [
		join(root, "build", "Release"),
		join(root, "build", "Debug"),
		join(root, "prebuilds", `${platform}-${arch}`),
	];
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks the native pieces node-pty needs before a helper is started, so an unusable install is
 * reported instead of failing every shell with `posix_spawnp failed`.
 *
 * node-pty 1.1.0 publishes its macOS `spawn-helper` without the executable bit and its install script
 * never restores it. The Host adds execute permission where the file is already readable; this repairs
 * the published file mode only. It never installs, downloads or compiles a native module.
 */
export async function terminalSupport(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	resolveRoot: () => string = () => dirname(dirname(createRequire(import.meta.url).resolve("node-pty"))),
): Promise<TerminalSupport> {
	let root: string;
	try {
		root = resolveRoot();
	} catch {
		return { available: false, reason: "node-pty is not installed for the Web Host." };
	}
	let native: string | undefined;
	for (const directory of nativeDirectories(root, platform, arch)) {
		if (await exists(join(directory, "pty.node"))) {
			native = directory;
			break;
		}
	}
	if (!native)
		return {
			available: false,
			reason: `node-pty has no native build for ${platform}-${arch}. Run \`pnpm rebuild node-pty\` with a C++ build toolchain, then retry.`,
		};
	// Only the macOS build launches shells through a separate spawn-helper executable.
	if (platform !== "darwin") return { available: true };
	const helper = join(native, "spawn-helper");
	try {
		await access(helper, constants.X_OK);
		return { available: true };
	} catch {
		// Fall through: the helper is missing or lacks execute permission.
	}
	try {
		const mode = (await stat(helper)).mode;
		// Grant execute only to the classes that may already read the file.
		await chmod(helper, (mode & 0o7777) | ((mode & 0o444) >> 2));
		await access(helper, constants.X_OK);
		return { available: true };
	} catch {
		return {
			available: false,
			reason: `node-pty's spawn-helper is not executable. Run \`chmod +x "${helper}"\`, then retry.`,
		};
	}
}
