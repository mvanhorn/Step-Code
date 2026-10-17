/** Model picker helpers (legacy app.js 2480-2488, 2558-2584, 2614-2616, 2809-2818). */

import type { TranslateFn } from "../../i18n";
import { readStorage, STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { modelKey } from "../../state/session";
import type { DraftModels, ModelInfo, SessionSnapshot } from "../../state/types";

/** How many models the compact view shows before deferring to "more models". */
export const COMPACT_MODEL_COUNT = 4;

/** What the model panel is painted from: the open session, or a draft's prediction (`draftModelSource`). */
export type ModelSource = Pick<SessionSnapshot, "models" | "model" | "thinkingLevel" | "availableThinkingLevels">;

export const EMPTY_MODEL_SOURCE: ModelSource = { models: [] };

/** Kernel thinking levels, lowest first (the order of `EFFORT_LABELS`). */
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The level a session on a model with `levels` would actually run at for
 * `level`. Mirrors the kernel's `clampThinkingLevel`: `level` itself, else the
 * nearest supported level above it, else the nearest below, else the lowest
 * supported one. A draft that rounded differently would show one effort and
 * start its session on another.
 */
export function clampEffort(level: string, levels: readonly string[]): string | undefined {
	if (levels.includes(level)) return level;
	const rank = EFFORT_ORDER.indexOf(level);
	if (rank === -1) return levels[0];
	const above = EFFORT_ORDER.slice(rank + 1).find((candidate) => levels.includes(candidate));
	const below = EFFORT_ORDER.slice(0, rank)
		.reverse()
		.find((candidate) => levels.includes(candidate));
	return above ?? below ?? levels[0];
}

/**
 * What a draft's model panel shows: the host's prediction for a new session
 * (`GET /api/v1/models`), with the model and effort picked in this draft laid
 * over it. A picked model brings its own supported levels.
 */
export function draftModelSource(draft: DraftModels | null, pickedModel: string, pickedEffort: string): ModelSource {
	if (!draft) return EMPTY_MODEL_SOURCE;
	const picked = pickedModel ? draft.models.find((model) => modelKey(model) === pickedModel) : undefined;
	if (!picked) {
		const thinkingLevel = pickedEffort
			? clampEffort(pickedEffort, draft.availableThinkingLevels)
			: draft.thinkingLevel;
		return { ...draft, thinkingLevel };
	}
	const levels = picked.thinkingLevels ?? [];
	const wanted = pickedEffort || draft.thinkingLevel;
	return {
		models: draft.models,
		model: { provider: picked.provider, id: picked.id },
		availableThinkingLevels: levels,
		thinkingLevel: wanted ? clampEffort(wanted, levels) : undefined,
	};
}

/** Effort labels, keyed by the kernel's thinking level ids. */
export const EFFORT_LABELS: Readonly<Record<string, string>> = {
	off: "effortOff",
	minimal: "effortMinimal",
	low: "effortLow",
	medium: "effortMedium",
	high: "effortHigh",
	xhigh: "effortXhigh",
	max: "effortMax",
};

export function effortLabel(t: TranslateFn, level: string): string {
	return t(EFFORT_LABELS[level] ?? level);
}

/** Model ids the user pinned, kept locally so they survive a session change. */
export function readPinnedModels(): string[] {
	try {
		const parsed: unknown = JSON.parse(readStorage(STORAGE_KEYS.pinnedModels) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

export function togglePinnedModel(key: string): string[] {
	const current = readPinnedModels();
	const next = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
	writeStorage(STORAGE_KEYS.pinnedModels, JSON.stringify(next));
	return next;
}

/** Human-readable model metadata for the picker rows (strings hard-coded in Chinese, as legacy). */
export function modelMeta(model: ModelInfo): string[] {
	const meta: string[] = [];
	if (model.contextWindow) meta.push(`${Math.round(model.contextWindow / 1000)}K 上下文`);
	if (model.maxTokens) meta.push(`${Math.round(model.maxTokens / 1000)}K 输出`);
	if (model.input?.includes("image")) meta.push("支持图片");
	return meta;
}

/** `#modelLabel`: model name (or id), then ` · <effort>` when a level is set. */
/**
 * The trigger label in its two parts: the model name, which may be long and is
 * the part the trigger shortens, and the effort suffix (` · 高`), which stays
 * whole so the chosen effort is always readable.
 */
export function modelLabelParts(
	t: TranslateFn,
	source: ModelSource,
): { readonly name: string; readonly effort: string } {
	const currentKey = source.model ? modelKey(source.model) : "";
	const active = (source.models ?? []).find((model) => modelKey(model) === currentKey);
	const effort = source.thinkingLevel;
	return {
		// `defaultModel` has no translation: legacy showed the key itself here.
		name: active?.name ?? (currentKey && source.model ? source.model.id : t("defaultModel")),
		effort: effort ? ` · ${effortLabel(t, effort)}` : "",
	};
}

/**
 * The short list: whatever is pinned, then the active model, then enough of
 * the rest to fill the panel. Capped so a large catalog does not turn the
 * default view into a scroll.
 */
export function compactCandidates(
	models: readonly ModelInfo[],
	pinned: readonly string[],
	active: ModelInfo | undefined,
): ModelInfo[] {
	const chosen = models.filter((model) => pinned.includes(modelKey(model)));
	if (active && !chosen.includes(active)) chosen.push(active);
	for (const model of models) {
		if (chosen.length >= COMPACT_MODEL_COUNT) break;
		if (!chosen.includes(model)) chosen.push(model);
	}
	return chosen;
}

/** Catalog filter of the "all models" view: id, name or provider contains the query. */
export function filterModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
	const needle = query.trim().toLowerCase();
	return models.filter(
		(model) =>
			!needle ||
			model.id.toLowerCase().includes(needle) ||
			(model.name ?? "").toLowerCase().includes(needle) ||
			model.provider.toLowerCase().includes(needle),
	);
}
