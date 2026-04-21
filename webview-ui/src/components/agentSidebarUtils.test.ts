import { describe, it, expect } from 'vitest';
import { timeAgo, getActivity, getDotInfo, groupByRoom } from './agentSidebarUtils.js';
import type { ToolActivity } from '../office/types.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { OfflineAgent, KnownProject } from '../hooks/useExtensionMessages.js';

function makeToolActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolId: 'tool-1',
    status: 'Reading file...',
    done: false,
    permissionWait: false,
    ...overrides,
  };
}

describe('timeAgo', () => {
  it('returns "just now" for timestamps less than 60 seconds ago', () => {
    const now = new Date().toISOString();
    expect(timeAgo(now)).toBe('just now');
  });

  it('returns minutes for timestamps 1-59 minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(timeAgo(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours for timestamps 1-23 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(twoHoursAgo)).toBe('2h ago');
  });

  it('returns days for timestamps 24+ hours ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(threeDaysAgo)).toBe('3d ago');
  });
});

describe('getActivity', () => {
  it('returns empty string when no tools exist', () => {
    expect(getActivity(1, {}, true)).toBe('');
  });

  it('returns status of the most recent active tool', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [
        makeToolActivity({ toolId: 't1', status: 'Old tool', done: true }),
        makeToolActivity({ toolId: 't2', status: 'Writing code...' }),
      ],
    };
    expect(getActivity(1, tools, true)).toBe('Writing code...');
  });

  it('returns "Needs approval" when active tool has permissionWait', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [makeToolActivity({ permissionWait: true, status: 'Running bash...' })],
    };
    expect(getActivity(1, tools, true)).toBe('Needs approval');
  });

  it('returns last tool status when agent is active but all tools are done', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [
        makeToolActivity({ toolId: 't1', status: 'First', done: true }),
        makeToolActivity({ toolId: 't2', status: 'Latest done', done: true }),
      ],
    };
    expect(getActivity(1, tools, true)).toBe('Latest done');
  });

  it('returns empty string when agent is not active and all tools are done', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [makeToolActivity({ done: true, status: 'Done' })],
    };
    expect(getActivity(1, tools, false)).toBe('');
  });
});

describe('getDotInfo', () => {
  it('returns null when agent is not active and has no tools', () => {
    expect(getDotInfo(1, {}, {}, false)).toBeNull();
  });

  it('returns permission color with pulse when tool has permissionWait', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [makeToolActivity({ permissionWait: true })],
    };
    const result = getDotInfo(1, tools, {}, true);
    expect(result?.color).toBe('var(--pixel-status-permission)');
    expect(result?.pulse).toBe(true);
  });

  it('returns waiting color when status is waiting', () => {
    const result = getDotInfo(1, {}, { 1: 'waiting' }, false);
    expect(result?.color).toBe('var(--pixel-status-waiting)');
    expect(result?.pulse).toBe(false);
  });

  it('returns active color when agent is active with tools', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [makeToolActivity()],
    };
    const result = getDotInfo(1, tools, {}, true);
    expect(result?.color).toBe('var(--pixel-status-active)');
    expect(result?.pulse).toBe(false);
  });

  it('returns active color when agent is active without tools', () => {
    const result = getDotInfo(1, {}, {}, true);
    expect(result?.color).toBe('var(--pixel-status-active)');
    expect(result?.pulse).toBe(false);
  });

  it('permission takes priority over waiting', () => {
    const tools: Record<number, ToolActivity[]> = {
      1: [makeToolActivity({ permissionWait: true })],
    };
    const result = getDotInfo(1, tools, { 1: 'waiting' }, true);
    expect(result?.color).toBe('var(--pixel-status-permission)');
    expect(result?.pulse).toBe(true);
  });
});

describe('groupByRoom', () => {
  function makeOfficeState(
    characters: Map<number, any> = new Map(),
    rooms: any[] = [],
  ): OfficeState {
    return { characters, rooms } as unknown as OfficeState;
  }

  it('returns empty map when no agents, offline agents, or projects', () => {
    const result = groupByRoom([], makeOfficeState(), [], []);
    expect(result.size).toBe(0);
  });

  it('groups live agents by their project name', () => {
    const chars = new Map([
      [1, { projectName: 'frontend', folderName: 'frontend', isSubagent: false }],
      [2, { projectName: 'frontend', folderName: 'frontend', isSubagent: false }],
      [3, { projectName: 'backend', folderName: 'backend', isSubagent: false }],
    ]);
    const result = groupByRoom([1, 2, 3], makeOfficeState(chars), [], []);
    expect(result.get('frontend')?.liveAgents).toEqual([1, 2]);
    expect(result.get('backend')?.liveAgents).toEqual([3]);
  });

  it('excludes sub-agents', () => {
    const chars = new Map([
      [1, { projectName: 'proj', folderName: 'proj', isSubagent: false }],
      [2, { projectName: 'proj', folderName: 'proj', isSubagent: true }],
    ]);
    const result = groupByRoom([1, 2], makeOfficeState(chars), [], []);
    expect(result.get('proj')?.liveAgents).toEqual([1]);
  });

  it('groups offline agents by project name', () => {
    const offline: OfflineAgent[] = [
      { sessionId: 's1', projectName: 'frontend' },
      { sessionId: 's2', projectName: 'backend' },
    ];
    const result = groupByRoom([], makeOfficeState(), offline, []);
    expect(result.get('frontend')?.offlineAgents).toHaveLength(1);
    expect(result.get('backend')?.offlineAgents).toHaveLength(1);
  });

  it('uses "Unknown" for offline agents without project name', () => {
    const offline: OfflineAgent[] = [{ sessionId: 's1' }];
    const result = groupByRoom([], makeOfficeState(), offline, []);
    expect(result.has('Unknown')).toBe(true);
  });

  it('populates workspace path from known projects', () => {
    const knownProjects: KnownProject[] = [
      { name: 'myproj', workspacePath: '/home/user/myproj' },
    ];
    const result = groupByRoom([], makeOfficeState(), [], knownProjects);
    expect(result.get('myproj')?.workspacePath).toBe('/home/user/myproj');
  });

  it('marks special rooms from officeState', () => {
    const rooms = [
      { projectName: 'Conference', isConferenceRoom: true },
    ];
    const result = groupByRoom([], makeOfficeState(new Map(), rooms), [], []);
    expect(result.get('Conference')?.isSpecialRoom).toBe(true);
  });

  it('populates workspace path from live agents when not in known projects', () => {
    const chars = new Map([
      [1, { projectName: 'proj', folderName: 'proj', isSubagent: false, workspacePath: '/work/proj' }],
    ]);
    const result = groupByRoom([1], makeOfficeState(chars), [], []);
    expect(result.get('proj')?.workspacePath).toBe('/work/proj');
  });
});
