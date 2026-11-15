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

## Recovery and delivery guarantees

Codex is authoritative for conversation history and pending requests. Discordex stores event-derived deliveries before sending them and uses stable keys to ignore repeated events. It uses Discord nonces to reduce duplicate sends around network failures.

Discord's nonce deduplication window is finite. A crash after Discord accepted a message but before its ID was saved can still cause a duplicate after a sufficiently long outage. There is no exactly-once guarantee across the two services.

Uncertain incoming submissions are reconciled against the daemon queue and history; they are not blindly replayed. Ordinary messages received while disconnected stay in the local inbox. The adapter recovers available missed Discord messages, but deleted or unavailable messages cannot be recovered.

Reconnects invalidate old approval controls. Only requests replayed by Codex receive fresh controls; resolution in the local client also removes Discord controls. See [approval behavior](configuration.md#approval-behavior) for supported decisions and local-only cases.

State and transcripts remain on disk. Automatic pruning is not implemented, and deleting the state directory resets mappings and delivery history.

## Source map

| File | Responsibility |
| --- | --- |
| [`src/cli.ts`](../src/cli.ts) | Startup, shutdown, daemon bootstrap, and the read-only `doctor` command |
| [`src/config.ts`](../src/config.ts) | Settings, environment defaults, and validation |
| [`src/codex.ts`](../src/codex.ts) | Unix WebSocket transport, requests, notifications, heartbeat, and reconnects |
| [`src/bridge.ts`](../src/bridge.ts) | Discovery, event handling, message routing, approvals, and recovery |
| [`src/discord.ts`](../src/discord.ts) | Discord Gateway/REST, slash commands, buttons, modals, and message catch-up |
| [`src/turns.ts`](../src/turns.ts) | Durable per-agent turn state and model snapshots |
| [`src/render.ts`](../src/render.ts) | Logical output and prompt rendering |
| [`src/components.ts`](../src/components.ts) | Compact Components V2 cards, footers, attachments, and controls |
| [`src/store.ts`](../src/store.ts) | SQLite mappings, inbox, outbox, approvals, and turn-card state |
| [`src/types.ts`](../src/types.ts) | The supported subset of the Codex protocol |

## Protocol compatibility and validation

The adapter targets **Codex 0.169.0** and its experimental shared-daemon protocol. Older releases are not assumed compatible. When changing the supported version, generate the protocol definitions in a temporary directory and compare them with `src/types.ts`:

```sh
codex app-server generate-ts --experimental --out <temporary-directory>
```

Live daemon discovery and subscription have been checked locally. Automated tests exercise the protocol over a Unix WebSocket, queue recovery, output recovery, and approvals with simulated peers. A real Discord bot token is required to validate the complete phone → Discord → Codex workflow.

See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Discord Gateway documentation](https://docs.discord.com/developers/events/gateway) for the underlying interfaces.
