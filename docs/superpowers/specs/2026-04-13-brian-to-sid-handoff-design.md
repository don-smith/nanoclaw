# Brian → Sid Handoff Design

**Date:** 2026-04-13
**Status:** Approved, ready for implementation plan

## Goal

Let Brian (the morning-briefing agent) hand off a deep-dive piece to Sid (the knowledge-management agent) so Sid can ingest it into the knowledge management system and reply to Don with a short reflective acknowledgement.

The user's workflow: DM Brian → "send this deep dive to Sid" → see a confirmation in Brian's DM ("Sent to Sid.") → shortly after, see Sid's reflective ack arrive in Sid's DM in Telegram.

## Non-goals

- No reverse direction (Sid → Brian).
- No allowlist or per-folder authorization for cross-agent messages.
- No new MCP tool, transport, shared volume, file watcher, or swarm/multi-bot setup.
- No general-purpose agent-mail / threading / read receipts.
- No discovery mechanism for agents finding each other beyond knowing the target agent's name.

## Architecture

NanoClaw already has the primitives we need:

- **IPC** is the file-drop channel between a container and the host orchestrator (`data/ipc/{groupFolder}/messages/*.json`). It is not user-facing.
- The host's `sendMessage(jid, text)` dispatches through whichever channel owns the JID — Telegram, in this case. So an IPC drop targeting a Telegram chat results in a real Telegram message arriving in that chat.
- Each registered group has a stable `folder` name (e.g. `brian`, `sid`).

The handoff piggybacks on these primitives. No new transport.

### Flow

1. Don DMs Brian: "send this deep dive to Sid."
2. Brian (in his container) writes one IPC message file at `/workspace/ipc/messages/<timestamp>.json`:
   ```json
   { "type": "message", "agent": "Sid", "text": "<markdown with front-matter>" }
   ```
3. Brian replies to Don in the DM: "Sent to Sid."
4. Host IPC watcher reads the file, resolves `agent` → folder `sid` → Sid's DM JID, calls `sendMessage(sid_jid, markdown)`, deletes the file.
5. Sid's DM receives the message → his container wakes via the normal message loop.
6. Sid sees front-matter with `from: morning-briefing`, runs his standard ingest, then writes his own IPC message back into Don's DM with a 4–6 sentence reflective acknowledgement (his own take, not a summary).

### Payload format

The `text` field carries a markdown document with YAML front-matter:

```markdown
---
from: morning-briefing
title: <short descriptive title>
tags: [<tag>, <tag>]
---

<the actual content>
```

`from: morning-briefing` is **content-type-based**, not identity-based. Sid recognizes the *kind* of payload, not which agent sent it. This keeps the receiving rule decoupled from the sender roster.

JSON encoding safety is handled by `JSON.stringify` on the writer side — newlines, quotes, backslashes, unicode all escape correctly. The host already wraps the read in try/JSON.parse and routes malformed files to `data/ipc/errors/`, so a serializer bug fails loud.

## Code changes

All in `src/ipc.ts`, around the message handler at lines 73–96.

### 1. Resolve `agent` → JID

When `chatJid` is absent and `agent` is present, look up the registered group whose `folder` matches `agent.toLowerCase()`:

```ts
let chatJid = data.chatJid;
if (!chatJid && typeof data.agent === 'string') {
  const folder = data.agent.toLowerCase();
  const matchEntries = Object.entries(registeredGroups).filter(
    ([, g]) => g.folder === folder,
  );
  if (matchEntries.length === 0) {
    logger.warn(
      { agent: data.agent, sourceGroup },
      'IPC handoff: no registered group for agent',
    );
  } else {
    if (matchEntries.length > 1) {
      logger.warn(
        { folder, count: matchEntries.length },
        'Multiple JIDs map to folder; using first',
      );
    }
    chatJid = matchEntries[0][0];
  }
}
```

If neither field resolves to a JID, skip the send and let the existing `unlinkSync` clean up the file. (Same outcome as a malformed message today.)

### 2. Drop the cross-folder restriction

The current check at lines 80–94 (`isMain || targetGroup.folder === sourceGroup`) blocks any cross-folder message. Replace with: if `chatJid` resolved, just call `sendMessage(chatJid, data.text)`.

The existing `IPC message sent` info log at line 85 keeps cross-folder sends auditable in the orchestrator log without any additional code.

`chatJid` precedence: if both `chatJid` and `agent` are present, `chatJid` wins (preserves existing-caller behavior).

### 3. Type update

Add `agent?: string` to the inline type on the message branch (currently `data.type === 'message' && data.chatJid && data.text`). New guard becomes: `data.type === 'message' && (data.chatJid || data.agent) && data.text`.

Net change: ~15 lines.

## CLAUDE.md updates

### `groups/brian/CLAUDE.md` — new section "Handing off to other agents"

> When the user asks you to send research, a deep dive, or any morning-briefing follow-up to another agent, write a single IPC message file at `/workspace/ipc/messages/<timestamp>.json` containing:
>
> ```json
> { "type": "message", "agent": "<agent name>", "text": "<markdown body>" }
> ```
>
> The markdown body must start with YAML front-matter:
>
> ```yaml
> ---
> from: morning-briefing
> title: <short descriptive title>
> tags: [<tag>, <tag>]
> ---
>
> <the actual content>
> ```
>
> Use the agent's name (e.g. "Sid") — you don't need to know their chat ID. After writing the file, confirm to the user briefly: "Sent to Sid."

### `groups/sid/CLAUDE.md` — new section "Inbound deep-dive ingestion"

> When you receive a message that begins with YAML front-matter and `from: morning-briefing`, treat it as a deep-dive ingest into the knowledge management system.
>
> 1. Parse front-matter for `title` and `tags`.
> 2. Ingest as a deep dive — your standard knowledge management workflow handles the rest.
> 3. Reply to Don in this DM with a short reflective acknowledgement — your own take on what the piece surfaces, not a summary. 4–6 sentences.
> 4. If the front-matter is missing or malformed, reply explaining what's missing rather than ingesting partially.

## Testing

1. **Unit test** — extend `src/ipc-auth.test.ts` (or add `src/ipc-handoff.test.ts`) to cover:
   - `agent: "Sid"` resolves to Sid's JID and `sendMessage` is called with it.
   - `agent: "SID"` (uppercase) resolves the same.
   - Unknown agent (`agent: "Mavis"`) gets warn-logged and the file is unlinked without a send.
   - Both `chatJid` and `agent` present → `chatJid` wins.
   - Cross-folder send is no longer blocked (regression check on the auth removal).

2. **End-to-end smoke** — manual:
   - From the DM with Brian, ask him to send one of his queued deep dives to Sid.
   - Confirm Brian's "Sent to Sid." appears in his DM.
   - Confirm the deep dive arrives in the Sid DM as a Telegram message.
   - Confirm Sid ingests and replies with a 4–6 sentence reflective acknowledgement.

3. **Failure-mode check** — manual: ask Brian to send to a non-existent agent ("Mavis"); confirm orchestrator log shows the warn line and nothing else breaks.

## Failure modes and observability

- **Unknown agent name:** warn log, file deleted (consistent with current malformed handling). Brian sees no Telegram error; relies on absence of Sid's ack as the symptom. Acceptable for MVP given the small surface area.
- **`sendMessage` throws (channel down, Sid's JID stale):** existing catch path moves the file to `data/ipc/errors/`. Nothing crashes.
- **Sid receives malformed front-matter:** Sid's CLAUDE.md instructs him to reply explaining what's missing rather than partial-ingest.
- **Polling latency:** IPC is poll-based at `IPC_POLL_INTERVAL`. Handoffs can lag up to one cycle. Acceptable.

## Files touched

- `src/ipc.ts` — message-branch resolution + auth-restriction removal (~15 lines).
- Inline type for the message branch — `agent?: string`.
- `src/ipc-auth.test.ts` (or new `src/ipc-handoff.test.ts`) — unit coverage.
- `groups/brian/CLAUDE.md` — new "Handing off to other agents" section.
- `groups/sid/CLAUDE.md` — new "Inbound deep-dive ingestion" section.

No schema migrations, no flags, no new files outside tests.
