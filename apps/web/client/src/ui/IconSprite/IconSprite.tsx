import { cx } from "../../lib/format";
import styles from "./IconSprite.module.css";

/**
 * Every icon the client uses, as `<symbol id="i-<name>">` entries that
 * `<Icon name>` references with `<use href="#i-<name>">`. Ported verbatim from
 * legacy public/index.html (lines 10-536). Render it once, at the top of the
 * app. Kept hidden without `display: none`, which would stop `<use>` from
 * resolving.
 */
export const ICON_NAMES = [
	"sidebar",
	"newChat",
	"search",
	"archive",
	"back",
	"external",
	"upgrade",
	"theme",
	"thumbsUp",
	"thumbsDown",
	"fork",
	"gauge",
	"chevronLeft",
	"chevronRight",
	"language",
	"settings",
	"logout",
	"chevronDown",
	"shield",
	"chevron",
	"send",
	"folder",
	"folderPlus",
	"closeSm",
	"close",
	"searchLg",
	"up",
	"file",
	"tree",
	"open",
	"plus",
	"more",
	"tool",
	"copy",
	"target",
	"listCheck",
	"layers",
	"orbit",
	"paperclip",
	"close-sm",
	"brain",
	"cube",
	"check",
	"star",
	"eye",
	"zap",
	"loop",
	"wrap",
	"panelRight",
	"tag",
	"clock",
	"puzzle",
	"question",
	"pencil",
	"terminal",
	"fileDiff",
	"undo",
	"openExternal",
	"fileSearch",
	"mcp",
	"cog",
	"phone",
	"sliders",
	"palette",
	"wand",
	"trash",
	"refresh",
	"download",
	"store",
	"globe",
	"fileText",
	"squarePen",
	"prompt",
	"wrench",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export function IconSprite() {
	return (
		<svg className={cx(styles.root, "icon-sprite")} aria-hidden="true" focusable="false">
			{/* Lucide settings, smartphone, sliders-horizontal, palette, wand-sparkles, trash-2, refresh-cw, download, store and globe, adapted to the shared sprite. */}
			<symbol
				id="i-cog"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
				<circle cx="12" cy="12" r="3" />
			</symbol>
			<symbol
				id="i-phone"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<rect x="5" y="2" width="14" height="20" rx="2.5" />
				<path d="M11 18h2" />
			</symbol>
			<symbol
				id="i-sliders"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M20 7h-9M14 17H4" />
				<circle cx="7" cy="7" r="3" />
				<circle cx="17" cy="17" r="3" />
			</symbol>
			<symbol
				id="i-palette"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.12a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z" />
				<circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
				<circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
				<circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
				<circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
			</symbol>
			<symbol
				id="i-wand"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
				<path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9" />
			</symbol>
			<symbol
				id="i-trash"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
			</symbol>
			<symbol
				id="i-refresh"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5" />
			</symbol>
			<symbol
				id="i-download"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
			</symbol>
			<symbol
				id="i-store"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4M2 7h20M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2.7 2.7 0 0 1-2-1 2.7 2.7 0 0 1-2 1 2 2 0 0 1-2-2V7" />
			</symbol>
			<symbol
				id="i-globe"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<circle cx="12" cy="12" r="10" />
				<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
			</symbol>
			{/* Lucide square-terminal, adapted to the shared sprite. */}
			<symbol
				id="i-terminal"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<rect x="3" y="3" width="18" height="18" rx="2" />
				<path d="m7 9 3 3-3 3M13 15h4" />
			</symbol>
			{/* Lucide message-circle-question and Feather edit-2; see docs/THIRD_PARTY_PROVENANCE.md. */}
			<symbol
				id="i-question"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
				<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
				<path d="M12 17h.01" />
			</symbol>
			<symbol
				id="i-pencil"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M17 3a2.828 2.828 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
			</symbol>
			{/* Lucide file-text, square-pen, terminal and wrench, for tool-call rows; see docs/THIRD_PARTY_PROVENANCE.md. */}
			<symbol
				id="i-fileText"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
				<path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8" />
			</symbol>
			<symbol
				id="i-squarePen"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
				<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
			</symbol>
			<symbol
				id="i-prompt"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="m4 17 6-6-6-6M12 19h8" />
			</symbol>
			<symbol
				id="i-wrench"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
			</symbol>
			<symbol id="i-sidebar" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<rect x="1.75" y="2.75" width="14.5" height="12.5" rx="2" />
				<path d="M6.5 2.75v12.5" />
			</symbol>
			<symbol
				id="i-newChat"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
			>
				<path d="M3 4.5A2.5 2.5 0 0 1 5.5 2h7A2.5 2.5 0 0 1 15 4.5v6a2.5 2.5 0 0 1-2.5 2.5H8l-3.6 2.5.7-2.5A2.5 2.5 0 0 1 3 10.5z" />
				<path d="M9 5.25v4.5M6.75 7.5h4.5" />
			</symbol>
			<symbol id="i-search" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
				<circle cx="7.75" cy="7.75" r="4.75" />
				<path d="m11.25 11.25 3.75 3.75" />
			</symbol>
			<symbol id="i-archive" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M3 5.25h12v9.25H3z" />
				<path d="M2.25 2.75h13.5v3H2.25zM7 8.5h4" />
			</symbol>
			<symbol
				id="i-back"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M14.5 9h-11M7 4.75 2.75 9 7 13.25" />
			</symbol>
			<symbol id="i-external" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M4 13.75 14 3.75M8.5 3.75H14v5.5" />
				<path d="M2.75 6.25v8.5h8.5" />
			</symbol>
			<symbol id="i-upgrade" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M6 2.5h7.5V10M13.5 2.5 5.5 10.5" />
				<path d="M10.5 7.5v6h-8v-8h6" />
			</symbol>
			<symbol id="i-theme" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<circle cx="9" cy="9" r="3.5" />
				<path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" />
			</symbol>
			<symbol
				id="i-thumbsUp"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M6.5 15.5V8.5L9.5 3.2a1.6 1.6 0 0 1 2.1 2.3l-.8 1.5h3.1a1.6 1.6 0 0 1 1.55 2l-1.1 4.4a1.6 1.6 0 0 1-1.55 1.1z" />
				<path d="M6.5 8.5H3.4v7h3.1" />
			</symbol>
			<symbol
				id="i-thumbsDown"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M11.5 2.5v7L8.5 14.8a1.6 1.6 0 0 1-2.1-2.3l.8-1.5H4.1a1.6 1.6 0 0 1-1.55-2l1.1-4.4a1.6 1.6 0 0 1 1.55-1.1z" />
				<path d="M11.5 9.5h3.1v-7h-3.1" />
			</symbol>
			<symbol
				id="i-fork"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<circle cx="4.5" cy="3.75" r="1.75" />
				<circle cx="13.5" cy="3.75" r="1.75" />
				<circle cx="9" cy="14.25" r="1.75" />
				<path d="M4.5 5.5v1.75a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V5.5M9 9.25v3.25" />
			</symbol>
			<symbol
				id="i-gauge"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M2.75 12.5a6.25 6.25 0 1 1 12.5 0" />
				<path d="M9 12.5V7.25M6.4 9.6 9 7.25l2.6 2.35" />
			</symbol>
			<symbol id="i-chevronLeft" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M6 1.5 2 6l4 4.5" />
			</symbol>
			<symbol id="i-chevronRight" viewBox="0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="m2 1.5 4 4.5-4 4.5" />
			</symbol>
			<symbol id="i-language" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
				<path d="M3 3.25h7M6.5 2v1.25M4 6.25c1.2 2.1 3 3.65 5.5 4.75M9 6.25C8 8.7 6 10.75 3 12" />
				<path d="m10 15 2.5-6 2.5 6M11 12.75h3" />
			</symbol>
			<symbol id="i-settings" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<circle cx="9" cy="9" r="2.5" />
				<path d="M9 2.25v2M9 13.75v2M2.25 9h2M13.75 9h2M4.2 4.2l1.4 1.4M12.4 12.4l1.4 1.4M13.8 4.2l-1.4 1.4M5.6 12.4l-1.4 1.4" />
			</symbol>
			<symbol id="i-logout" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M8 3H3v12h5M11.5 5.5 15 9l-3.5 3.5M6.5 9H15" />
			</symbol>
			<symbol id="i-chevronDown" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="m4 6 4 4 4-4" />
			</symbol>
			<symbol id="i-shield" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M9 2.25 15 4.5v3.9c0 3.35-2.3 6.15-6 7.95-3.7-1.8-6-4.6-6-7.95V4.5z" />
			</symbol>
			<symbol id="i-chevron" viewBox="0 0 10 10" fill="currentColor">
				<path d="M1 3l4 4 4-4z" />
			</symbol>
			<symbol id="i-send" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
				<path d="M9 15V3.75M4.5 8.25 9 3.5l4.5 4.75" />
			</symbol>
			<symbol id="i-folder" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M2 5.25h5.25l1.5 2H16v7.25H2z" />
			</symbol>
			<symbol id="i-folderPlus" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M2 5.25h5.25l1.5 2H16v7.25H2z" />
				<path d="M12.5 2.75v5M10 5.25h5" />
			</symbol>
			<symbol id="i-closeSm" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
				<path d="m4 4 10 10M14 4 4 14" />
			</symbol>
			<symbol id="i-close" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
				<path d="m4 4 12 12M16 4 4 16" />
			</symbol>
			<symbol id="i-searchLg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
				<circle cx="8.5" cy="8.5" r="5.5" />
				<path d="m12.5 12.5 4 4" />
			</symbol>
			<symbol id="i-up" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7">
				<path d="m5 8 4-4 4 4M9 4v10" />
			</symbol>
			<symbol id="i-file" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
				<path d="M4 2.25h6.75L14 5.5v10.25H4z" />
				<path d="M10.5 2.5v3.25h3.25" />
			</symbol>
			<symbol id="i-tree" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45">
				<path d="M3 2.5v13" />
				<path d="M3 6h4M3 12h4" />
				<rect x="7" y="4" width="8" height="4" rx="1" />
				<rect x="7" y="10" width="8" height="4" rx="1" />
			</symbol>
			<symbol id="i-open" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M2 5.25h5.25l1.5 2H16v7.25H2z" />
				<path d="M10 4h5v5M15 4l-5.5 5.5" />
			</symbol>
			<symbol
				id="i-plus"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
			>
				<path d="M9 3.5v11M3.5 9h11" />
			</symbol>
			{/* Turn change card and the changes panel. */}
			<symbol
				id="i-fileDiff"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
			>
				<rect x="3" y="2.75" width="12" height="12.5" rx="2.5" />
				<path d="M9 5.5v4M7 7.5h4M7 12h4" />
			</symbol>
			<symbol
				id="i-undo"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M6.5 3.75 3.75 6.5 6.5 9.25" />
				<path d="M3.75 6.5h6.5a4 4 0 0 1 0 8H8" />
			</symbol>
			<symbol
				id="i-openExternal"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M8 3.25H5A1.75 1.75 0 0 0 3.25 5v8A1.75 1.75 0 0 0 5 14.75h8A1.75 1.75 0 0 0 14.75 13v-3" />
				<path d="M10.5 3.25h4.25V7.5M14.5 3.5 9 9" />
			</symbol>
			<symbol
				id="i-fileSearch"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M8 15.25H5A1.75 1.75 0 0 1 3.25 13.5v-9A1.75 1.75 0 0 1 5 2.75h4.5l4 4v1.5" />
				<path d="M9.5 2.75v4h4" />
				<circle cx="11.75" cy="12" r="2.25" />
				<path d="m13.4 13.65 1.6 1.6" />
			</symbol>
			{/* Model Context Protocol mark (simple-icons, CC0). */}
			<symbol id="i-mcp" viewBox="0 0 24 24" fill="currentColor">
				<path d="M15.688 2.343a2.588 2.588 0 0 0-3.61 0l-9.626 9.44a.863.863 0 0 1-1.203 0 .823.823 0 0 1 0-1.18l9.626-9.44a4.313 4.313 0 0 1 6.016 0 4.116 4.116 0 0 1 1.204 3.54 4.3 4.3 0 0 1 3.609 1.18l.05.05a4.115 4.115 0 0 1 0 5.9l-8.706 8.537a.274.274 0 0 0 0 .393l1.788 1.754a.823.823 0 0 1 0 1.18.863.863 0 0 1-1.203 0l-1.788-1.753a1.92 1.92 0 0 1 0-2.754l8.706-8.538a2.47 2.47 0 0 0 0-3.54l-.05-.049a2.588 2.588 0 0 0-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 0 1-1.204 0 .823.823 0 0 1 0-1.18l7.273-7.133a2.47 2.47 0 0 0-.003-3.537z" />
				<path d="M14.485 4.703a.823.823 0 0 0 0-1.18.863.863 0 0 0-1.204 0l-7.119 6.982a4.115 4.115 0 0 0 0 5.9 4.314 4.314 0 0 0 6.016 0l7.12-6.982a.823.823 0 0 0 0-1.18.863.863 0 0 0-1.204 0l-7.119 6.982a2.588 2.588 0 0 1-3.61 0 2.47 2.47 0 0 1 0-3.54l7.12-6.982z" />
			</symbol>
			<symbol id="i-more" viewBox="0 0 18 18" fill="currentColor">
				<circle cx="4" cy="9" r="1.2" />
				<circle cx="9" cy="9" r="1.2" />
				<circle cx="14" cy="9" r="1.2" />
			</symbol>
			<symbol id="i-tool" viewBox="0 0 10 10" fill="currentColor">
				<path d="M3 1l4 4-4 4z" />
			</symbol>
			<symbol id="i-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
				<rect x="5" y="5" width="8" height="8" rx="1.5" />
				<path d="M3.5 10.5h-1A1.5 1.5 0 0 1 1 9V2.5A1.5 1.5 0 0 1 2.5 1H9A1.5 1.5 0 0 1 10.5 2.5v1" />
			</symbol>
			<symbol id="i-target" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
				<circle cx="9" cy="9" r="6.25" />
				<circle cx="9" cy="9" r="3" />
				<circle cx="9" cy="9" r=".75" fill="currentColor" stroke="none" />
			</symbol>
			<symbol
				id="i-listCheck"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M6.5 4.5h9M6.5 9h9M6.5 13.5h9" />
				<path d="m2 4.5 1 1 1.75-2M2 9l1 1 1.75-2M2 13.5l1 1 1.75-2" />
			</symbol>
			<symbol
				id="i-layers"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			>
				<path d="M9 2.25 15.5 5.5 9 8.75 2.5 5.5z" />
				<path d="M2.5 9.25 9 12.5l6.5-3.25M2.5 12.75 9 16l6.5-3.25" />
			</symbol>
			<symbol id="i-orbit" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
				<circle cx="9" cy="9" r="2.25" />
				<ellipse cx="9" cy="9" rx="6.75" ry="3.25" transform="rotate(-25 9 9)" />
				<circle cx="14.4" cy="6.1" r="1.1" fill="currentColor" stroke="none" />
			</symbol>
			<symbol
				id="i-paperclip"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12.75 7.5 7.9 12.35a2.5 2.5 0 0 1-3.54-3.54l5.3-5.3a1.75 1.75 0 0 1 2.48 2.48l-5.3 5.3a1 1 0 0 1-1.42-1.42l4.6-4.6" />
			</symbol>
			<symbol
				id="i-close-sm"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
			>
				<path d="m5 5 8 8M13 5l-8 8" />
			</symbol>
			<symbol
				id="i-brain"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M7 4.25a2.25 2.25 0 0 0-4.5 1A2.25 2.25 0 0 0 3 9.5a2.25 2.25 0 0 0 4 1.75z" />
				<path d="M11 4.25a2.25 2.25 0 0 1 4.5 1A2.25 2.25 0 0 1 15 9.5a2.25 2.25 0 0 1-4 1.75z" />
				<path d="M9 3.5v11" />
			</symbol>
			<symbol
				id="i-cube"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			>
				<path d="M9 2.25 15.25 5.5v7L9 15.75 2.75 12.5v-7z" />
				<path d="M2.75 5.5 9 8.75l6.25-3.25M9 8.75v7" />
			</symbol>
			<symbol
				id="i-check"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="m3.5 9.5 3.5 3.5 7.5-8" />
			</symbol>
			<symbol id="i-star" viewBox="0 0 18 18" fill="currentColor">
				<path d="M9 1.75l2.2 4.5 4.95.72-3.58 3.5.85 4.93L9 13.3l-4.42 2.35.85-4.93-3.58-3.5 4.95-.72z" />
			</symbol>
			<symbol id="i-eye" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<path d="M1.5 9S4.5 4.75 9 4.75 16.5 9 16.5 9 13.5 13.25 9 13.25 1.5 9 1.5 5.75z" />
				<circle cx="9" cy="9" r="2.25" />
			</symbol>
			<symbol
				id="i-zap"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinejoin="round"
			>
				<path d="M10.25 2 4.5 9.75h3.75l-.5 5.75L13.5 8.25H9.75z" />
			</symbol>
			<symbol
				id="i-loop"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M14.75 9a5.75 5.75 0 1 1-1.7-4.07" />
				<path d="M14.9 2.6v3.1h-3.1" />
			</symbol>
			<symbol
				id="i-wrap"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M3 4.5h12M3 9h9.75a2.25 2.25 0 0 1 0 4.5H9.5M3 13.5h3.5" />
				<path d="m11 11.75-1.75 1.75L11 15.25" />
			</symbol>
			<symbol id="i-panelRight" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
				<rect x="1.75" y="2.75" width="14.5" height="12.5" rx="2" />
				<path d="M11.5 2.75v12.5" />
			</symbol>
			<symbol id="i-tag" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.45">
				<path d="M2.75 3h6l6.5 6.5-5.75 5.75L3 8.75z" />
				<circle cx="6" cy="6.25" r="1" fill="currentColor" stroke="none" />
			</symbol>
			<symbol
				id="i-clock"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			>
				<circle cx="9" cy="9" r="6.5" />
				<path d="M9 5.5V9l2.5 1.5" />
			</symbol>
			<symbol
				id="i-puzzle"
				viewBox="0 0 18 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			>
				<path d="M6.5 2.5a1.5 1.5 0 0 1 3 0c0 .6-.4.9-.4 1.5h2.4a1 1 0 0 1 1 1v2.4c.6 0 .9-.4 1.5-.4a1.5 1.5 0 0 1 0 3c-.6 0-.9-.4-1.5-.4v2.4a1 1 0 0 1-1 1H9.1c0 .6.4.9.4 1.5a1.5 1.5 0 0 1-3 0c0-.6.4-.9.4-1.5H4.5a1 1 0 0 1-1-1V8.9c-.6 0-.9.4-1.5.4a1.5 1.5 0 0 1 0-3c.6 0 .9.4 1.5.4V5a1 1 0 0 1 1-1h2.4c0-.6-.4-.9-.4-1.5z" />
			</symbol>
		</svg>
	);
}
