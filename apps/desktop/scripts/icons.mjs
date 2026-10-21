#!/usr/bin/env node
// Regenerate the app icons from resources/icon.svg (macOS only: Chrome renders the
// SVG, `sips` resizes, `iconutil` writes the .icns).
//
//   resources/icon.png   1024x1024; Electron window/dock icon at run time
//   resources/icon.icns  macOS app bundle icon
//   resources/icon.ico   Windows executable and installer icon (PNG-compressed entries)
//
// The SVG is the source of truth and mirrors the login page's brand tile; the
// generated files are committed so a package build needs neither Chrome nor macOS.
// `CHROME_PATH` overrides the Chrome executable.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(root, "resources");
const svg = join(resources, "icon.svg");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (process.platform !== "darwin") throw new Error("icons.mjs needs macOS (sips, iconutil)");
if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME_PATH`);

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
	}
}

const work = await mkdtemp(join(tmpdir(), "stepcode-icons-"));
try {
	const master = join(resources, "icon.png");
	run(chrome, [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--default-background-color=00000000",
		"--window-size=1024,1024",
		`--screenshot=${master}`,
		pathToFileURL(svg).href,
	]);

	const resized = async (size) => {
		const out = join(work, `${size}.png`);
		run("sips", ["-z", String(size), String(size), master, "--out", out]);
		return out;
	};

	// .icns: the standard iconset names, each at 1x and 2x.
	const iconset = join(work, "icon.iconset");
	await mkdir(iconset);
	for (const size of [16, 32, 128, 256, 512]) {
		await writeFile(join(iconset, `icon_${size}x${size}.png`), await readFile(await resized(size)));
		await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), await readFile(await resized(size * 2)));
	}
	run("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);

	// .ico: a directory of PNG entries (Windows Vista and later read PNG inside ICO).
	const sizes = [16, 24, 32, 48, 64, 128, 256];
	const images = [];
	for (const size of sizes) images.push(await readFile(await resized(size)));
	const header = Buffer.alloc(6 + 16 * sizes.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(sizes.length, 4);
	let offset = header.length;
	sizes.forEach((size, index) => {
		const entry = 6 + 16 * index;
		header.writeUInt8(size >= 256 ? 0 : size, entry);
		header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
		header.writeUInt8(0, entry + 2);
		header.writeUInt8(0, entry + 3);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(images[index].length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += images[index].length;
	});
	await writeFile(join(resources, "icon.ico"), Buffer.concat([header, ...images]));
	console.log(`[desktop] icons written to ${resources}`);
} finally {
	await rm(work, { recursive: true, force: true });
}
