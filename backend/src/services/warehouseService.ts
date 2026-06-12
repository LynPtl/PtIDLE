import { query } from '../config/database';
import { getInventorySummary } from './inventoryService';

export interface WarehouseData {
  resources: Record<string, number>;
  materials: Record<string, number>;
  production_gear: Record<string, any>;
  storageLimits: Record<string, number>;
}

/**
 * 获取玩家仓库数据
 * @param userId 用户 ID
 * @returns 仓库数据（资源、材料、仓储上限）
 */
export async function getWarehouseData(userId: string): Promise<WarehouseData | null> {
  const result = await query<{
    id: string;
    warehouse_limits: Record<string, number>;
  }>(
    'SELECT id, warehouse_limits FROM players WHERE user_id = $1',
    [userId]
  );

  if (result.length === 0) {
    return null;
  }

  const player = result[0];
  const inventory = await getInventorySummary(player.id);

  return {
    resources: inventory.resource,
    materials: inventory.material,
    production_gear: inventory.gear,
    storageLimits: player.warehouse_limits || {},
  };
}
