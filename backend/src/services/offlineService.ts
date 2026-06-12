/**
 * 离线收益计算服务
 * 负责计算玩家离线期间的收益
 */

import { DbClient, withTransaction } from '../config/database';
import { addInventoryItem } from './inventoryService';
import { getGatheringConfig } from './skillService';

// 资源产出速率（个/分钟）
const RESOURCE_RATES: Record<string, number> = {
  iron_ore: 1,      // 铁矿石
  coal: 0.5,        // 煤炭
  wood: 1,          // 原木
  sap: 0.5,         // 树液
  herb: 1,          // 止血草
  mushroom: 0.5,    // 荧光菇
};

// 最大离线时间（分钟）
export const MAX_OFFLINE_MINUTES = 24 * 60; // 24小时

// 仓储上限默认值
export const DEFAULT_WAREHOUSE_LIMIT = 1000;

export interface OfflineEarningsResult {
  offlineTime: number;        // 离线时长（分钟）
  maxOfflineTime: number;     // 最大计入时长
  resources: {                // 各类资源产出
    iron_ore: number;
    coal: number;
    wood: number;
    sap: number;
    herb: number;
    mushroom: number;
  };
  totalResourceCount: number; // 总产出资源数
}

export interface OfflineIdleClaimResult {
  offlineTime: number;
  taskCount: number;
  earned: Record<string, number>;
  stored: Record<string, number>;
  overflowed: Record<string, number>;
  lastOffline: Date | null;
}

interface DueIdleTaskRow {
  id: string;
  skill_type: 'mining' | 'woodcutting' | 'herbalism';
  started_at: Date | string;
  ends_at: Date | string;
}

async function clientQuery<T = any>(client: DbClient, text: string, params?: any[]): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows;
}

function minutesBetween(start: Date | string, end: Date | string): number {
  const startTime = start instanceof Date ? start.getTime() : new Date(start).getTime();
  const endTime = end instanceof Date ? end.getTime() : new Date(end).getTime();
  return Math.max(0, Math.floor((endTime - startTime) / (1000 * 60)));
}

function addResource(target: Record<string, number>, key: string, quantity: number): void {
  if (quantity <= 0) {
    return;
  }
  target[key] = (target[key] || 0) + quantity;
}

/**
 * 计算可存入仓库的资源数量
 * @param current 当前资源数量
 * @param added 新增资源数量
 * @param limit 仓储上限
 * @returns 实际可存入的数量
 */
export function calculateStoredAmount(current: number, added: number, limit: number): number {
  if (added <= 0) return 0;
  const remaining = limit - current;
  return Math.min(added, Math.max(0, remaining));
}

/**
 * 计算离线收益
 * @param lastOfflineTime 玩家上次离线时间
 * @returns 离线收益结果
 */
export function calculateOfflineEarnings(lastOfflineTime: Date | null): OfflineEarningsResult {
  const now = new Date();

  // 如果没有离线时间记录，返回0
  if (!lastOfflineTime) {
    return {
      offlineTime: 0,
      maxOfflineTime: 0,
      resources: {
        iron_ore: 0,
        coal: 0,
        wood: 0,
        sap: 0,
        herb: 0,
        mushroom: 0,
      },
      totalResourceCount: 0,
    };
  }

  // 计算离线时长（分钟）
  const offlineTimeMs = now.getTime() - lastOfflineTime.getTime();
  const offlineTime = Math.floor(offlineTimeMs / (1000 * 60));

  // 限制最大离线时间
  const effectiveOfflineTime = Math.min(offlineTime, MAX_OFFLINE_MINUTES);

  // 计算各类资源产出
  const resources: Record<string, number> = {};
  let totalResourceCount = 0;

  for (const [resource, rate] of Object.entries(RESOURCE_RATES)) {
    const earned = Math.floor(effectiveOfflineTime * rate);
    resources[resource] = earned;
    totalResourceCount += earned;
  }

  return {
    offlineTime,
    maxOfflineTime: effectiveOfflineTime,
    resources: resources as OfflineEarningsResult['resources'],
    totalResourceCount,
  };
}

/**
 * 计算应用仓储上限后的实际存入数量
 * @param earnings 离线收益
 * @param currentResources 当前资源
 * @param warehouseLimits 仓储上限
 * @returns 实际可存入的资源数量
 */
export function applyWarehouseLimits(
  earnings: OfflineEarningsResult,
  currentResources: Record<string, number>,
  warehouseLimits: Record<string, number>
): {
  stored: Record<string, number>;
  overflowed: Record<string, number>;
} {
  const stored: Record<string, number> = {};
  const overflowed: Record<string, number> = {};
  const resourceLimit = warehouseLimits.resource || DEFAULT_WAREHOUSE_LIMIT;

  for (const [key, earned] of Object.entries(earnings.resources)) {
    const current = currentResources[key] || 0;
    const limit = resourceLimit;

    const storable = calculateStoredAmount(current, earned, limit);
    stored[key] = storable;
    overflowed[key] = earned - storable;
  }

  return { stored, overflowed };
}

/**
 * 结算玩家离线期间已经到期的真实挂机任务。
 *
 * 重要：这里不再按 last_offline 直接凭空发放全资源；收益只能来自 idle_tasks 中实际存在且到期的任务。
 */
export async function claimOfflineIdleRewards(
  userId: string,
  now: Date = new Date()
): Promise<OfflineIdleClaimResult | null> {
  return withTransaction(async client => {
    const playerRows = await clientQuery<{
      id: string;
      warehouse_limits: Record<string, number> | null;
      last_offline: Date | null;
    }>(
      client,
      'SELECT id, warehouse_limits, last_offline FROM players WHERE user_id = $1',
      [userId]
    );

    if (playerRows.length === 0) {
      return null;
    }

    const player = playerRows[0];
    const lastOffline = player.last_offline;
    const offlineTime = lastOffline
      ? Math.max(0, Math.floor((now.getTime() - new Date(lastOffline).getTime()) / (1000 * 60)))
      : 0;

    const dueTasks = await clientQuery<DueIdleTaskRow>(
      client,
      `SELECT id, skill_type, started_at, ends_at
       FROM idle_tasks
       WHERE player_id = $1 AND status = 'active' AND ends_at <= $2
       ORDER BY ends_at ASC, id ASC`,
      [player.id, now]
    );

    const currentResourceRows = await clientQuery<{ item_key: string; quantity: number | string }>(
      client,
      `SELECT item_key, COALESCE(SUM(quantity), 0) AS quantity
       FROM inventory_items
       WHERE player_id = $1 AND item_type = 'resource'
       GROUP BY item_key`,
      [player.id]
    );

    const currentResources = currentResourceRows.reduce<Record<string, number>>((resources, row) => {
      resources[row.item_key] = Number(row.quantity);
      return resources;
    }, {});

    const config = await getGatheringConfig();
    const earned: Record<string, number> = {};
    const stored: Record<string, number> = {};
    const overflowed: Record<string, number> = {};
    const resourceLimit = player.warehouse_limits?.resource || DEFAULT_WAREHOUSE_LIMIT;

    for (const task of dueTasks) {
      const taskConfig = config[task.skill_type];
      const durationMinutes = minutesBetween(task.started_at, task.ends_at);
      const primaryQuantity = Math.floor(durationMinutes * taskConfig.baseRate);
      const taskEarned: Record<string, number> = {};
      addResource(taskEarned, taskConfig.primaryResource, primaryQuantity);

      if (taskConfig.byproduct && taskConfig.byproductChance > 0 && Math.random() < taskConfig.byproductChance) {
        addResource(taskEarned, taskConfig.byproduct, Math.floor(primaryQuantity * 0.5));
      }

      const taskStored: Record<string, number> = {};
      const taskOverflowed: Record<string, number> = {};

      for (const [resource, amount] of Object.entries(taskEarned)) {
        addResource(earned, resource, amount);

        const current = currentResources[resource] || 0;
        const storable = calculateStoredAmount(current, amount, resourceLimit);
        const overflow = amount - storable;

        if (storable > 0) {
          currentResources[resource] = current + storable;
          addResource(stored, resource, storable);
          addResource(taskStored, resource, storable);
          await addInventoryItem(player.id, 'resource', resource, storable, {}, client);
        }

        if (overflow > 0) {
          addResource(overflowed, resource, overflow);
          addResource(taskOverflowed, resource, overflow);
        }
      }

      const taskResult = {
        resources: taskStored,
        overflowed: taskOverflowed,
      };

      await client.query(
        `UPDATE idle_tasks
         SET status = 'completed', result = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'active'`,
        [task.id, JSON.stringify(taskResult)]
      );
    }

    await client.query(
      'UPDATE players SET last_offline = $2, updated_at = NOW() WHERE id = $1',
      [player.id, now]
    );

    return {
      offlineTime,
      taskCount: dueTasks.length,
      earned,
      stored,
      overflowed,
      lastOffline,
    };
  });
}
