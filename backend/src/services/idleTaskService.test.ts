import {
  cancelActiveIdleTask,
  createIdleTask,
  getActiveIdleTaskByPlayerId,
} from './idleTaskService';
import { query, execute } from '../config/database';

jest.mock('../config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
}));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockExecute = execute as jest.MockedFunction<typeof execute>;

describe('idleTaskService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create an active idle task row with calculated ends_at', async () => {
    const startedAt = new Date('2026-06-12T00:00:00.000Z');
    const endsAt = new Date('2026-06-12T00:01:00.000Z');
    mockQuery.mockResolvedValueOnce([
      {
        id: 'task-1',
        player_id: 'player-1',
        character_id: null,
        skill_type: 'mining',
        status: 'active',
        started_at: startedAt,
        ends_at: endsAt,
        claimed_at: null,
        result: {},
      },
    ] as any);

    const task = await createIdleTask('player-1', 'mining', undefined, 60, startedAt);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO idle_tasks'),
      ['player-1', null, 'mining', startedAt, endsAt]
    );
    expect(task).toMatchObject({
      id: 'task-1',
      playerId: 'player-1',
      characterId: undefined,
      skillType: 'mining',
      status: 'active',
      startedAt,
      endsAt,
      result: {},
    });
  });

  it('should read the active task from idle_tasks instead of players.idle_queue', async () => {
    const startedAt = new Date('2026-06-12T00:00:00.000Z');
    const endsAt = new Date('2026-06-12T00:01:00.000Z');
    mockQuery.mockResolvedValueOnce([
      {
        id: 'task-1',
        player_id: 'player-1',
        character_id: 'char-1',
        skill_type: 'woodcutting',
        status: 'active',
        started_at: startedAt,
        ends_at: endsAt,
        claimed_at: null,
        result: {},
      },
    ] as any);

    const task = await getActiveIdleTaskByPlayerId('player-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM idle_tasks'),
      ['player-1']
    );
    expect(String(mockQuery.mock.calls[0]?.[0])).not.toContain('idle_queue');
    expect(task?.characterId).toBe('char-1');
    expect(task?.skillType).toBe('woodcutting');
  });

  it('should cancel only active tasks in idle_tasks', async () => {
    mockExecute.mockResolvedValueOnce(1);

    const cancelled = await cancelActiveIdleTask('task-1');

    expect(cancelled).toBe(true);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining("status = 'cancelled'"),
      ['task-1']
    );
  });
});
