// Unit tests for playerService
import * as playerService from '../services/playerService';
import { query, execute, withTransaction } from '../config/database';
import { addInventoryItem, getInventorySummary } from './inventoryService';

// Mock the database module
jest.mock('../config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  withTransaction: jest.fn()
}));

jest.mock('./inventoryService', () => ({
  addInventoryItem: jest.fn(),
  getInventorySummary: jest.fn()
}));

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedExecute = execute as jest.MockedFunction<typeof execute>;
const mockedWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
const mockedAddInventoryItem = addInventoryItem as jest.MockedFunction<typeof addInventoryItem>;
const mockedGetInventorySummary = getInventorySummary as jest.MockedFunction<typeof getInventorySummary>;

const mockTransactionClient = {
  query: jest.fn(),
};

describe('playerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWithTransaction.mockImplementation(async callback => callback(mockTransactionClient as any));
    mockedAddInventoryItem.mockResolvedValue(undefined);
    mockedGetInventorySummary.mockResolvedValue({
      resource: {},
      material: {},
      gear: {},
      certification: {},
      card: {},
      consumable: {},
    });
    mockTransactionClient.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT id') && sql.includes('FROM inventory_items')) {
        return { rows: [{ id: `inventory-${params?.[2]}` }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
  });

  describe('initializePlayer', () => {
    const userId = 'user-123';

    it('should create a player record in a transaction with current schema columns only', async () => {
      await playerService.initializePlayer(userId);

      expect(mockedWithTransaction).toHaveBeenCalledTimes(1);

      const playerCall = mockTransactionClient.query.mock.calls[0]!;
      expect(playerCall[0]).toContain('INSERT INTO players');
      expect(playerCall[0]).toContain('id, user_id, warehouse_limits, last_offline, created_at, updated_at');
      expect(playerCall[0]).not.toContain('resources');
      expect(playerCall[0]).not.toContain('materials');
      expect(playerCall[0]).not.toContain('production_gear');
      expect(playerCall[0]).not.toContain('idle_queue');
      expect(playerCall[1]![1]).toBe(userId);
      expect(JSON.parse(playerCall[1]![2])).toEqual({
        resource: 1000,
        material: 500,
        gear: 50,
        certification: 10,
        card: 200,
        consumable: 100,
      });
    });

    it('should create 3 blank characters without profession or certification', async () => {
      await playerService.initializePlayer(userId);

      const characterCalls = mockTransactionClient.query.mock.calls.filter(call =>
        String(call[0]).includes('INSERT INTO characters')
      );

      expect(characterCalls).toHaveLength(3);
      characterCalls.forEach((call, index) => {
        expect(call[1]![2]).toBe(`棋子${index + 1}`);
        expect(call[1]![3]).toBeNull(); // profession
        expect(call[1]![4]).toBeNull(); // certification_id
        expect(call[1]![5]).toBe(10); // health
        expect(call[1]![6]).toBe(10); // max_health
        expect(call[1]![7]).toBe(2); // movement
        expect(call[1]![8]).toBe(3); // energy
        expect(call[1]![9]).toBe(3); // max_energy
        expect(call[1]![12]).toBe(true); // is_alive
      });
    });

    it('should set last_offline to current time', async () => {
      await playerService.initializePlayer(userId);

      const playerCall = mockTransactionClient.query.mock.calls[0]!;
      expect(playerCall[1]![3]).toBeInstanceOf(Date);
    });

    it('should grant initial profession certification inventory items via addInventoryItem', async () => {
      await playerService.initializePlayer(userId);

      expect(mockedAddInventoryItem).toHaveBeenCalledTimes(3);
      expect(mockedAddInventoryItem).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        'certification',
        'warrior_certification',
        1,
        { profession: 'warrior' },
        mockTransactionClient
      );
      expect(mockedAddInventoryItem).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        'certification',
        'ranger_certification',
        1,
        { profession: 'ranger' },
        mockTransactionClient
      );
      expect(mockedAddInventoryItem).toHaveBeenNthCalledWith(
        3,
        expect.any(String),
        'certification',
        'mage_certification',
        1,
        { profession: 'mage' },
        mockTransactionClient
      );
    });

    it('should insert profession certification instances linked to inventory items', async () => {
      await playerService.initializePlayer(userId);

      const certificationSelectCalls = mockTransactionClient.query.mock.calls.filter(call =>
        String(call[0]).includes('FROM inventory_items')
      );
      const certificationInsertCalls = mockTransactionClient.query.mock.calls.filter(call =>
        String(call[0]).includes('INSERT INTO profession_certifications')
      );

      expect(certificationSelectCalls).toHaveLength(3);
      expect(certificationInsertCalls).toHaveLength(3);

      expect(certificationSelectCalls[0]![1]).toEqual([
        expect.any(String),
        'certification',
        'warrior_certification',
        JSON.stringify({ profession: 'warrior' }),
      ]);
      expect(certificationInsertCalls[0]![1]![2]).toBe('inventory-warrior_certification');
      expect(certificationInsertCalls[0]![1]![3]).toBe('warrior');
      expect(certificationInsertCalls[0]![1]![4]).toBeNull();
      expect(certificationInsertCalls[0]![1]![5]).toBeNull();

      expect(certificationInsertCalls[1]![1]![2]).toBe('inventory-ranger_certification');
      expect(certificationInsertCalls[1]![1]![3]).toBe('ranger');

      expect(certificationInsertCalls[2]![1]![2]).toBe('inventory-mage_certification');
      expect(certificationInsertCalls[2]![1]![3]).toBe('mage');
    });
  });

  describe('getPlayerIdByUserId', () => {
    it('should return player id when player exists', async () => {
      mockedQuery.mockResolvedValue([{ id: 'player-123' }] as any);

      const result = await playerService.getPlayerIdByUserId('user-123');

      expect(result).toBe('player-123');
    });

    it('should return null when player does not exist', async () => {
      mockedQuery.mockResolvedValue([]);

      const result = await playerService.getPlayerIdByUserId('nonexistent-user');

      expect(result).toBeNull();
    });
  });

  describe('getPlayerProfile', () => {
    const userId = 'user-123';
    const playerId = 'player-456';

    it('should return player profile with all required fields', async () => {
      mockedQuery
        .mockResolvedValueOnce([
          {
            id: playerId,
            user_id: userId,
            username: 'testuser',
            warehouse_limits: { resource: 1000, material: 500 },
            last_offline: new Date('2026-01-01'),
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: 'char-1',
            name: '棋子1',
            profession: null,
            certification_id: null,
            health: 10,
            max_health: 10,
            movement: 2,
            energy: 3,
            max_energy: 3,
            position_x: null,
            position_y: null,
            is_alive: true,
          },
          {
            id: 'char-2',
            name: '棋子2',
            profession: null,
            certification_id: null,
            health: 10,
            max_health: 10,
            movement: 2,
            energy: 3,
            max_energy: 3,
            position_x: null,
            position_y: null,
            is_alive: true,
          },
          {
            id: 'char-3',
            name: '棋子3',
            profession: null,
            certification_id: null,
            health: 10,
            max_health: 10,
            movement: 2,
            energy: 3,
            max_energy: 3,
            position_x: null,
            position_y: null,
            is_alive: true,
          },
        ] as any);
      mockedGetInventorySummary.mockResolvedValueOnce({
        resource: { iron_ore: 10, coal: 5 },
        material: { iron_ingot: 3 },
        gear: { pickaxe: 1 },
        certification: { warrior_certification: 1 },
        card: {},
        consumable: {},
      });

      const result = await playerService.getPlayerProfile(userId);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(playerId);
      expect(result!.user_id).toBe(userId);
      expect(result!.username).toBe('testuser');
      const profileQuery = mockedQuery.mock.calls[0][0] as string;
      expect(profileQuery).not.toContain('p.resources');
      expect(profileQuery).not.toContain('p.materials');
      expect(profileQuery).not.toContain('p.production_gear');
      expect(profileQuery).not.toContain('p.idle_queue');
      expect(mockedGetInventorySummary).toHaveBeenCalledWith(playerId);
      expect(result!.resources).toEqual({ iron_ore: 10, coal: 5 });
      expect(result!.materials).toEqual({ iron_ingot: 3 });
      expect(result!.production_gear).toEqual({ pickaxe: 1 });
      expect(result!.idle_queue).toEqual([]);
      expect(result!.warehouse_limits).toEqual({ resource: 1000, material: 500 });
      expect(result!.characters).toHaveLength(3);
      expect(result!.characters[0].profession).toBeNull();
      expect(result!.characters[0].certification_id).toBeNull();
      expect(result!.characters[1].profession).toBeNull();
      expect(result!.characters[2].profession).toBeNull();
    });

    it('should return null when player does not exist', async () => {
      mockedQuery.mockResolvedValueOnce([]);

      const result = await playerService.getPlayerProfile('nonexistent-user');

      expect(result).toBeNull();
    });

    it('should return empty characters array when player has no characters', async () => {
      mockedQuery
        .mockResolvedValueOnce([
          {
            id: playerId,
            user_id: userId,
            username: 'testuser',
            warehouse_limits: {},
            last_offline: null,
          },
        ] as any)
        .mockResolvedValueOnce([]);

      const result = await playerService.getPlayerProfile(userId);

      expect(result).not.toBeNull();
      expect(result!.characters).toHaveLength(0);
    });

    it('should return current resource summary from inventory for base info', async () => {
      const lastOffline = new Date('2026-01-01');
      mockedQuery.mockResolvedValueOnce([
        {
          id: playerId,
          warehouse_limits: { resource: 1000 },
          last_offline: lastOffline,
        },
      ] as any);
      mockedGetInventorySummary.mockResolvedValueOnce({
        resource: { iron_ore: 950 },
        material: {},
        gear: {},
        certification: {},
        card: {},
        consumable: {},
      });

      const result = await playerService.getPlayerBaseInfo(userId);

      const baseInfoQuery = mockedQuery.mock.calls[0][0] as string;
      expect(baseInfoQuery).not.toContain('resources');
      expect(mockedGetInventorySummary).toHaveBeenCalledWith(playerId);
      expect(result).toEqual({
        resources: { iron_ore: 950 },
        warehouse_limits: { resource: 1000 },
        last_offline: lastOffline,
      });
    });
  });
});
