import { DbClient, query, withTransaction } from '../config/database';
import { getGatheringConfig } from './skillService';
import { addInventoryItem } from './inventoryService';
import {
  cancelActiveIdleTask,
  completeIdleTask,
  createIdleTask,
  getActiveIdleTaskByPlayerId,
  getActiveIdleTaskByUserId,
  IdleTask,
} from './idleTaskService';

export type SkillType = 'mining' | 'woodcutting' | 'herbalism';

export interface GatheringTask {
  id: string;
  skillType: SkillType;
  characterId?: string;
  startedAt: string;
  duration: number; // in seconds
  status: 'active' | 'completed' | 'cancelled';
  result?: {
    resources: Record<string, number>;
    overflowed: Record<string, number>;
  };
  // 进度信息（仅在查询状态时返回）
  progress?: number;
  elapsedSeconds?: number;
}

// 采集技能配置（从数据库加载）
let GATHERING_CONFIG: Record<SkillType, {
  primaryResource: string;
  baseRate: number; // per minute
  byproduct: string;
  byproductChance: number;
}> | null = null;

/**
 * 初始化采集配置（从数据库加载）
 */
export async function initializeGatheringConfig(): Promise<void> {
  GATHERING_CONFIG = await getGatheringConfig() as Record<SkillType, any>;
}

/**
 * 获取当前配置（自动初始化如果未初始化）
 */
async function getConfig(): Promise<Record<SkillType, {
  primaryResource: string;
  baseRate: number;
  byproduct: string;
  byproductChance: number;
}>> {
  if (!GATHERING_CONFIG) {
    await initializeGatheringConfig();
  }
  return GATHERING_CONFIG!;
}

// 默认采集时长（秒）
const DEFAULT_GATHERING_DURATION = 60; // 1 minute for testing

async function clientQuery<T = any>(client: DbClient, text: string, params?: any[]): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows;
}

function toGatheringTask(task: IdleTask): GatheringTask {
  const duration = Math.floor((task.endsAt.getTime() - task.startedAt.getTime()) / 1000);
  return {
    id: task.id,
    skillType: task.skillType,
    characterId: task.characterId,
    startedAt: task.startedAt.toISOString(),
    duration,
    status: task.status === 'claimed' ? 'completed' : task.status,
    result: task.result as GatheringTask['result'],
  };
}

/**
 * 开始采集任务
 * @param userId 用户ID
 * @param skillType 技能类型
 * @param characterId 角色ID（可选，用于装备加成）
 */
export async function startGathering(
  userId: string,
  skillType: SkillType,
  characterId?: string
): Promise<GatheringTask | null> {
  return withTransaction(async client => {
    const playerResult = await clientQuery<{ id: string }>(
      client,
      'SELECT id FROM players WHERE user_id = $1',
      [userId]
    );

    if (playerResult.length === 0) {
      return null;
    }

    const playerId = playerResult[0].id;
    const activeTask = await getActiveIdleTaskByPlayerId(playerId, client);
    if (activeTask) {
      throw new Error('已有进行中的采集任务');
    }

    const task = await createIdleTask(
      playerId,
      skillType,
      characterId,
      DEFAULT_GATHERING_DURATION,
      new Date(),
      client
    );

    return toGatheringTask(task);
  });
}

/**
 * 获取当前采集状态
 * @param userId 用户ID
 */
export async function getGatheringStatus(
  userId: string
): Promise<GatheringTask | null> {
  const activeIdleTask = await getActiveIdleTaskByUserId(userId);
  
  // 返回最新的活跃任务
  if (!activeIdleTask) {
    return null;
  }

  const activeTask = toGatheringTask(activeIdleTask);
  if (!activeTask) {
    return null;
  }

  // 计算进度
  const startTime = new Date(activeTask.startedAt).getTime();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - startTime) / 1000);
  const progress = Math.min(elapsedSeconds / activeTask.duration, 1);

  return {
    ...activeTask,
    progress,
    elapsedSeconds,
  };
}

/**
 * 计算采集产出
 * @param task 采集任务
 * @param productionGear 生产装备加成
 */
async function calculateGatheringYield(
  task: GatheringTask,
  productionGear: Record<string, any>
): Promise<{ resources: Record<string, number>; overflowed: Record<string, number> }> {
  const config = (await getConfig())[task.skillType];

  // 计算采集时长（分钟）
  const durationMinutes = task.duration / 60;

  // 计算装备加成
  let gearBonus = 0;
  const gearKey = `${task.skillType}_bonus`;
  if (productionGear && productionGear[gearKey]) {
    gearBonus = productionGear[gearKey];
  }

  // 基础产出
  const baseYield = config.baseRate * durationMinutes;
  const actualYield = baseYield * (1 + gearBonus);

  const resources: Record<string, number> = {
    [config.primaryResource]: Math.floor(actualYield),
  };

  // 副产物
  if (Math.random() < config.byproductChance) {
    resources[config.byproduct] = Math.floor(actualYield * 0.5);
  }

  return { resources, overflowed: {} };
}

/**
 * 完成采集任务
 * @param userId 用户ID
 */
export async function completeGathering(userId: string): Promise<GatheringTask | null> {
  return withTransaction(async client => {
    const playerResult = await clientQuery<{
      id: string;
      warehouse_limits: Record<string, number> | null;
    }>(
      client,
      'SELECT id, warehouse_limits FROM players WHERE user_id = $1',
      [userId]
    );

    if (playerResult.length === 0) {
      return null;
    }

    const player = playerResult[0];
    const activeIdleTask = await getActiveIdleTaskByPlayerId(player.id, client);
    if (!activeIdleTask) {
      return null;
    }

    if (Date.now() < activeIdleTask.endsAt.getTime()) {
      return null;
    }

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

    const taskForYield = toGatheringTask(activeIdleTask);
    const { resources: earned } = await calculateGatheringYield(taskForYield, {});
    const limits = player.warehouse_limits || { resource: 1000 };
    const stored: Record<string, number> = {};
    const overflowed: Record<string, number> = {};

    for (const [resource, amount] of Object.entries(earned)) {
      const current = currentResources[resource] || 0;
      const limit = limits.resource || 1000;
      const maxAdd = Math.max(0, limit - current);
      const actualStored = Math.min(amount, maxAdd);
      stored[resource] = actualStored;
      if (amount > actualStored) {
        overflowed[resource] = amount - actualStored;
      }
      await addInventoryItem(player.id, 'resource', resource, actualStored, {}, client);
    }

    const result = { resources: stored, overflowed };
    await completeIdleTask(activeIdleTask.id, result, client);

    return {
      ...taskForYield,
      status: 'completed',
      result,
    };
  });
}

/**
 * 取消采集任务
 * @param userId 用户ID
 */
export async function cancelGathering(userId: string): Promise<boolean> {
  return withTransaction(async client => {
    const playerResult = await clientQuery<{ id: string }>(
      client,
      'SELECT id FROM players WHERE user_id = $1',
      [userId]
    );

    if (playerResult.length === 0) {
      return false;
    }

    const activeTask = await getActiveIdleTaskByPlayerId(playerResult[0].id, client);
    if (!activeTask) {
      return false;
    }

    return cancelActiveIdleTask(activeTask.id, client);
  });
}

/**
 * 检查并完成到期的采集任务（定时任务调用）
 * @param userId 用户ID
 */
export async function checkAndCompleteGathering(userId: string): Promise<GatheringTask | null> {
  const activeTask = await getActiveIdleTaskByUserId(userId);
  if (!activeTask) {
    return null;
  }

  if (Date.now() >= activeTask.endsAt.getTime()) {
    return completeGathering(userId);
  }

  return null;
}
