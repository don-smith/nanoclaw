# Brian → Sid Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Brian hand a deep-dive markdown doc to Sid via IPC for ingestion into Sid's knowledge management system, with a reflective acknowledgement back to Don in Telegram.

**Architecture:** Reuse existing IPC primitives. Extend the IPC `message` envelope to accept an `agent` field (folder name) as an alternative to `chatJid`. The host resolves `agent` → registered group → JID. Drop the existing cross-folder authorization restriction since the system runs entirely under one trusted user. Sid's CLAUDE.md teaches him to recognize inbound `from: morning-briefing` markdown and ingest it; Brian's CLAUDE.md teaches him to write the IPC envelope using the agent name.

**Tech Stack:** TypeScript, Node.js, Vitest, NanoClaw IPC layer (`src/ipc.ts`).

**Spec:** `docs/superpowers/specs/2026-04-13-brian-to-sid-handoff-design.md`

---

## File Structure

**Modified:**
- `src/ipc.ts` — extract message-branch into `processMessageIpc` (preparatory refactor); add `agent` resolution; drop cross-folder restriction.
- `src/ipc-handoff.test.ts` (new) — unit coverage for `processMessageIpc`.
- `groups/brian/CLAUDE.md` — append "Handing off to other agents" section.
- `groups/sid/CLAUDE.md` — append "Inbound deep-dive ingestion" section.

**No new files outside the test.** No schema migrations, no flags.

---

## Task 1: Refactor — extract `processMessageIpc`

The existing message-handling logic lives inline inside the `processIpcFiles` closure in `src/ipc.ts` (lines 73–96), making it hard to unit-test. Mirror the existing pattern of `processTaskIpc` by extracting a sibling `processMessageIpc` function. This task is a behavior-preserving refactor — no functional changes.

**Files:**
- Modify: `src/ipc.ts` (extract function, call it from the inline loop)

- [ ] **Step 1: Add the `processMessageIpc` export**

In `src/ipc.ts`, after the `processTaskIpc` export (which ends around line 468), add a new sibling function. Use this exact code:

```ts
export interface IpcMessageData {
  type: string;
  chatJid?: string;
  agent?: string;
  text?: string;
}

export async function processMessageIpc(
  data: IpcMessageData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (data.type !== 'message' || !data.text || !data.chatJid) {
    return;
  }
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    await deps.sendMessage(data.chatJid, data.text);
    logger.info(
      { chatJid: data.chatJid, sourceGroup },
      'IPC message sent',
    );
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
  }
}
```

This intentionally preserves existing behavior bit-for-bit. The `agent` field is in the type but unused — it lights up in Task 2.

- [ ] **Step 2: Replace the inline message-handling block with a call to `processMessageIpc`**

In `src/ipc.ts`, replace lines 76–95 (the block starting `const data = JSON.parse(...)` through the closing `}` before `fs.unlinkSync(filePath);`) with:

```ts
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processMessageIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
```

The surrounding `try`/`catch`/error-quarantine logic (lines 73–75 and 97–108) stays untouched.

- [ ] **Step 3: Run the build to verify no type errors**

Run: `npm run build`
Expected: builds cleanly, no errors.

- [ ] **Step 4: Run the existing IPC test suite to verify behavior preserved**

Run: `npx vitest run src/ipc-auth.test.ts`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts
git commit -m "$(cat <<'EOF'
refactor(ipc): extract processMessageIpc for testability

Mirrors the existing processTaskIpc pattern. No behavior change —
preserves the cross-folder auth restriction and existing log lines.
Sets up the next change to add agent-field resolution under unit test.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: TDD — `agent` field resolves to JID

Add support for `agent: "<folder name>"` as an alternative to `chatJid`. The host lowercases `agent`, finds the registered group whose `folder` matches, and uses its JID. If both fields are present, `chatJid` wins (backwards compat).

**Files:**
- Test: `src/ipc-handoff.test.ts` (new)
- Modify: `src/ipc.ts` (`processMessageIpc` only)

- [ ] **Step 1: Write the failing tests**

Create `src/ipc-handoff.test.ts` with this exact content:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processMessageIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const BRIAN: RegisteredGroup = {
  name: 'Brian DM',
  folder: 'brian',
  trigger: 'always',
  added_at: '2026-04-13T00:00:00.000Z',
};

const SID: RegisteredGroup = {
  name: 'Sid DM',
  folder: 'sid',
  trigger: 'always',
  added_at: '2026-04-13T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: ReturnType<typeof vi.fn>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  groups = {
    'brian@dm': BRIAN,
    'sid@dm': SID,
  };
  setRegisteredGroup('brian@dm', BRIAN);
  setRegisteredGroup('sid@dm', SID);

  sendMessage = vi.fn(async () => {});
  deps = {
    sendMessage,
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

describe('processMessageIpc agent resolution', () => {
  it('resolves agent name to the matching folder JID', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'sid', text: 'hello' },
      'brian',
      false,
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'hello');
  });

  it('lowercases agent name before matching', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'SID', text: 'hello' },
      'brian',
      false,
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'hello');
  });

  it('drops the message when agent name does not match any folder', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'mavis', text: 'hello' },
      'brian',
      false,
      deps,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('prefers chatJid when both chatJid and agent are present', async () => {
    await processMessageIpc(
      {
        type: 'message',
        chatJid: 'brian@dm',
        agent: 'sid',
        text: 'hello',
      },
      'brian',
      false,
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('brian@dm', 'hello');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ipc-handoff.test.ts`
Expected: all four tests fail. The first two and the last fail because `processMessageIpc` doesn't yet read the `agent` field. The "drops the message when agent name does not match" test fails because the current code calls `sendMessage` with `data.chatJid` (which is `undefined`), and the check `if (isMain || (targetGroup && targetGroup.folder === sourceGroup))` falls into the warn branch — actually verify this expectation by reading the failure output. If this test happens to pass (because no `chatJid` means no `targetGroup` means warn-branch), that's fine — it still expresses the intent.

- [ ] **Step 3: Add `agent` resolution to `processMessageIpc`**

In `src/ipc.ts`, replace the `processMessageIpc` body with:

```ts
export async function processMessageIpc(
  data: IpcMessageData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (data.type !== 'message' || !data.text) {
    return;
  }
  const registeredGroups = deps.registeredGroups();

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

  if (!chatJid) {
    return;
  }

  const targetGroup = registeredGroups[chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    await deps.sendMessage(chatJid, data.text);
    logger.info({ chatJid, sourceGroup }, 'IPC message sent');
  } else {
    logger.warn(
      { chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
  }
}
```

Note the `chatJid` guard: a `chatJid` provided directly wins; otherwise we fall through to `agent` resolution. If neither yields a JID, we return silently (file gets unlinked by the caller — same outcome as today's malformed handling).

- [ ] **Step 4: Run tests to verify three pass, one still fails**

Run: `npx vitest run src/ipc-handoff.test.ts`
Expected: agent resolution tests pass. The "lowercases" and "agent → JID" and "prefers chatJid" tests pass. The "drops when agent unknown" test passes too — `sendMessage` isn't called.

If any test still fails, read the assertion and fix before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-handoff.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): resolve agent field to JID in message envelope

Adds an alternative to chatJid: write { agent: "Sid", text: "..." } and
the host looks up the registered group whose folder matches (case-
insensitive) and uses its JID. chatJid still wins when both are present.
Unknown agent names log a warning and drop the message — same as today's
malformed handling.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: TDD — drop cross-folder authorization restriction

Today, the message handler blocks any send unless source is `isMain` or target's folder matches the source folder. This blocks Brian → Sid. The system runs under one trusted user, so we open the gate. The existing `IPC message sent` log line gives audit-for-free.

**Files:**
- Test: `src/ipc-handoff.test.ts` (extend)
- Modify: `src/ipc.ts` (`processMessageIpc` only)

- [ ] **Step 1: Add the failing cross-folder test**

In `src/ipc-handoff.test.ts`, add this `describe` block at the bottom of the file (after the existing `describe`):

```ts
describe('processMessageIpc cross-folder authorization', () => {
  it('allows non-main source to send to a different folder', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'sid', text: 'hello sid' },
      'brian',
      false,
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'hello sid');
  });

  it('still allows main source to send anywhere (regression)', async () => {
    await processMessageIpc(
      { type: 'message', chatJid: 'sid@dm', text: 'from main' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'from main');
  });

  it('still allows same-folder send (regression)', async () => {
    await processMessageIpc(
      { type: 'message', chatJid: 'brian@dm', text: 'self message' },
      'brian',
      false,
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('brian@dm', 'self message');
  });
});
```

- [ ] **Step 2: Run tests to verify the cross-folder test fails**

Run: `npx vitest run src/ipc-handoff.test.ts`
Expected: the "allows non-main source to send to a different folder" test fails — `sendMessage` was not called because the current code logs "Unauthorized IPC message attempt blocked." The two regression tests should pass.

- [ ] **Step 3: Drop the auth restriction**

In `src/ipc.ts`, in `processMessageIpc`, replace the final block:

```ts
  const targetGroup = registeredGroups[chatJid];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    await deps.sendMessage(chatJid, data.text);
    logger.info({ chatJid, sourceGroup }, 'IPC message sent');
  } else {
    logger.warn(
      { chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
  }
```

with:

```ts
  await deps.sendMessage(chatJid, data.text);
  logger.info({ chatJid, sourceGroup }, 'IPC message sent');
```

The unused `targetGroup` lookup goes away. The `registeredGroups` const is still used for the agent-resolution branch above, so leave it.

- [ ] **Step 4: Run all tests to verify**

Run: `npx vitest run src/ipc-handoff.test.ts src/ipc-auth.test.ts`
Expected: all `ipc-handoff` tests pass. All `ipc-auth` tests pass (they cover task IPC, which we did not touch).

- [ ] **Step 5: Run the full build and full test suite as a final check**

Run: `npm run build && npx vitest run`
Expected: build succeeds; entire test suite passes.

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc-handoff.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): allow cross-folder message sends

Drops the isMain || sameFolder restriction on IPC message sends. The
system runs under one trusted user, and the existing 'IPC message sent'
log line gives audit-for-free. Enables agent-to-agent handoffs
(brian → sid) without an allowlist or main-group requirement.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update Brian's CLAUDE.md

Teach Brian how to write the handoff IPC envelope.

**Files:**
- Modify: `groups/brian/CLAUDE.md` (append section)

- [ ] **Step 1: Append the handoff section**

Append to `groups/brian/CLAUDE.md` (after the existing one-line persona, with a blank line above):

```markdown

## Handing off to other agents

When the user asks you to send research, a deep dive, or any morning-briefing follow-up to another agent, write a single IPC message file at `/workspace/ipc/messages/<timestamp>.json` containing:

```json
{ "type": "message", "agent": "<agent name>", "text": "<markdown body>" }
```

The markdown body must start with YAML front-matter:

```yaml
---
from: morning-briefing
title: <short descriptive title>
tags: [<tag>, <tag>]
---

<the actual content>
```

Use the agent's name (e.g. `"Sid"`) — you don't need to know their chat ID. After writing the file, confirm to the user briefly: "Sent to Sid."
```

- [ ] **Step 2: Visually verify the file**

Run: `cat groups/brian/CLAUDE.md`
Expected: the persona line is intact, followed by the new "Handing off to other agents" section. Front-matter and JSON code blocks render cleanly.

- [ ] **Step 3: Commit**

```bash
git add groups/brian/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(brian): teach handoff to other agents via IPC

Brian writes an IPC message envelope with the agent name (not a JID) and
a markdown body fronted with YAML front-matter. The host resolves the
agent name and delivers via Telegram.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update Sid's CLAUDE.md

Teach Sid to recognize inbound deep-dive ingests and reply with a reflective acknowledgement.

**Files:**
- Modify: `groups/sid/CLAUDE.md` (append section)

- [ ] **Step 1: Append the ingest section**

Append to `groups/sid/CLAUDE.md` (after the final existing section, with a blank line above):

```markdown

## Inbound deep-dive ingestion

When you receive a message that begins with YAML front-matter and `from: morning-briefing`, treat it as a deep-dive ingest into the knowledge management system.

1. Parse front-matter for `title` and `tags`.
2. Ingest as a deep dive — your standard knowledge management workflow handles the rest.
3. Reply to Don in this DM with a short reflective acknowledgement — your own take on what the piece surfaces, not a summary. 4–6 sentences.
4. If the front-matter is missing or malformed, reply explaining what's missing rather than ingesting partially.
```

- [ ] **Step 2: Visually verify the file**

Run: `tail -20 groups/sid/CLAUDE.md`
Expected: the new "Inbound deep-dive ingestion" section appears at the end with all four numbered steps intact.

- [ ] **Step 3: Commit**

```bash
git add groups/sid/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(sid): recognize inbound morning-briefing deep dives

When a message arrives starting with YAML front-matter and
from: morning-briefing, Sid treats it as a deep-dive ingest into the
knowledge management system and replies with a 4–6 sentence reflective
acknowledgement.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Build, restart, and end-to-end smoke test

Verify the change works in the live system.

**Files:** none

- [ ] **Step 1: Rebuild the orchestrator**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 2: Restart the NanoClaw service**

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Expected: no output; service restarts. Optionally tail logs in another shell with `tail -f data/logs/*.log` (or wherever logs live in this install) to watch for IPC activity.

- [ ] **Step 3: Manual smoke — happy path**

From the user's DM with Brian in Telegram, ask Brian to send one of his already-prepared deep dives to Sid. (User has indicated three are queued.)

Verify in this order:
- Brian's DM shows a brief "Sent to Sid." (or similar) confirmation.
- Sid's DM receives the deep dive as a Telegram message (the markdown body, including front-matter, will be visible in the message text).
- Within Sid's normal response time, Sid sends a 4–6 sentence reflective acknowledgement back to Don in Sid's DM.

If the deep dive arrives in Sid's DM but Sid does not ingest or does not reply, the most likely cause is Sid's CLAUDE.md edit not being picked up — check the file is committed and the agent ran with the latest version.

- [ ] **Step 4: Manual smoke — failure mode**

From the user's DM with Brian, ask Brian to send a tiny test note to a non-existent agent named "Mavis."

Verify:
- Brian writes the IPC file (he doesn't know Mavis isn't real).
- The orchestrator log contains: `IPC handoff: no registered group for agent` with `agent: "Mavis"`.
- The IPC file is removed (no buildup in `data/ipc/brian/messages/`).
- Nothing arrives in any other agent's DM.

If the file lands in `data/ipc/errors/` instead, that's also acceptable — it means a different code path quarantined it, which is still safe behavior.

- [ ] **Step 5: Push to remote**

Run: `git push origin main`
Expected: all six commits push cleanly.

---

## Self-review notes

- **Spec coverage:** Every section of the spec maps to a task. Architecture/flow → Task 6 manual smoke. Payload format → Tasks 4 & 5 (CLAUDE.md edits define the wire format both sides use). Code changes → Tasks 1–3. CLAUDE.md updates → Tasks 4 & 5. Testing → Tasks 2, 3, and 6 (unit + manual). Failure modes → Task 6 step 4.
- **Placeholder scan:** No TBD/TODO. All code blocks are complete. All commands are exact.
- **Type consistency:** `IpcMessageData`, `processMessageIpc`, and field names (`agent`, `chatJid`, `text`, `type`) are consistent across Tasks 1, 2, 3, and the test file.
- **One judgment call to flag:** Task 1 introduces a small behavior-preserving refactor (extract `processMessageIpc`) that is not literally in the spec but is the cleanest way to satisfy the spec's "Unit test" requirement. Mirrors the existing `processTaskIpc` pattern.
