# Web session search on the session index

Branch `feat/web-session-search` = `origin/feat/stepcode-web-mvp-gh` + `feat/session-search-index`.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 1. Host owns one index: `apps/web/src/session-search.ts` opens it at startup, forwards session writes, closes on shutdown | edit | Index opens once per host; writes reach it within the debounce | Remove the module and its wiring |
| 2. Wire writes in `runtime.ts` (`attachSessionIndex` on the initial manager, `withSessionIndex` on the factory) | edit | New, opened, forked sessions are indexed | Drop the sink parameter |
| 3. Routes `GET /api/v1/search`, `GET /api/v1/search/status`; drop `allMessagesText` from `GET /api/v1/sessions`; `openapi.yaml` | edit | 200 with hits + coverage + state; 400 on bad params | Revert routes |
| 4. Client `SearchModal`: debounced server search with abort, snippet highlight, coverage hint, jump to the hit entry | edit | Content hits appear; clicking scrolls to the message | Revert client files |
| 5. Tests: host unit test for the search module; typecheck; `pnpm run check`; e2e; manual run in a browser with a scratch agent dir | test | All pass; manual search finds content | n/a |
| 6. Child-agent sessions: `core/child-session.ts` (header `origin` or id prefix); children stamp `origin`/`parentSessionId` in their header; index minor 2 adds `sessions.origin` (prefix backfill) and excludes children from search/list and the degraded scan; Web list and CLI picker use the same rule | edit + tests | Children stay indexed, never returned; real data: 121 indexed, 24 listed, 0 child hits | Revert; the derived index rebuilds |

No side-effecting operations beyond local files. Commit only when asked.
