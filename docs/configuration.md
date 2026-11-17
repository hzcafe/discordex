# Discordex configuration and hosting

[← Back to the README](../README.md) · [Architecture](architecture.md)

Follow the [quick start](../README.md#quick-start) to create your bot and make the first connection. This guide covers configuration, access, running the service in the background, and diagnosing connection issues.

## Configuration reference

`DISCORDEX_CONFIG` selects the configuration file; the default is `./discordex.config.json`. Bun automatically loads `.env` from the working directory. Put `DISCORDEX_DISCORD_TOKEN` there or supply it through the environment. The token is kept out of the JSON configuration and database.

Start from [`discordex.config.example.json`](../discordex.config.example.json) and [`.env.example`](../.env.example).

| Field | Default / meaning |
| --- | --- |
| `guildId`, `channelId` | Required Discord server and text-channel IDs, as strings |
| `allowedUserIds` | Required nonempty list of contributor IDs |
| `approverUserIds` | Required nonempty list of approver IDs; each must also be in `allowedUserIds` |
| `autoDiscover` | `true`; automatically link eligible loaded sessions |
| `projectRoots` | `[]` allows all projects. Otherwise, use absolute roots; descendants are included |
| `socketPath` | `$CODEX_HOME/app-server-control/app-server-control.sock`, with `CODEX_HOME` defaulting to `~/.codex` |
| `stateDir` | `$XDG_STATE_HOME/discordex`, with `XDG_STATE_HOME` defaulting to `~/.local/state` |
| `artifacts` | Automatic document/media sharing, enabled by default; see [file sharing](file-sharing.md) for roots, upload limits, and cache retention |

If supplied, `socketPath` and `stateDir` must be absolute paths. Legacy `verbosity` settings are ignored; there are no verbosity modes.

Use one service per host/socket and a separate state directory for a different bot channel or socket. Sessions running with `--no-daemon` or hosted by another daemon are outside this connection's discovery scope.

## Access and data

The two allowlists control actions:

- **Contributors** can submit work from linked Discord threads.
- **Approvers** can also answer supported approval and input prompts. Every approver must be a contributor.

Contributors can run `/codex usage` in the configured channel or an eligible linked thread. Its response is visible only to the person who ran it. The allowance is for the host's Codex account, shared across sessions; Discord users do not get separate quotas. The command reads usage and cannot buy credits, consume resets, or change account settings.

Contributors can also use `/codex goal` and its controls in an eligible linked thread. The goal card is shared with everyone who can read that thread; command acknowledgments are private. Goal controls do not grant tool-approval permissions. Creating or resuming a goal can start work immediately. Pausing or clearing stops goal-driven continuation, while `/codex stop` interrupts the current turn.

Goal budgets are positive whole token counts. **Edit budget** sets the total budget, preserving the objective and usage history; leave it blank to remove the explicit budget (host policy limits still apply). After increasing an exhausted budget, choose **Resume**. Completed goals offer **New goal**, which starts new usage accounting. If another client changes the goal while a modal is open, refresh the card and reopen the form.

Discord channel membership controls **read access**. The bot's allowlists do not change channel visibility. Choose the server and channel membership to match who should see the exported conversations.

Output, commands, and diffs are sent to Discord and stored locally for delivery. Self-hosting the bridge does not keep exported content off Discord. Keep `.env` and `discordex.config.json` out of version control; both are gitignored.

Every allowed user's text in a linked thread is forwarded to Codex, including discussion between friends. Messages in the index channel, bot messages, and webhook messages are not forwarded. Attachments and voice messages are not ingested; accompanying text is forwarded as text only.

## Approval behavior

Command, file-change, and permission requests use interactive buttons. Supported user-input questions use a modal. Decisions are one-time or turn-scoped; they do not permanently change approval policy.

Buttons work only for configured approvers and only for the exact pending request whose full review was delivered. A decision in the local Codex client removes the corresponding Discord controls. Reconnects invalidate old controls; only requests replayed by Codex get fresh controls. If sending a decision fails or times out, Discordex reconnects to recover authoritative pending requests without automatically sending the decision again.

A command approval without its command or a file approval without its diff waits for those details. Later item events, history reads, or request replays update the same prompt automatically. Secret questions and unsupported request types, including terminal-input approvals that cannot be reviewed as a command, require the local client. Approval and input requests preserve exact commands, working directories, paths, and permission scopes so supported requests can be reviewed and answered in Discord. Only references to delivered attachments are rewritten in ordinary replies; this does not change approval details or disable their controls. Approval and input cards remain separate from turn progress cards so an update cannot hide a pending decision.

If a required review attachment cannot be delivered, the prompt remains pending but its Discord actions are unavailable. Temporary upload failures show a status notice and recover automatically on the same message, without blocking later messages or resending approval decisions. If a size or format limit prevents delivery, the notice explains the limitation and how to review that request in Codex on the host. Users do not need to diagnose a failure or run a retry command. `/codex status` includes the number of quarantined deliveries.

## Run as a Linux background service

The repository includes a systemd user unit at [`deploy/discordex.service`](../deploy/discordex.service). Adjust its checkout and Bun paths for your host, then run:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/discordex.service ~/.config/systemd/user/discordex.service
systemctl --user daemon-reload
systemctl --user enable --now discordex
journalctl --user -u discordex -f
```

The service uses the configuration and `.env` in its working directory. Stop it with:

```sh
systemctl --user stop discordex
```

If it must keep running after your last login session ends, enable user lingering according to your host's systemd setup. Stopping Discordex leaves the shared Codex daemon running.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `doctor` cannot connect | Start `codex app-server daemon start`. Check the Codex version, `CODEX_HOME`, and any custom `socketPath`. |
| No sessions appear | A session must be loaded on the connected daemon and inside `projectRoots`. Try `/codex sessions`. Sessions using `--no-daemon` are not visible. |
| No bot messages or threads | Check the token, server/channel IDs, invite scopes, channel permissions, and service logs. `doctor` checks Codex connectivity; it does not validate a full Discord round trip. |
| A linked Discord thread was deleted | Discordex automatically creates a replacement for the same Codex session when it detects deletion, normally by the next 30-second history check. `/codex attach` also checks the saved thread. Codex keeps running; delivered Discord history is not restored. |
| A bot card was deleted | The next attempted update recreates the card. Missing permissions, locked threads, or temporary failures are retried without creating replacement threads. |
| Human text does not reach Codex | Check Message Content Intent, `allowedUserIds`, and that the message is in a linked session thread. |
| An approval cannot be answered | Check `approverUserIds` and the prompt's delivery status. Temporary upload failures recover automatically. Missing command/diff details recover when Codex supplies them; size limits or unsupported prompts require review in the local client. |
| Discord cannot display a message | The notice explains the rejected format and where the full content is available. Later messages continue. For operators, the log records the rejection; a revised payload or replacement thread restores delivery eligibility. |
| An old conversation is missing | First attachment exports the active turn and future work; it does not import the whole prior conversation. |
| Usage says account limits are unavailable | Check daemon connectivity and whether the account's authentication supports the rate-limit endpoint. Rerun `/codex usage` after reconnecting. |
| Session token counts are missing or old | Counters update when Codex emits a usage notification. The card shows the last reported snapshot, including after a restart; it does not infer missing usage from transcript length. |
| A goal button is out of date | Use **Refresh** or `/codex goal`. Reconnects, goal replacement, status changes, and budget changes invalidate older controls and open forms. |
| A goal action could not be confirmed | Refresh to read the daemon's current goal before retrying. The bot does not automatically replay an uncertain mutation. |

An inbox reaction means Discordex recorded the message, not that Codex has started or completed the work. An uncertain-submission warning means the daemon connection failed around submission; check the session before resending.

Ordinary messages received while the daemon is disconnected remain in the local inbox. Reconnects reconcile queued work and recover available history. Deleted or unavailable Discord messages cannot be recovered. Read [recovery and delivery guarantees](architecture.md#recovery-and-delivery-guarantees) before resetting state.

State and transcripts are retained locally; automatic pruning is not implemented. Do not delete the state directory unless you intend to reset mappings and delivery history.
