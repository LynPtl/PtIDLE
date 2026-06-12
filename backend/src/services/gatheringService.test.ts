// Unit tests for gatheringService
import * as gatheringService from '../services/gatheringService';
import { query, execute, withTransaction } from '../config/database';

// Mock the database module
jest.mock('../config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  withTransaction: jest.fn(),
}));

// Mock skillService
jest.mock('../services/skillService', () => ({
  getGatheringConfig: jest.fn().mockResolvedValue({
    mining: {
      primaryResource: 'iron_ore',
      baseRate: 1,
      byproduct: 'coal',
      byproductChance: 0.3,
    },
    woodcutting: {
      primaryResource: 'wood',
      baseRate: 1,
      byproduct: 'sap',
      byproductChance: 0.2,
    },
    herbalism: {
      primaryResource: 'herb',
      baseRate: 1,
      byproduct: 'mushroom',
      byproductChance: 0.3,
    },
  }),
  clearSkillsCache: jest.fn(),
}));

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedExecute = execute as jest.MockedFunction<typeof execute>;
const mockedWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;

const mockTransactionClient = {
  query: jest.fn(),
};

describe('gatheringService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWithTransaction.mockImplementation(async callback => callback(mockTransactionClient as any));
  });

  describe('startGathering', () => {
    const userId = 'user-123';

    it('should create a new gathering task', async () => {
      const beforeStart = Date.now();
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 'task-1',
            player_id: 'player-1',
            character_id: null,
            skill_type: 'mining',
            status: 'active',
            started_at: new Date(beforeStart),
            ends_at: new Date(beforeStart + 60000),
            claimed_at: null,
            result: {},
          }],
          rowCount: 1,
        });

      const result = await gatheringService.startGathering(userId, 'mining');

      expect(result).not.toBeNull();
      expect(result?.skillType).toBe('mining');
      expect(result?.status).toBe('active');
      expect(mockedWithTransaction).toHaveBeenCalledTimes(1);
      const insertCall = mockTransactionClient.query.mock.calls.find(call =>
        String(call[0]).includes('INSERT INTO idle_tasks')
      );
      expect(insertCall?.[1]?.[0]).toBe('player-1');
      expect(insertCall?.[1]?.[1]).toBeNull();
      expect(insertCall?.[1]?.[2]).toBe('mining');
      expect(insertCall?.[1]?.[3]).toBeInstanceOf(Date);
      expect(insertCall?.[1]?.[4]).toBeInstanceOf(Date);
      expect((insertCall?.[1]?.[4] as Date).getTime() - (insertCall?.[1]?.[3] as Date).getTime()).toBe(60000);
      expect(mockTransactionClient.query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('idle_queue');
    });

    it('should throw error if already has active task', async () => {
      const startedAt = new Date(Date.now() - 30000);
      const endsAt = new Date(Date.now() + 30000);
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            id: 'task-1',
            player_id: 'player-1',
            character_id: null,
            skill_type: 'mining',
            status: 'active',
            started_at: startedAt,
            ends_at: endsAt,
            claimed_at: null,
            result: {},
          }],
          rowCount: 1,
        });

      await expect(gatheringService.startGathering(userId, 'woodcutting'))
        .rejects.toThrow('已有进行中的采集任务');
    });

    it('should return null if player not found', async () => {
      mockTransactionClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await gatheringService.startGathering(userId, 'mining');

      expect(result).toBeNull();
    });
  });

  describe('getGatheringStatus', () => {
    const userId = 'user-123';

    it('should return active task with progress', async () => {
      const startTime = new Date(Date.now() - 30000).toISOString(); // 30 seconds ago
      const endsAt = new Date(Date.now() + 30000).toISOString();

      mockedQuery.mockResolvedValueOnce([{
        id: 'task-1',
        player_id: 'player-1',
        character_id: null,
        skill_type: 'mining',
        status: 'active',
        started_at: startTime,
        ends_at: endsAt,
        claimed_at: null,
        result: {},
      }]);

      const result = await gatheringService.getGatheringStatus(userId);

      expect(result).not.toBeNull();
      expect(result?.status).toBe('active');
      expect(result?.progress).toBeGreaterThan(0);
      expect(result?.progress).toBeLessThanOrEqual(1);
    });

    it('should return null if no active task', async () => {
      mockedQuery.mockResolvedValueOnce([]);

      const result = await gatheringService.getGatheringStatus(userId);

      expect(result).toBeNull();
    });
  });

  describe('cancelGathering', () => {
    const userId = 'user-123';

    it('should cancel active gathering task', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            id: 'task-1',
            player_id: 'player-1',
            character_id: null,
            skill_type: 'mining',
            status: 'active',
            started_at: new Date().toISOString(),
            ends_at: new Date(Date.now() + 60000).toISOString(),
            claimed_at: null,
            result: {},
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await gatheringService.cancelGathering(userId);

      expect(result).toBe(true);
      expect(mockTransactionClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'cancelled'"),
        ['task-1']
      );
    });

    it('should return false if no active task', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await gatheringService.cancelGathering(userId);

      expect(result).toBe(false);
    });
  });
});
