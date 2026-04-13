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
let sendMessage: ReturnType<typeof vi.fn> & IpcDeps['sendMessage'];
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  groups = {
    'brian@dm': BRIAN,
    'sid@dm': SID,
  };
  setRegisteredGroup('brian@dm', BRIAN);
  setRegisteredGroup('sid@dm', SID);

  sendMessage = vi.fn(async () => {}) as typeof sendMessage;
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
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'hello');
  });

  it('lowercases agent name before matching', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'SID', text: 'hello' },
      'brian',
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'hello');
  });

  it('drops the message when agent name does not match any folder', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'mavis', text: 'hello' },
      'brian',
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
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('brian@dm', 'hello');
  });
});

describe('processMessageIpc cross-folder authorization', () => {
  it('allows non-main source to send to a different folder', async () => {
    await processMessageIpc(
      { type: 'message', agent: 'sid', text: 'hello sid' },
      'brian',
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'hello sid');
  });

  it('sends to any registered chatJid regardless of source folder', async () => {
    await processMessageIpc(
      { type: 'message', chatJid: 'sid@dm', text: 'from elsewhere' },
      'whatsapp_main',
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('sid@dm', 'from elsewhere');
  });

  it('allows same-folder send (regression)', async () => {
    await processMessageIpc(
      { type: 'message', chatJid: 'brian@dm', text: 'self message' },
      'brian',
      deps,
    );
    expect(sendMessage).toHaveBeenCalledWith('brian@dm', 'self message');
  });
});
