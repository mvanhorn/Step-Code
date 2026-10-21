/** Local references are presentation candidates, never authority to read a file. */
export function localFileReference(value: string): string | undefined {
	if (!value || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return;
	let path: string;
	try {
		if (/^file:/i.test(value)) {
			const url = new URL(value);
			if (url.hostname || url.search) return;
			path = decodeURIComponent(url.pathname);
		} else {
			if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return;
			path = decodeURIComponent(value.split("#", 1)[0]);
		}
	} catch {
		return;
	}
	path = path.replace(/^\/([a-z]:[\\/])/i, "$1").replace(/:\d+(?::\d+)?$/, "");
	if (/[\u0000-\u001f<>:"|?*]/u.test(path.replace(/^[a-z]:/i, "")) || /^[\\/]{2}/.test(path)) return;
	if (
		/^(?:[a-z]:[\\/]|\/|\.\.?[\\/])/i.test(path) ||
		/^[^:/\\]+\.[a-z\d]+$/i.test(path) ||
		/^[^:]+[\\/][^:]+\.[a-z\d]+$/i.test(path)
	)
		return path;
}

function normalizedParts(path: string): string[] | undefined {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return;
			parts.pop();
		} else parts.push(part);
	}
	return parts;
}

/** Lexical client guard only; the host still checks real paths and symlinks. */
export function workspaceFileReference(cwd: string, value: string, sourcePath = ""): string | undefined {
	const local = localFileReference(value);
	if (!cwd || !local) return;
	return workspaceFilePath(cwd, local, sourcePath);
}

/** Structured tool paths are already literal filenames, not encoded Markdown URLs. */
export function workspaceFilePath(cwd: string, local: string, sourcePath = ""): string | undefined {
	if (!cwd || !local || /[\u0000-\u001f]/u.test(local) || /^[\\/]{2}/.test(local)) return;
	const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const path = local.replace(/\\/g, "/");
	const windows = /^[a-z]:\//i.test(root);
	const rootParts = normalizedParts(root);
	if (!rootParts) return;
	const absolute = /^[a-z]:\//i.test(path) || path.startsWith("/");
	const parts = normalizedParts(absolute ? path : `${root}/${sourcePath.split("/").slice(0, -1).join("/")}/${path}`);
	if (!parts || parts.length <= rootParts.length) return;
	if (absolute && /^[a-z]:\//i.test(path) !== windows) return;
	for (let index = 0; index < rootParts.length; index++) {
		const left = parts[index];
		const right = rootParts[index];
		if (windows ? left?.toLowerCase() !== right.toLowerCase() : left !== right) return;
	}
	return parts.slice(rootParts.length).join("/");
}

export type ArtifactKind =
	| "website"
	| "image"
	| "document"
	| "spreadsheet"
	| "presentation"
	| "audio"
	| "video"
	| "file";

export function artifactKind(path: string): ArtifactKind {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	if (["html", "htm"].includes(extension)) return "website";
	if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "ico"].includes(extension)) return "image";
	if (["pdf", "docx", "doc", "md", "mdx", "txt", "rtf"].includes(extension)) return "document";
	if (["xlsx", "xls", "csv", "tsv"].includes(extension)) return "spreadsheet";
	if (["pptx", "ppt"].includes(extension)) return "presentation";
	if (["wav", "mp3", "ogg", "flac", "m4a"].includes(extension)) return "audio";
	if (["mp4", "webm", "mov"].includes(extension)) return "video";
	return "file";
}
