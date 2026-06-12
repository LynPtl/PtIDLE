import { getWarehouseData } from '../services/warehouseService';
import { query } from '../config/database';
import { getInventorySummary } from './inventoryService';

// Mock the database module
jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

jest.mock('./inventoryService', () => ({
  getInventorySummary: jest.fn(),
}));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockGetInventorySummary = getInventorySummary as jest.MockedFunction<typeof getInventorySummary>;

describe('WarehouseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getWarehouseData', () => {
    it('should return warehouse data for a valid user', async () => {
      const mockPlayerData = {
        id: 'player-123',
        warehouse_limits: { resource: 1000, material: 500 },
      };

      mockQuery.mockResolvedValue([mockPlayerData] as any);
      mockGetInventorySummary.mockResolvedValue({
        resource: { iron_ore: 100, coal: 50, wood: 30 },
        material: { iron_ingot: 10, plank: 5 },
        gear: { pickaxe: 1 },
        certification: {},
        card: {},
        consumable: {},
      });

      const result = await getWarehouseData('user-123');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT id, warehouse_limits FROM players WHERE user_id = $1',
        ['user-123']
      );
      expect(mockGetInventorySummary).toHaveBeenCalledWith('player-123');
      expect(result).not.toBeNull();
      expect(result?.resources).toEqual({ iron_ore: 100, coal: 50, wood: 30 });
      expect(result?.materials).toEqual({ iron_ingot: 10, plank: 5 });
      expect(result?.production_gear).toEqual({ pickaxe: 1 });
      expect(result?.storageLimits).toEqual({ resource: 1000, material: 500 });
    });

    it('should return null if player not found', async () => {
      mockQuery.mockResolvedValue([]);

      const result = await getWarehouseData('nonexistent-user');

      expect(result).toBeNull();
    });

    it('should return empty objects for null database values', async () => {
      const mockPlayerData = {
        id: 'player-123',
        warehouse_limits: null,
      };

      mockQuery.mockResolvedValue([mockPlayerData] as any);
      mockGetInventorySummary.mockResolvedValue({
        resource: {},
        material: {},
        gear: {},
        certification: {},
        card: {},
        consumable: {},
      });

      const result = await getWarehouseData('user-123');

      expect(result).not.toBeNull();
      expect(result?.resources).toEqual({});
      expect(result?.materials).toEqual({});
      expect(result?.production_gear).toEqual({});
      expect(result?.storageLimits).toEqual({});
    });

    it('should handle partial data correctly', async () => {
      const mockPlayerData = {
        id: 'player-123',
        warehouse_limits: { resource: 1000 },
      };

      mockQuery.mockResolvedValue([mockPlayerData] as any);
      mockGetInventorySummary.mockResolvedValue({
        resource: { iron_ore: 100 },
        material: {},
        gear: { pickaxe: 1 },
        certification: {},
        card: {},
        consumable: {},
      });

      const result = await getWarehouseData('user-123');

      expect(result?.resources).toEqual({ iron_ore: 100 });
      expect(result?.materials).toEqual({});
      expect(result?.production_gear).toEqual({ pickaxe: 1 });
      expect(result?.storageLimits).toEqual({ resource: 1000 });
    });
  });
});
