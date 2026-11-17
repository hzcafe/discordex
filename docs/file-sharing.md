# Automatic file sharing

Discordex attaches documents and media referenced in a Codex final reply. This is enabled by default. It reads the files on the bridge's host and uploads a saved copy to the linked Discord thread. It does not prompt Codex or modify the source files.

| Reference | Discord presentation |
| --- | --- |
| `docs/plan.md` or `[Plan](docs/plan.md)` | Downloadable document |
| `[Screenshot](output/screenshot.png)` | Inline media gallery when the file is a recognized image |
| `[Demo](output/demo.mp4)` | Media gallery; playback depends on Discord and the video's format |
| `[Report](output/report.pdf)` | Downloadable PDF |

Document contents stay in the downloadable file. Discordex does not insert text excerpts into the message, preserving its character budget for the reply and brief delivery notices.

## Media sent from Discord

Discordex reads attachment and embed metadata from the incoming message immediately. Direct links to recognized image/video files on trusted media hosts are also usable inputs. There is no fixed sleep or message refresh to discover previews. A provider page without media metadata remains a link, and later edits do not replay an already-submitted prompt.

Original PNG, JPEG, WebP, GIF, AVIF, MP4, MOV, and WebM files are saved byte-for-byte under `stateDir/inbound-media`. Codex receives the local path, actual format, byte size, source URL and retention date. Image dimensions, frame count and animation-cycle duration are included when decoding provides them. GIF providers sometimes supply MP4 files; these retain their actual format. A trusted direct media URL takes precedence over a proxy that may resize or convert it; a proxy-only image is explicitly labelled as a proxy copy.

An optional still is sent alongside the original reference as a native Codex image input. Images are oriented, stripped of metadata and resized to fit 2048 × 2048 pixels without enlargement. Animated images use the first frame, explicitly labelled. Video uses a thumbnail supplied by Discord; the bridge does not automatically decode video frames. Codex can use tools against the saved original for frame-by-frame processing. Missing, failed or oversized previews do not remove an original that was successfully saved. If the preview inbox is full, original paths still reach Codex with an explanatory notice.

Originals use a separate bounded cache. Defaults allow four files, 32 MiB per original and 64 MiB total, with 512 MiB / 4096 files of cache capacity and seven days of retention. A saved file stays available after queue acceptance; consumption renews retention, and pending inputs or an active consuming turn protect their files from expiry cleanup. Only expired, unpinned files are reclaimed. Capacity pressure reports that an original could not be saved rather than evicting a file still within its promised retention window. Cached files are read-only and should be copied into the workspace before editing. Source associations survive restart and retries, so a later download failure does not force a previously saved original to be downloaded again.

Add an optional `inbound` object to configuration to change `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `cacheBytes`, `maxCachedFiles`, `retentionDays`, or `concurrency`. The default concurrency is two media preparations; resource slots pass directly between waiting jobs. Text without media bypasses this work. These settings are independent of outgoing `artifacts` settings.

Preview downloads have separate 8 MiB per-image / 16 MiB total limits; decoded previews have the same byte limits and a 40-million-pixel input limit. Optional previews cannot spend another original's download budget. Downloads use HTTPS on exact Discord attachment/media proxy hosts and known KLIPY/Tenor/Giphy media hosts, refuse redirects, and have a 15-second network deadline. Unsupported files and voice attachments retain links and an explicit notice. Temporary original-download failures retry through history recovery; preview failures deliver the original with a notice. Custom emoji markup is unchanged.

Preview data URLs are persisted with the input until consumption. Original files remain in their own cache for subsequent tool use. Cache limits do not bound transcripts, SQLite free pages or journal files. Shutdown awaits in-flight work; previously forwarded messages are not replayed to add old attachments.

## Reference presentation

Before sending or editing a message, Discordex replaces references to files actually included as attachments with a filename and any useful label, for example `Plan — plan.md`. This covers Markdown links, image links, and inline code containing the file path, including line suffixes. Native file cards provide the download action and size. Filenames follow collision renaming and duplicate-content handling.

All other paths and links remain as authored, including source-code references, folders, commands, working directories, and web or local-service URLs. References also remain intact when a file is unavailable, excluded by upload limits, or rejected by Discord. A verified attachment retained on an edited message still qualifies for replacement.

The same replacements apply inside generated full-response files. Uploaded source documents and media retain their original bytes. Filesystem access checks and snapshotting use the original references. Local stored history and existing Discord messages are not rewritten retroactively; an existing card uses these rules when it is next edited.

Approval and input requests preserve their command, working directory, file targets, permission scope, questions, and full-detail attachments exactly so an approver can review and respond in Discord.

Supported documents include Markdown, text, reStructuredText, CSV, PDF, HTML, SVG, DOCX, XLSX, PPTX, and OpenDocument files. HTML and SVG are downloads; the bridge does not execute or convert them. Supported media includes PNG, JPEG, GIF, WebP, AVIF, MP4, MOV, and WebM. Files without a recognized media signature are shown as downloads.

Use a Markdown link, image link, or inline code span containing a path. Relative paths resolve against that session's working directory. Absolute paths, local `file:` URLs, and `:line`, `:line:column`, or `#Lline` suffixes are understood. Paths with spaces work in inline code or angle-bracket Markdown links: `[Plan](<docs/my plan.md>)`. `sandbox:` links work only if their path actually exists on this host and is allowed; Discordex cannot access files held by a separate remote sandbox.

Progress messages, command output, code examples, unreferenced files, source-code files, and external web URLs are not uploaded automatically. Moderated assistant messages are excluded before references are extracted.

## Sharing directories

The session's working directory is the default sharing root. `artifacts.roots` adds specific directories for files such as generated reports or plans. This is separate from `projectRoots`, which controls session discovery: discovering `/root/dev` does not automatically grant every session permission to upload from all of it.

Both referenced and resolved paths must remain within allowed roots. Symlinks escaping those roots, credential filenames, `.env` files, and directories such as `.git`, `.ssh`, and `.aws` are excluded. Only regular files are read. The current file reader uses Linux `/proc/self/fd` to verify the opened file; hosts without that facility report files as unavailable rather than weaken the path checks.

Files uploaded to a thread are visible to everyone who can read it. The Discord contributor allowlist controls who can send instructions, not who can download attachments.

## Configuration

Add this optional object to `discordex.config.json`, then restart the bridge:

```json
"artifacts": {
  "enabled": true,
  "roots": [],
  "maxFiles": 4,
  "maxFileBytes": 8388608,
  "maxTotalBytes": 16777216,
  "cacheBytes": 134217728,
  "retentionDays": 7
}
```

Defaults allow four referenced files, up to 8 MiB per file and 16 MiB total per reply, with a 128 MiB snapshot cache. Generated response, approval, and goal files obey the same per-file and combined byte limits, including interaction replies and when automatic sharing is disabled. Limits may be lowered; configured maxima are eight referenced files and 20 MiB for individual/total uploads, leaving space for Discord's request overhead. Files over the budget are skipped with a notice; the text reply still arrives. Discord upload-limit rejections also fall back to text and are logged for diagnosis.

Set `enabled` to `false` to disable automatic file sharing. Add only intended output directories to `roots`; no additional directories are enabled by default.

If an approval or input request needs an attachment to show its full details, omitting or rejecting that attachment records an unavailable review delivery and removes its action buttons. The decision handler enforces the same condition. Temporary upload failures show a status notice and retry automatically with backoff, updating the same message when the full review arrives. Later messages continue delivering. Successful delivery restores controls for a still-pending request; retrying an upload never submits an approval decision. A size or format rejection explains why the review cannot be shown and directs the user to that session in Codex on the host.

## Retries and retention

When a final delivery is prepared, referenced files are copied into SQLite as content-addressed snapshots. Duplicate content is attached once per reply. Filename collisions receive a suffix. A retry uses the original snapshot, even if the original file has changed or disappeared. The bridge remembers attachment IDs from both Discord's ordinary attachments and its file/media components, so later edits retain unchanged files instead of uploading them again.

Pending uploads pin their cached bytes. Under cache pressure, older unpinned snapshots may be evicted; unpinned snapshots older than `retentionDays` are pruned when another file delivery is prepared. If the cache is occupied entirely by pending uploads, new files are skipped with a notice. The cache limit bounds retained file bytes, not the entire SQLite database or its journal.

Snapshots also support deleted-card and deleted-thread recovery. Already uploaded files can remain on an existing Discord message after their local cache expires. Recreating a message whose snapshot has expired reports that the saved file is unavailable; it never silently uploads a newer source file. Delivered conversation history is not replayed into replacement threads.
