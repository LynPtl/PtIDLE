import {
  addInventoryItem,
  consumeInventoryItems,
  getAvailableQuantity,
  getInventorySummary,
} from '../services/inventoryService';
import { execute, query, withTransaction } from '../config/database';

jest.mock('../config/database', () => ({
  execute: jest.fn(),
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockExecute = execute as jest.MockedFunction<typeof execute>;
const mockWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;

function createMockClient() {
  return {
    query: jest.fn(),
  };
}

describe('InventoryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithTransaction.mockImplementation(async (callback: any) => callback(createMockClient()));
  });

  describe('getInventorySummary', () => {
    it('should group inventory quantities into fixed item type buckets', async () => {
      mockQuery.mockResolvedValue([
        { item_type: 'resource', item_key: 'iron_ore', quantity: 100 },
        { item_type: 'material', item_key: 'iron_ingot', quantity: '5' },
        { item_type: 'gear', item_key: 'pickaxe', quantity: 1 },
      ] as any);

      const summary = await getInventorySummary('player-1');

      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT item_type, item_key, COALESCE(SUM(quantity), 0) AS quantity
     FROM inventory_items
     WHERE player_id = $1
     GROUP BY item_type, item_key
     ORDER BY item_type, item_key`,
        ['player-1']
      );
      expect(summary).toEqual({
        resource: { iron_ore: 100 },
        material: { iron_ingot: 5 },
        gear: { pickaxe: 1 },
        certification: {},
        card: {},
        consumable: {},
      });
    });
  });

  describe('addInventoryItem', () => {
    it('should upsert inventory with matching metadata', async () => {
      await addInventoryItem('player-1', 'resource', 'iron_ore', 3, { source: 'mine' });

      expect(mockExecute).toHaveBeenCalledWith(
        `INSERT INTO inventory_items (player_id, item_type, item_key, quantity, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (player_id, item_type, item_key, metadata)
     DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity,
                   updated_at = CURRENT_TIMESTAMP`,
        ['player-1', 'resource', 'iron_ore', 3, JSON.stringify({ source: 'mine' })]
      );
    });

    it('should upsert a new inventory row when no matching row exists', async () => {
      await addInventoryItem('player-1', 'material', 'iron_ingot', 2);

      expect(mockExecute).toHaveBeenCalledWith(
        `INSERT INTO inventory_items (player_id, item_type, item_key, quantity, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (player_id, item_type, item_key, metadata)
     DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity,
                   updated_at = CURRENT_TIMESTAMP`,
        ['player-1', 'material', 'iron_ingot', 2, '{}']
      );
    });

    it('should skip non-positive quantities', async () => {
      await addInventoryItem('player-1', 'resource', 'iron_ore', 0);

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('consumeInventoryItems', () => {
    it('should throw when any cost has insufficient inventory', async () => {
      const client = createMockClient();
      mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
      client.query.mockResolvedValueOnce({ rows: [{ id: 'item-1', quantity: 1 }], rowCount: 1 });

      await expect(
        consumeInventoryItems('player-1', { iron_ore: 2 }, 'resource')
      ).rejects.toThrow('库存不足: iron_ore');

      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith(
        `SELECT id, quantity
       FROM inventory_items
       WHERE player_id = $1 AND item_type = $2 AND item_key = $3 AND quantity > 0
       ORDER BY created_at, id
       FOR UPDATE`,
        ['player-1', 'resource', 'iron_ore']
      );
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('should deduct every cost after quantities are verified', async () => {
      const client = createMockClient();
      mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
      client.query
        .mockResolvedValueOnce({ rows: [{ id: 'coal-1', quantity: 3 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'iron-1', quantity: 5 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await consumeInventoryItems('player-1', { iron_ore: 2, coal: 3 }, 'resource');

      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith(
        `UPDATE inventory_items
         SET quantity = quantity - $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND quantity >= $1`,
        [3, 'coal-1']
      );
      expect(client.query).toHaveBeenCalledWith(
        `UPDATE inventory_items
         SET quantity = quantity - $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND quantity >= $1`,
        [2, 'iron-1']
      );
    });

    it('should lock multiple item keys in stable sorted order', async () => {
      const client = createMockClient();
      mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
      client.query
        .mockResolvedValueOnce({ rows: [{ id: 'coal-1', quantity: 2 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'ore-1', quantity: 2 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await consumeInventoryItems('player-1', { iron_ore: 1, coal: 1 }, 'resource');

      expect(client.query).toHaveBeenNthCalledWith(
        1,
        `SELECT id, quantity
       FROM inventory_items
       WHERE player_id = $1 AND item_type = $2 AND item_key = $3 AND quantity > 0
       ORDER BY created_at, id
       FOR UPDATE`,
        ['player-1', 'resource', 'coal']
      );
      expect(client.query).toHaveBeenNthCalledWith(
        3,
        `SELECT id, quantity
       FROM inventory_items
       WHERE player_id = $1 AND item_type = $2 AND item_key = $3 AND quantity > 0
       ORDER BY created_at, id
       FOR UPDATE`,
        ['player-1', 'resource', 'iron_ore']
      );
    });

    it('should throw when guarded update affects no rows', async () => {
      const client = createMockClient();
      mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
      client.query
        .mockResolvedValueOnce({ rows: [{ id: 'ore-1', quantity: 3 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        consumeInventoryItems('player-1', { iron_ore: 2 }, 'resource')
      ).rejects.toThrow('库存扣减失败: iron_ore');
    });

    it('should spread deductions across metadata rows without over-deducting', async () => {
      const client = createMockClient();
      mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
      client.query
        .mockResolvedValueOnce({
          rows: [
            { id: 'ore-1', quantity: 2 },
            { id: 'ore-2', quantity: 5 },
          ],
          rowCount: 2,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await consumeInventoryItems('player-1', { iron_ore: 3 }, 'resource');

      expect(client.query).toHaveBeenCalledWith(
        `UPDATE inventory_items
         SET quantity = quantity - $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND quantity >= $1`,
        [2, 'ore-1']
      );
      expect(client.query).toHaveBeenCalledWith(
        `UPDATE inventory_items
         SET quantity = quantity - $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND quantity >= $1`,
        [1, 'ore-2']
      );
    });
  });

  describe('getAvailableQuantity', () => {
    it('should return quantity for an existing item', async () => {
      mockQuery.mockResolvedValueOnce([{ quantity: '7' }] as any);

      const quantity = await getAvailableQuantity('player-1', 'resource', 'iron_ore');

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_items WHERE player_id = $1 AND item_type = $2 AND item_key = $3',
        ['player-1', 'resource', 'iron_ore']
      );
      expect(quantity).toBe(7);
    });

    it('should return 0 when the item does not exist', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const quantity = await getAvailableQuantity('player-1', 'card', 'rookie_card');

      expect(quantity).toBe(0);
    });
  });
});
