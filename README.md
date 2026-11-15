# Discordex

A self-hosted Discord client for the **shared local Codex daemon**. Follow sessions from your phone, send instructions with friends, and answer approval prompts in Discord while the local Codex TUI stays connected.

Runs on **Bun**. The bridge reads structured app-server events over Codex's Unix WebSocket socket; delivery does not depend on model tool calls, terminal scraping, or shell injection.

## Current functionality

- Discover loaded sessions within configured project roots and create one Discord thread per top-level conversation. Subagents share their parent's Discord thread, with their own labels.
- Keep one compact Discord Components V2 card per agent turn. It updates with commentary and current activity, then becomes the final response with a small agent/status footer. Subagent cards carry their own name. Long final output is attached in full through a file component.
- Queue ordinary Discord messages with the sender's identity. Explicit commands steer or interrupt the current turn.
- Answer command, file-change, and permission approvals with buttons; answer user-input questions with a modal. Decisions are one-time or turn-scoped, never permanent policy changes.
- Persist mappings, incoming messages, outgoing messages, and approval state using `bun:sqlite`. Recover missed Codex output and Discord messages after reconnecting.
- Keep contributor and approver allowlists separate. Only configured users can send instructions or act on prompts.

This first version is the host service. Codex plugin installation/management packaging is still to come.

## Requirements

- Bun 1.3 or newer; developed and tested with **Bun 1.4.4**.
- **Codex 0.169.0** with its shared app-server daemon. The adapter targets this version's experimental protocol; older releases are not assumed compatible.
- A Discord application with a bot, a server, and a text channel the bot can access.

Discordex connects outbound to Discord's Gateway. No public HTTP listener or inbound port forwarding is needed. Codex access stays on the local Unix socket.

## Set up

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Enable **Message Content Intent** on the bot's settings page.
2. Invite the application to your server using the `bot` and `applications.commands` scopes. Give it **View Channel**, **Send Messages**, **Create Public Threads**, **Send Messages in Threads**, **Read Message History**, **Attach Files**, and **Add Reactions** in the chosen text channel. It does not need Administrator.
3. Enable Discord's Developer Mode to copy your server, channel, and user IDs.
4. Install and configure:

   ```sh
   bun install --frozen-lockfile
   cp discordex.config.example.json discordex.config.json
   cp .env.example .env
   chmod 600 .env
   ```

   Set `DISCORDEX_DISCORD_TOKEN` in `.env`. Put the IDs and your project's absolute path into `discordex.config.json`. Add friends to `allowedUserIds`; add only the people who may authorize actions to `approverUserIds`. Approvers must also be contributors.

5. Start Codex and check the connection:

   ```sh
   codex app-server daemon start
   bun run doctor
   bun start
   ```

`doctor` only connects and lists loaded session IDs; it never sends prompts or posts to Discord. `start` can start the default Codex daemon if its socket is absent. It leaves that daemon running when Discordex exits.

The bot registers `/codex` in the configured server and discovers eligible loaded sessions. New conversations appear as threads under the configured channel. The initial attachment includes the currently active turn and future work, rather than copying older conversations into Discord.

## Use from Discord

Every text message from an allowed user inside a linked thread is submitted to Codex. Human discussion there is therefore visible to the agent too. Messages in the index channel are not forwarded. Bot and webhook messages are ignored.

| Action | How |
| --- | --- |
| List eligible loaded sessions | `/codex sessions` |
| Attach a session explicitly | `/codex attach id:<Codex thread ID>` |
| Send work for the next turn | Send a normal message in the linked thread |
| Add instructions to work in progress | `/codex steer message:<instructions>` |
| Interrupt the current turn | `/codex stop` |
| Inspect connectivity | `/codex status` |

Each turn gets one message that is edited as work progresses: working, running a command, editing files, or completed commentary. On completion, the same card contains the final response; interruptions and failures remain visible in its status. Edits are coalesced with at least one second between successful updates to a turn card, and retries preserve backoff. Completed assistant text is authoritative; partial token streams and reasoning text are not exported. There are no verbosity modes; legacy `verbosity` settings are ignored.

Approval and input prompts have separate cards so progress edits cannot remove a pending decision. Reconnects recover turn state and edit the original card. Multiple agents each have their own turn card in the shared Discord thread.

Turn footers include the model name and reasoning effort when available. The source is tracked internally: the initial values are captured session settings, not per-turn execution telemetry. A daemon-reported model reroute updates that turn's model label. Later session settings changes do not rewrite older cards, and recovered historical turns without a captured model are left unlabeled.

An inbox reaction means Discordex has recorded the message. It is not a claim that Codex has finished—or even started—the requested work. An uncertain-submission warning means the daemon connection failed around a submission; check the session before resending.

Approve/decline buttons work only for configured approvers and only for the exact pending request. Resolution in the local TUI removes the Discord controls. Reconnects invalidate old controls; only requests replayed by Codex get fresh controls. A file approval without an available diff, a secret question, or an unsupported request type must be answered in the local client.

Attachments and voice messages are not ingested in this version. Text accompanying an attachment is forwarded as text only.

## Configuration

`DISCORDEX_CONFIG` selects the config file; the default is `./discordex.config.json`. Bun automatically loads `.env` from the working directory. The bot token is kept out of the JSON configuration and database.

| Field | Default / meaning |
| --- | --- |
| `guildId`, `channelId` | Required Discord server and text-channel IDs |
| `allowedUserIds` | Required nonempty list of contributors |
| `approverUserIds` | Required nonempty list of approvers |
| `autoDiscover` | `true`; automatically link eligible loaded sessions |
| `projectRoots` | `[]`; all projects. Otherwise absolute roots, including their descendants |
| `socketPath` | `$CODEX_HOME/app-server-control/app-server-control.sock`, with `CODEX_HOME` defaulting to `~/.codex` |
| `stateDir` | `$XDG_STATE_HOME/discordex`, defaulting to `~/.local/state/discordex` |

Choose channel membership to match who should be able to **read** exported output. The bot's user allowlists control who can submit or approve; they do not change Discord channel visibility. Output, commands, and diffs are sent to Discord and stored locally for delivery.

Use one service per host/socket and a separate state directory for a different bot channel or socket. Sessions running with `--no-daemon` or hosted by another daemon are outside this connection's discovery scope.

## Run as a background service on Linux

An example user service is provided in [`deploy/discordex.service`](deploy/discordex.service). Adjust the checkout path and Bun path if necessary, then:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/discordex.service ~/.config/systemd/user/discordex.service
systemctl --user daemon-reload
systemctl --user enable --now discordex
journalctl --user -u discordex -f
```

Use `systemctl --user stop discordex` to stop the bot. The service uses your existing config and `.env` in the checkout. If it must keep running after your last login session ends, enable user lingering according to your host's systemd setup.

## Recovery and limits

Codex is authoritative for session history and pending requests. Discordex saves event-derived deliveries before sending them and uses stable keys to ignore repeated events. It uses Discord nonces to reduce duplicate sends around network failures. Discord's nonce deduplication window is finite: a crash after Discord accepted a message but before its ID was saved can still cause a duplicate after a sufficiently long outage. There is no exactly-once guarantee across the two services.

Incoming messages use the Discord message ID as Codex's `clientUserMessageId`. Uncertain submissions are reconciled against the daemon's queue and history; they are not blindly replayed. Ordinary messages received while disconnected stay in the local inbox. Deleted or unavailable Discord messages cannot be recovered.

Reconnecting reattaches tracked threads and reads history from the last processed turn. This keeps those conversations loaded in the shared daemon while Discordex is running. State and transcripts are retained locally; automatic pruning is not implemented yet. Do not delete the state directory unless you intend to reset mappings and delivery history.

Live daemon discovery and subscription have been checked locally. The automated suite exercises the protocol over a Unix WebSocket, queue recovery, output recovery, and approvals with simulated peers. A real Discord bot token is required to validate the complete phone → Discord → Codex workflow.

## Development

```sh
bun run check
bun test
bun run build
```

`bun dev` watches the source. `bun run build` produces a Bun-targeted entry point in `dist/`; production can also run the TypeScript source directly. Standard `node:` compatibility modules and `ws` are used where needed by the Unix WebSocket/Discord transports; Node is not a runtime dependency.

The protocol subset is in `src/types.ts`. Compare it with `codex app-server generate-ts --experimental --out <temporary-directory>` when updating supported Codex versions. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Discord Gateway documentation](https://docs.discord.com/developers/events/gateway) for the underlying interfaces.
