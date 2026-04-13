import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processMessageIpc, processTaskIpc, IpcDeps } from './ipc.js';
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
    invokeAgent: async () => {},
  };
});

describe('processMessageIpc cross-folder authorization', () => {
  it('allows non-main source to send to a different folder', async () => {
    await processMessageIpc(
      { type: 'message', chatJid: 'sid@dm', text: 'hello sid' },
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

describe('processTaskIpc invoke_agent', () => {
  it('dispatches to invokeAgent with folder and text', async () => {
    const invokeAgent = vi.fn(async () => {});
    const depsWithInvoke = { ...deps, invokeAgent };
    await processTaskIpc(
      { type: 'invoke_agent', agent: 'Sid', text: 'hello sid' },
      'brian',
      false,
      depsWithInvoke,
    );
    expect(invokeAgent).toHaveBeenCalledWith('Sid', 'hello sid');
  });

  it('drops the request when agent is missing', async () => {
    const invokeAgent = vi.fn(async () => {});
    const depsWithInvoke = { ...deps, invokeAgent };
    await processTaskIpc(
      { type: 'invoke_agent', text: 'hello sid' },
      'brian',
      false,
      depsWithInvoke,
    );
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('drops the request when text is missing', async () => {
    const invokeAgent = vi.fn(async () => {});
    const depsWithInvoke = { ...deps, invokeAgent };
    await processTaskIpc(
      { type: 'invoke_agent', agent: 'Sid' },
      'brian',
      false,
      depsWithInvoke,
    );
    expect(invokeAgent).not.toHaveBeenCalled();
  });
});
