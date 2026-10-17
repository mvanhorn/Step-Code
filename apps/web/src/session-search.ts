import {
	createSessionSearchService,
	defaultSessionIndexRoots,
	openSessionIndex,
	type SessionFilePersistedEvent,
	type SessionIndex,
	type SessionIndexCoverage,
	type SessionIndexHit,
	type SessionIndexStatus,
	type SessionSearchService,
} from "@step-harness/coding-agent";

/** One hit of `GET /api/v1/search`. The snippet marks matches with U+0002 / U+0003. */
export type WebSearchHit = Pick<
	SessionIndexHit,
	"sessionId" | "cwd" | "entryId" | "entryType" | "role" | "ts" | "snippet"
>;

/** `GET /api/v1/search`: hits in rank order, plus how much of the history the index covered. */
export interface WebSearchResult {
	hits: WebSearchHit[];
	coverage: SessionIndexCoverage;
	state: SessionIndexStatus["state"];
}

export type OpenIndex = (agentDir: string) => Promise<SessionIndex>;

const openDefaultIndex: OpenIndex = (agentDir) =>
	openSessionIndex({ agentDir, roots: defaultSessionIndexRoots(agentDir) });

/**
 * The host's session index: opened once at startup and shared by every
 * request. The index never rejects on open (it degrades to a JSONL scan), so
 * search keeps working without SQLite, only slower and with session-level hits.
 *
 * `notifyPersisted` is synchronous so session managers can report writes
 * before the index finished opening; those writes are forwarded once it has.
 */
export class WebSessionSearch {
	private readonly opening: Promise<SessionIndex>;
	private index: SessionIndex | undefined;
	private service: SessionSearchService | undefined;
	private closed = false;

	constructor(agentDir: string, open: OpenIndex = openDefaultIndex) {
		this.opening = open(agentDir).then((index) => {
			this.index = index;
			return index;
		});
	}

	notifyPersisted(event: SessionFilePersistedEvent): void {
		if (this.closed) return;
		if (this.index) this.index.notifyPersisted(event);
		else void this.opening.then((index) => index.notifyPersisted(event));
	}

	/**
	 * Run one query. `params` is the untrusted request input; invalid values
	 * throw `SessionSearchRequestError` with code `invalid_params`.
	 */
	async search(params: Record<string, unknown>, signal?: AbortSignal): Promise<WebSearchResult> {
		const index = await this.opening;
		this.service ??= createSessionSearchService(index);
		const hits: WebSearchHit[] = [];
		let coverage: SessionIndexCoverage = { indexed: 0, total: 0 };
		for await (const batch of this.service.searchQuery(params, signal)) {
			for (const hit of batch.hits) {
				hits.push({
					sessionId: hit.sessionId,
					cwd: hit.cwd,
					entryId: hit.entryId,
					...(hit.entryType ? { entryType: hit.entryType } : {}),
					...(hit.role ? { role: hit.role } : {}),
					ts: hit.ts,
					snippet: hit.snippet,
				});
			}
			coverage = batch.coverage;
		}
		const { state } = await index.status();
		return { hits, coverage, state };
	}

	async status(): Promise<SessionIndexStatus> {
		const status = await (await this.opening).status();
		// The database path is a host detail the page has no use for.
		const { dbPath: _dbPath, ...rest } = status;
		return rest;
	}

	/** Flush pending writes and stop the index worker. */
	async close(): Promise<void> {
		this.closed = true;
		await (await this.opening).close();
	}
}

/** Read `GET /api/v1/search` query parameters into the shape the index service validates. */
export function searchParamsFromUrl(url: URL): Record<string, unknown> {
	const params: Record<string, unknown> = { q: url.searchParams.get("q") ?? "" };
	const cwd = url.searchParams.get("cwd");
	if (cwd) params.cwd = cwd;
	const limit = url.searchParams.get("limit");
	// Non-numeric text becomes NaN, which the service rejects as an invalid limit.
	if (limit !== null) params.limit = Number(limit);
	return params;
}
