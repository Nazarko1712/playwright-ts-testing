# playwright-ts-testing

Playwright + TypeScript suite covering four layers in one project: **UI**,
**REST**, **GraphQL** and **Pub/Sub** (MQTT, WebSocket, SSE).

**38 tests, 6 spec files.** Each layer runs as its own Playwright project, so
the API suites launch no browser at all.

## Prerequisites

| Requirement        | Notes                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Node.js 20+**    | check with `node -v`                                               |
| **Chromium**       | downloaded by the setup step below (~95 MB), not a system browser  |
| **Network access** | `demo.playwright.dev` (UI), `rickandmortyapi.com` (REST + GraphQL) |
| **Port 8137 free** | the messaging specs start a local SSE/WebSocket server there       |
| **Ports 18833+**   | one in-process MQTT broker per worker, `18833 + workerIndex`       |

No Docker, no database, no seed step.

If port 8137 is already in use, the config's `webServer` readiness check never
passes and every messaging test times out without explaining why.

## Setup

```bash
npm ci                           # exact lockfile install
npx playwright install chromium  # browser binary
```

## Running

**Headless** — the default, and what CI runs:

```bash
npm test                # all four layers
npm run test:ui         # UI only
npm run test:api        # REST, no browser launched
npm run test:graphql    # GraphQL
npm run test:messaging  # MQTT + WebSocket + SSE
```

**Headed** — watch the browser:

```bash
npm run test:headed     # UI suite, visible browser, one worker
npm run test:slow       # the same with a 500 ms delay between actions
SLOWMO=1500 npm run test:headed
```

`--workers=1` matters in headed mode: without it `fullyParallel` opens four
windows at once and nothing is watchable.

**Debugging:**

```bash
npm run test:uimode     # UI mode — watch mode, timeline, DOM snapshot per
                        # action, network, console, pick locator
npm run test:debug      # Playwright Inspector, step through command by command
npm run report          # open the HTML report
npx playwright show-trace test-results/<...>/trace.zip
```

UI mode is the one to reach for first. `trace: 'on-first-retry'` records a full
DOM, network and console timeline for a failing attempt, which is how a flake
that only reproduces in CI gets diagnosed.

```bash
npm run typecheck       # tsc --noEmit, strict
```

`slowMo` is a browser **launch option**, not a CLI flag — there is no
`--slowmo`. It is wired to the `SLOWMO` environment variable instead, so
`SLOWMO=1500 npm run test:headed` also works.

`.npmrc` pins the public npm registry so the project does not resolve through a
corporate CodeArtifact proxy — a common cause of `npm ci` hanging on a work
machine.

## Layout

```
playwright.config.ts   projects per layer, webServer, trace/retry policy
src/
  pages/TodoPage.ts    page object (lazy locators)
  realtime-server.ts   local SSE + WebSocket fixture server
  sse-client.ts        raw SSE parser (APIRequestContext buffers streams)
  mqtt-broker.ts       in-process aedes broker, port per worker
tests/ui | api | graphql | messaging
```

---

## Interview notes

### Playwright vs WebdriverIO

|                    | WebdriverIO / Selenium                  | Playwright                                                          |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------- |
| Element handle     | resolved immediately, can go stale      | `Locator` is **lazy**, re-queried per action                        |
| Waiting            | `waitForDisplayed` / `waitForClickable` | auto-waits for attached + visible + stable + enabled + unobstructed |
| Ambiguous selector | acts on the first match                 | **strict mode** throws                                              |
| Isolation          | one session per browser                 | `BrowserContext` per test, cheap                                    |
| Protocol           | WebDriver HTTP (per-command round trip) | CDP, single bidirectional connection                                |

No `StaleElementReferenceException` exists in Playwright, because a locator
holds a _strategy_, not a node.

### Trace viewer

`trace: 'on-first-retry'` captures a DOM snapshot per action, network, console
and sources. `npx playwright show-trace trace.zip` — this is the answer to
"how do you debug a flake that only happens in CI".

### Pub/Sub testing — the one rule

**Subscribe first, then trigger, then await with a timeout.** Trigger-first and
the message can arrive before the listener exists; the test hangs and looks flaky.

Two bugs this suite actually hit on the first run, both worth telling:

1. **Cross-test message bleed.** The server broadcasts to every socket, so
   `once('message')` picked up a frame produced by a different parallel test.
   Fix: filter by topic _and_ give each test a unique topic.
2. **`beforeAll` runs per worker.** With `fullyParallel`, a hard-coded broker
   port means every worker but the first dies with `EADDRINUSE`. Fix: derive
   the port from `workerIndex` — keeps parallelism instead of serialising.

### SSE vs WebSocket vs MQTT

- **SSE** — server→client only, plain HTTP, auto-reconnect + `Last-Event-ID`
  replay built in, text only. Wire format: `id:` / `event:` / `data:` then a
  blank line. Needs `Cache-Control: no-cache` or a proxy buffers the stream.
- **WebSocket** — bidirectional, starts as an HTTP `Upgrade` answered with
  **101**, binary capable, you implement reconnection. Close code `1000` normal,
  `1006` abnormal drop.
- **MQTT** — broker-mediated pub/sub. Topics `store/+/orders/ready` (`+` one
  level, `#` rest, must be last). QoS 0 at-most-once, 1 at-least-once
  (**duplicates possible → consumers must be idempotent**), 2 exactly-once.
  Retained messages give a booting client current state. Last Will detects dead
  devices.

Delivery guarantees differ, and the tests assert the difference: a reconnecting
WebSocket client **loses** messages sent while away; an MQTT persistent session
**replays** them.

MQTT 3.1.1 vs 5.0 trap: `clean: false` alone keeps a session in 3.1.1. In MQTT
5.0 you also need `sessionExpiryInterval`, which defaults to 0. `mqtt.js` v5
defaults to protocol 5, so the 3.1.1-style test silently receives nothing.

### GraphQL

- One endpoint, POST. No per-resource URLs.
- **The status code proves nothing.** A validation error may return 200 with an
  `errors` array (legacy `application/json`) or 4xx (per GraphQL-over-HTTP with
  `application/graphql-response+json`). This suite's API returns **400**.
  Always assert on `errors`; never on status alone.
- `data` and `errors` can both be present — partial success is by design.
- Only requested fields come back; an unrequested field is absent, not null.
- Introspection makes the schema a machine-readable contract — used here as a
  breaking-change test.
- N+1 is the classic performance trap; DataLoader batches resolvers.

### Two real defects these tests found

- `GET /api/character/not-a-number` → **500**, should be 4xx. Kept in the suite
  via `test.fail()`: the run stays green while the bug exists, and Playwright
  reports "expected to fail but passed" the moment it is fixed. Better than
  deleting the test or weakening the assertion.
- `?species=human` also returns `Humanoid` — the filter is a case-insensitive
  **substring** match, not exact. Establish filter semantics before asserting.

### CI

`.github/workflows/tests.yml` shards across 2 runners with `--reporter=blob`,
then `playwright merge-reports` combines them into one HTML report. Retries only
when `CI` is set — locally a flake should be seen, not hidden. `forbidOnly`
stops a stray `test.only` from shrinking the run.

`Dockerfile` uses `mcr.microsoft.com/playwright:v1.63.0-jammy`; the tag must
match the client version or browsers and library disagree. `npm ci`, not
`npm install`, for a lockfile-exact reproducible install.

## Linting and reports

```bash
npm run lint          # ESLint 9, flat config
npm run lint:fix      # auto-fixable rules only
npm run format        # Prettier, writes
npm run format:check  # Prettier, reports (this is what CI runs)
npm run typecheck     # tsc --noEmit
npm run report        # open the HTML report of the last run
```

The rules that matter in a test suite are not the style ones — Prettier owns
those. These are the ones that catch **a test which cannot fail**:

| Rule                                      | What it catches                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@typescript-eslint/no-floating-promises` | an un-awaited assertion resolves to a truthy Promise, so the test passes having checked nothing |
| `playwright/expect-expect`                | a test body with no assertion at all                                                            |
| `playwright/no-conditional-in-test`       | a branch that can skip every assertion                                                          |
| `playwright/no-wait-for-timeout`          | a fixed sleep standing in for the real condition                                                |
| `playwright/no-skipped-test`              | coverage that silently disappeared                                                              |

Two of the fifteen violations found when this was first wired up were real
defects rather than style:

- `sse.spec.ts` guarded its header assertions behind `if (!response) return`, so
  the test passed having asserted **nothing** whenever the streaming request
  failed to settle — which was always, because `APIRequestContext` buffers the
  whole response and `/events` never closes. It now reads the headers through a
  raw request and the assertions are unconditional.
- `TodoPage.ts` carried an `expectTitles()` assertion, contradicting this repo's
  own stated convention that a page object exposes state and never asserts on it.

Reporting is Playwright's own: `list` locally, `blob` per CI shard, merged into
one HTML report by the `merge-reports` job and uploaded as an artifact. On a
failure the report carries the trace, so a red CI run is debuggable without
reproducing it locally.

### Pre-push hook

```bash
npm install    # wires the hook up via npm's `prepare` lifecycle script
```

`.husky/pre-push` runs the same checks CI runs, before the push leaves the
machine. If any of them exits non-zero, **the push is aborted and nothing
reaches the remote**:

```
  push blocked — ESLint found problems
  fix:     npm run lint:fix
  bypass:  git push --no-verify
```

Three deliberate choices in it:

**It does not run the suite.** Lint, formatting and types are fast, offline and
deterministic — the whole hook finishes in about four seconds. The tests need a
browser and/or somebody else's demo API, so a hook that ran them would add a
minute to every push and would block whenever that server is asleep. Those
belong in CI, where a retry is free.

**It never fixes anything.** The hook calls the reporting variants, never
`--fix` or `--write`. A hook that rewrites files during `git push` pushes a
version you never reviewed and leaves the corrected files uncommitted in your
working tree. Being told what to run is better than being silently corrected.

**It is a pre-push hook, not pre-commit.** Commits are cheap and often
intermediate; blocking each one trains you to reach for `--no-verify` until the
hook is decoration. One check before the branch leaves the machine catches
exactly what CI would catch, without getting in the way of committing
work-in-progress.

`git push --no-verify` skips it entirely and lets CI be the judge — a legitimate
choice for a branch that is not finished.

### Where this runs in CI

Linting and formatting are their **own job**, not steps inside the test job.
They need no browser, no network and no secrets, and they finish in seconds, so
as a separate job they run concurrently with the suite: a formatting failure
does not wait behind a long test run, and a real test failure is not hidden
behind a formatting failure. Both verdicts arrive on their own.

CI runs the `--check` variants, never the formatter itself. A pipeline reports
on the branch it was asked to verify; it does not rewrite it.
