# Discordex architecture

[← Back to the README](../README.md) · [Configuration and hosting](configuration.md)

Discordex is a self-hosted Discord client for the shared local Codex app-server daemon. It runs alongside the local Codex client and consumes structured protocol events. Exporting a response does not depend on the model choosing to invoke a tool.

## Tech stack

| Layer | Implementation |
| --- | --- |
| Runtime | Bun; developed and tested with 1.4.4, package minimum 1.3 |
| Language | TypeScript with strict type checking |
| Discord | `discord.js` 14, Gateway events, REST delivery, and Components V2 cards |
| Codex transport | `ws` over the local Unix WebSocket socket; app-server requests and notifications |
| Persistence | `bun:sqlite` with WAL mode |
| Deployment | Host process with an optional systemd user service |
| Validation | Bun tests, TypeScript checks, and Bun build in GitHub Actions |

Standard `node:` compatibility modules and `ws` are used where needed by the transports. Node.js is not a runtime dependency. Discordex opens an outbound Discord Gateway connection and does not require a public HTTP listener.

## Session discovery

Discordex connects to the configured daemon socket and lists loaded Codex sessions. Automatic discovery periodically checks for eligible sessions within `projectRoots`; an empty list permits all projects. `/codex sessions` lists eligible sessions, and `/codex attach` links one explicitly.

Each top-level Codex conversation maps to one Discord thread under the configured text channel. Subagents join the parent's thread and retain their own labels. The mapping is stored in SQLite so reconnects can reuse the same Discord thread.

The first attachment includes a currently active turn and future activity, without copying the whole old conversation. Tracked sessions are reattached on reconnect and their history is read from the last processed turn. This can keep those conversations loaded in the shared daemon while Discordex is running.

The connection sees only its shared daemon. Sessions running with `--no-daemon` or on another daemon are not discovered.

## Messages and turns

An allowed user's message in a linked thread is persisted in the inbox and submitted with the sender's identity. The Discord message ID becomes Codex's `clientUserMessageId`, which helps reconcile a submission if the connection fails around acceptance.

Normal messages queue work. `/codex steer` adds instructions to the active turn, and `/codex stop` interrupts it. The index channel is not forwarded; bots and webhooks are ignored.

Codex notifications update durable turn state. The outbox delivers changes through the Discord adapter. A serial work queue coordinates bridge operations, while persisted state lets recovery rebuild deliveries from daemon history.

## Turn cards and model labels

Each agent turn gets one editable Components V2 message. Progress includes activity such as running a command, editing files, and completed assistant commentary. The same card becomes the final response, including a file with the full text if it is too long for the card.

Updates are coalesced with at least one second between successful edits to a turn card. Retries preserve backoff. Completed assistant text is authoritative; partial token streams and reasoning text are not exported. Interruptions and failures remain visible in the status.

Every agent has its own card, even when subagents share a Discord thread. Approval and input requests use separate cards so progress edits cannot erase a pending decision. Reconnects recover turn state and edit the original message.

Footers show model and reasoning effort when available. The initial values are captured session settings, not per-turn execution telemetry. The source is tracked internally, and a daemon-reported model reroute updates that turn's model label. Later settings changes do not rewrite older cards. Recovered historical turns without a captured model are left unlabeled.

## Usage cards

`/codex usage` reads `account/rateLimits/read` on demand and renders an ephemeral Components V2 card. Ten-segment emoji bars visualize the remaining allowance alongside its percentage: blue normally, yellow at 20% or below, and red at 10% or below, with dark empty segments. Window labels come from the reported duration. Multiple quota buckets are supported, with up to four groups shown to keep the card compact. Discord timestamps display reset times relative to the reader. Explicit backend blocking takes precedence over apparently available percentages, and elapsed reset times never imply a refilled allowance.

This read runs outside the bridge's serial work queue so a slow account service cannot delay approvals or turns. Account limits are fetched afresh and are not persisted. Unavailable limits, unsupported methods, and daemon disconnects produce a readable status rather than a guessed allowance.

For eligible linked sessions, `thread/tokenUsage/updated` notifications persist the latest total, input, and output counters with a receipt timestamp in SQLite. A thread's usage card displays its top-level agent's latest snapshot, separately from account allowance; it does not sum subagents. Before the first notification, the card says it is waiting for usage data. Saved counters survive restarts and retain their last-reported timestamp, since the daemon may not replay token usage during reconnection.

## Recovery and delivery guarantees

Codex is authoritative for conversation history and pending requests. Discordex stores event-derived deliveries before sending them and uses stable keys to ignore repeated events. It uses Discord nonces to reduce duplicate sends around network failures.

Discord's nonce deduplication window is finite. A crash after Discord accepted a message but before its ID was saved can still cause a duplicate after a sufficiently long outage. There is no exactly-once guarantee across the two services.

Uncertain incoming submissions are reconciled against the daemon queue and history; they are not blindly replayed. Ordinary messages received while disconnected stay in the local inbox. The adapter recovers available missed Discord messages, but deleted or unavailable messages cannot be recovered.

Reconnects invalidate old approval controls. Only requests replayed by Codex receive fresh controls; resolution in the local client also removes Discord controls. See [approval behavior](configuration.md#approval-behavior) for supported decisions and local-only cases.

State and transcripts remain on disk. Automatic pruning is not implemented, and deleting the state directory resets mappings and delivery history.

## State and lifecycle invariants

The bridge has several separate state machines. Their transitions use daemon evidence and persisted delivery records; they do not share a single global status.

| State owner | States and invariants |
| --- | --- |
| Incoming messages | `new` → `submitting` → `queued` or `unknown`; matching queue entries recover uncertain acceptance, and matching history marks an input `delivered`. An accepted input disappearing from the queue is not evidence that it failed: another client may have consumed it. |
| Approval prompts | `pending` → `submitted` → `resolved`, with `expired` when the connection changes or submission becomes uncertain. Only a pending prompt in the current connection epoch accepts an offered decision. Rendering and submission use the same approval rules. |
| Turn cards | `inProgress` becomes `completed`, `interrupted`, or `failed`. Late activity cannot reopen a terminal turn; late completed assistant items can still repair its final text. |
| Outbox | A successful send or edit acknowledges only the revision that was sent. Changes made during delivery stay pending, and further progress updates preserve retry backoff. |
| Codex connection | Only the current socket can dispatch events or change connection state. Stop rejects pending requests immediately; callbacks from retired sockets cannot affect a replacement connection. |
| CLI lifecycle | Shutdown prevents startup from continuing after asynchronous preparation or login. It waits for in-flight login before closing Discord, drains accepted work, and attempts every cleanup step even if an earlier step fails. |

Attachment-only warning replies have their own durable receipt markers. Concurrent live/history receipts share one reply; failures remain retryable. Shutdown drains pending warning replies before closing SQLite. Live receipt never advances the history cursor past unseen messages. These markers have the same finite nonce-deduplication and retention limits as other deliveries.

## Shared goal cards

`/codex goal` manages the same persisted top-level session goal as the local Codex `/goal` interface. The bot reads `thread/goal/get`, writes `thread/goal/set`, and removes goals with `thread/goal/clear`. Explicit button and modal actions include `origin: "user"`; observing or rendering goal events never changes goal state.

Existing goals appear during session reconciliation. Empty sessions get a card only when requested. `thread/goal/updated` and `thread/goal/cleared` events trigger an authoritative read, so delayed events cannot restore an old objective or clear a newer goal. The regular 15-second sync also recovers missed updates. Goal snapshots and a stable `goal:<threadId>` outbox key preserve the shared message across restarts. Edits coalesce with the same cooldown and retry behavior as turn cards. Goal budgets and counters are taken from the daemon, independently of account rate limits.

Controls are scoped to the configured contributor, project, Discord thread, connection epoch, and a version of the goal's objective/status/budget. Progress counters can update without invalidating controls; reconnects and goal edits invalidate old buttons and modals. Every mutation rereads the goal before validating its control version. The protocol has no atomic compare-and-set operation, so these checks cannot make simultaneous writes from separate clients atomic.

Budget edits omit the objective and status to preserve usage accounting. Creating or resuming an active goal lets Codex handle continuation directly; the bridge does not inject an extra prompt or start a duplicate turn. Pausing or clearing does not forcibly interrupt an active turn. An uncertain mutation is never retried automatically: controls are temporarily removed until an authoritative read reconciles the result. Unsupported or unavailable goal reads leave a refreshable status instead of usable stale controls.

## Source map

| File | Responsibility |
| --- | --- |
| [`src/cli.ts`](../src/cli.ts) | Startup, shutdown, daemon bootstrap, and the read-only `doctor` command |
| [`src/runner.ts`](../src/runner.ts) | Startup cancellation and ordered cleanup across service resources |
| [`src/config.ts`](../src/config.ts) | Settings, environment defaults, and validation |
| [`src/codex.ts`](../src/codex.ts) | Unix WebSocket transport, requests, notifications, heartbeat, and reconnects |
| [`src/bridge.ts`](../src/bridge.ts) | Discovery, event handling, message routing, approvals, and recovery |
| [`src/discord.ts`](../src/discord.ts) | Discord Gateway/REST, slash commands, buttons, modals, and message catch-up |
| [`src/turns.ts`](../src/turns.ts) | Durable per-agent turn state and model snapshots |
| [`src/render.ts`](../src/render.ts) | Logical output and prompt rendering |
| [`src/approvals.ts`](../src/approvals.ts) | Supported approval actions shared by rendering and decision validation |
| [`src/components.ts`](../src/components.ts) | Compact Components V2 cards, footers, attachments, and controls |
| [`src/usage.ts`](../src/usage.ts) | Remaining-allowance bars, quota windows, and reported session counters |
| [`src/goals.ts`](../src/goals.ts) | Shared goal cards, input validation, control versions, and goal RPCs |
| [`src/store.ts`](../src/store.ts) | SQLite mappings, inbox, outbox, approvals, and turn-card state |
| [`src/types.ts`](../src/types.ts) | The supported subset of the Codex protocol |

## Protocol compatibility and validation

The adapter targets **Codex 0.169.0** and its experimental shared-daemon protocol. Older releases are not assumed compatible. When changing the supported version, generate the protocol definitions in a temporary directory and compare them with `src/types.ts`:

```sh
codex app-server generate-ts --experimental --out <temporary-directory>
```

Live daemon discovery and subscription have been checked locally. Automated tests exercise the protocol over a Unix WebSocket, queue recovery, output recovery, and approvals with simulated peers. A real Discord bot token is required to validate the complete phone → Discord → Codex workflow.

See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Discord Gateway documentation](https://docs.discord.com/developers/events/gateway) for the underlying interfaces.
