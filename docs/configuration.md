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

If supplied, `socketPath` and `stateDir` must be absolute paths. Legacy `verbosity` settings are ignored; there are no verbosity modes.

Use one service per host/socket and a separate state directory for a different bot channel or socket. Sessions running with `--no-daemon` or hosted by another daemon are outside this connection's discovery scope.

## Access and data

The two allowlists control actions:

- **Contributors** can submit work from linked Discord threads.
- **Approvers** can also answer supported approval and input prompts. Every approver must be a contributor.

Contributors can run `/codex usage` in the configured channel or an eligible linked thread. Its response is visible only to the person who ran it. The allowance is for the host's Codex account, shared across sessions; Discord users do not get separate quotas. The command reads usage and cannot buy credits, consume resets, or change account settings.

Discord channel membership controls **read access**. The bot's allowlists do not change channel visibility. Choose the server and channel membership to match who should see the exported conversations.

Output, commands, and diffs are sent to Discord and stored locally for delivery. Self-hosting the bridge does not keep exported content off Discord. Keep `.env` and `discordex.config.json` out of version control; both are gitignored.

Every allowed user's text in a linked thread is forwarded to Codex, including discussion between friends. Messages in the index channel, bot messages, and webhook messages are not forwarded. Attachments and voice messages are not ingested; accompanying text is forwarded as text only.

## Approval behavior

Command, file-change, and permission requests use interactive buttons. Supported user-input questions use a modal. Decisions are one-time or turn-scoped; they do not permanently change approval policy.

Buttons work only for configured approvers and only for the exact pending request. A decision in the local Codex client removes the corresponding Discord controls. Reconnects invalidate old controls; only requests replayed by Codex get fresh controls.

A file approval without an available diff, a secret question, or an unsupported request type must be answered in the local client. Approval and input cards remain separate from turn progress cards so an update cannot hide a pending decision.

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
| Human text does not reach Codex | Check Message Content Intent, `allowedUserIds`, and that the message is in a linked session thread. |
| An approval cannot be answered | Check `approverUserIds` and whether the request is still pending. Some prompts require the local client. |
| An old conversation is missing | First attachment exports the active turn and future work; it does not import the whole prior conversation. |
| Usage says account limits are unavailable | Check daemon connectivity and whether the account's authentication supports the rate-limit endpoint. Rerun `/codex usage` after reconnecting. |
| Session token counts are missing or old | Counters update when Codex emits a usage notification. The card shows the last reported snapshot, including after a restart; it does not infer missing usage from transcript length. |

An inbox reaction means Discordex recorded the message, not that Codex has started or completed the work. An uncertain-submission warning means the daemon connection failed around submission; check the session before resending.

Ordinary messages received while the daemon is disconnected remain in the local inbox. Reconnects reconcile queued work and recover available history. Deleted or unavailable Discord messages cannot be recovered. Read [recovery and delivery guarantees](architecture.md#recovery-and-delivery-guarantees) before resetting state.

State and transcripts are retained locally; automatic pruning is not implemented. Do not delete the state directory unless you intend to reset mappings and delivery history.
