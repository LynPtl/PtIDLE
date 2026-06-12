import { DbClient, execute, query, withTransaction } from '../config/database';
import { QueryResultRow } from 'pg';

export type InventoryItemType =
  | 'resource'
  | 'material'
  | 'gear'
  | 'certification'
  | 'card'
  | 'consumable';

export interface InventorySummary {
  resource: Record<string, number>;
  material: Record<string, number>;
  gear: Record<string, number>;
  certification: Record<string, number>;
  card: Record<string, number>;
  consumable: Record<string, number>;
}

const INVENTORY_ITEM_TYPES: InventoryItemType[] = [
  'resource',
  'material',
  'gear',
  'certification',
  'card',
  'consumable',
];

function createEmptySummary(): InventorySummary {
  return {
    resource: {},
    material: {},
    gear: {},
    certification: {},
    card: {},
    consumable: {},
  };
}

function serializeMetadata(metadata: Record<string, any> = {}): string {
  return JSON.stringify(metadata);
}

async function clientQuery<T extends QueryResultRow = any>(client: DbClient, text: string, params?: any[]): Promise<T[]> {
  const result = await client.query<T>(text, params);
  return result.rows;
}

async function runQuery<T extends QueryResultRow = any>(text: string, params?: any[], client?: DbClient): Promise<T[]> {
  if (client) {
    return clientQuery<T>(client, text, params);
  }

  return query<T>(text, params);
}

async function runExecute(text: string, params?: any[], client?: DbClient): Promise<number> {
  if (client) {
    const result = await client.query(text, params);
    return result.rowCount || 0;
  }

  return execute(text, params);
}

export async function getInventorySummary(
  playerId: string,
  client?: DbClient
): Promise<InventorySummary> {
  const rows = await runQuery<{
    item_type: InventoryItemType;
    item_key: string;
    quantity: number | string;
  }>(
    `SELECT item_type, item_key, COALESCE(SUM(quantity), 0) AS quantity
     FROM inventory_items
     WHERE player_id = $1
     GROUP BY item_type, item_key
     ORDER BY item_type, item_key`,
    [playerId],
    client
  );

  const summary = createEmptySummary();

  for (const row of rows) {
    if (INVENTORY_ITEM_TYPES.includes(row.item_type)) {
      summary[row.item_type][row.item_key] = Number(row.quantity);
    }
  }

  return summary;
}

export async function addInventoryItem(
  playerId: string,
  itemType: InventoryItemType,
  itemKey: string,
  quantity: number,
  metadata: Record<string, any> = {},
  client?: DbClient
): Promise<void> {
  if (quantity <= 0) {
    return;
  }

  const serializedMetadata = serializeMetadata(metadata);
  await runExecute(
    `INSERT INTO inventory_items (player_id, item_type, item_key, quantity, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (player_id, item_type, item_key, metadata)
     DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity,
                   updated_at = CURRENT_TIMESTAMP`,
    [playerId, itemType, itemKey, quantity, serializedMetadata],
    client
  );
}

export async function consumeInventoryItems(
  playerId: string,
  costs: Record<string, number>,
  itemType: InventoryItemType,
  client?: DbClient
): Promise<void> {
  if (client) {
    await consumeInventoryItemsWithClient(playerId, costs, itemType, client);
    return;
  }

  await withTransaction(async transactionClient => {
    await consumeInventoryItemsWithClient(playerId, costs, itemType, transactionClient);
  });
}

async function consumeInventoryItemsWithClient(
  playerId: string,
  costs: Record<string, number>,
  itemType: InventoryItemType,
  client: DbClient
): Promise<void> {
  const entries = Object.entries(costs)
    .filter(([, quantity]) => quantity > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  for (const [itemKey, quantity] of entries) {
    const rows = await runQuery<{ id: string; quantity: number | string }>(
      `SELECT id, quantity
       FROM inventory_items
       WHERE player_id = $1 AND item_type = $2 AND item_key = $3 AND quantity > 0
       ORDER BY created_at, id
       FOR UPDATE`,
      [playerId, itemType, itemKey],
      client
    );

    const availableQuantity = rows.reduce((total, row) => total + Number(row.quantity), 0);
    if (availableQuantity < quantity) {
      throw new Error(`库存不足: ${itemKey}`);
    }

    let remaining = quantity;
    for (const row of rows) {
      if (remaining <= 0) {
        break;
      }

      const rowQuantity = Number(row.quantity);
      const deducted = Math.min(rowQuantity, remaining);
      const affectedRows = await runExecute(
        `UPDATE inventory_items
         SET quantity = quantity - $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND quantity >= $1`,
        [deducted, row.id],
        client
      );

      if (affectedRows !== 1) {
        throw new Error(`库存扣减失败: ${itemKey}`);
      }

      remaining -= deducted;
    }
  }
}

export async function getAvailableQuantity(
  playerId: string,
  itemType: InventoryItemType,
  itemKey: string,
  client?: DbClient
): Promise<number> {
  const rows = await runQuery<{ quantity: number | string }>(
    'SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_items WHERE player_id = $1 AND item_type = $2 AND item_key = $3',
    [playerId, itemType, itemKey],
    client
  );

  return Number(rows[0]?.quantity || 0);
}
