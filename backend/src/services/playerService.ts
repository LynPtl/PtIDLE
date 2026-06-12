import { DbClient, query, execute, withTransaction } from '../config/database';
import { addInventoryItem, getInventorySummary } from './inventoryService';
import { v4 as uuidv4 } from 'uuid';
import { QueryResultRow } from 'pg';

interface PlayerProfile {
  id: string;
  user_id: string;
  username: string;
  resources: Record<string, number>;
  materials: Record<string, number>;
  production_gear: Record<string, any>;
  warehouse_limits: Record<string, number>;
  idle_queue: any[];
  last_offline: Date | null;
  characters: Array<{
    id: string;
    name: string;
    profession: string | null;
    certification_id?: string | null;
    health: number;
    max_health: number;
    movement: number;
    energy: number;
    max_energy: number;
    position_x: number | null;
    position_y: number | null;
    is_alive: boolean;
  }>;
}

const DEFAULT_WAREHOUSE_LIMITS = {
  resource: 1000,
  material: 500,
  gear: 50,
  certification: 10,
  card: 200,
  consumable: 100,
};

const INITIAL_CERTIFICATIONS = [
  { itemKey: 'warrior_certification', profession: 'warrior' },
  { itemKey: 'ranger_certification', profession: 'ranger' },
  { itemKey: 'mage_certification', profession: 'mage' },
] as const;

async function clientQuery<T extends QueryResultRow = any>(client: DbClient, text: string, params?: any[]): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows;
}

/**
 * 初始化玩家数据
 * 在用户注册成功后调用，创建玩家记录和初始棋子
 * @param userId 用户 ID
 */
export async function initializePlayer(userId: string, externalClient?: DbClient): Promise<void> {
  const initialize = async (client: DbClient): Promise<void> => {
    // 1. 创建 players 记录（schema 已移除 resources/materials/production_gear/idle_queue）
    const playerId = uuidv4();
    const now = new Date();

    await client.query(
      `INSERT INTO players (id, user_id, warehouse_limits, last_offline, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        playerId,
        userId,
        JSON.stringify(DEFAULT_WAREHOUSE_LIMITS),
        now,
        now,
        now,
      ]
    );

    // 2. 创建 3 个初始白板棋子，职业和认证装置均未绑定
    const names = ['棋子1', '棋子2', '棋子3'];
    for (const name of names) {
      await client.query(
        `INSERT INTO characters (id, player_id, name, profession, certification_id, health, max_health, movement, energy, max_energy, position_x, position_y, is_alive, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          uuidv4(),
          playerId,
          name,
          null,
          null,
          10,
          10,
          2,
          3,
          3,
          null,
          null,
          true,
          now,
          now,
        ]
      );
    }

    // 3. 发放初始职业认证库存，并创建对应认证装置实例
    for (const certification of INITIAL_CERTIFICATIONS) {
      const metadata = { profession: certification.profession };
      const serializedMetadata = JSON.stringify(metadata);

      await addInventoryItem(
        playerId,
        'certification',
        certification.itemKey,
        1,
        metadata,
        client
      );

      const inventoryRows = await clientQuery<{ id: string }>(
        client,
        `SELECT id
         FROM inventory_items
         WHERE player_id = $1 AND item_type = $2 AND item_key = $3 AND metadata = $4::jsonb
         LIMIT 1`,
        [playerId, 'certification', certification.itemKey, serializedMetadata]
      );

      const inventoryItemId = inventoryRows[0]?.id;
      if (!inventoryItemId) {
        throw new Error(`初始职业认证库存写入失败: ${certification.itemKey}`);
      }

      await client.query(
        `INSERT INTO profession_certifications (id, player_id, inventory_item_id, profession, bound_character_id, bound_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuidv4(),
          playerId,
          inventoryItemId,
          certification.profession,
          null,
          null,
          now,
        ]
      );
    }

  };

  if (externalClient) {
    await initialize(externalClient);
    return;
  }

  await withTransaction(initialize);
}

/**
 * 根据 userId 获取玩家 ID
 * @param userId 用户 ID
 * @returns 玩家 ID
 */
export async function getPlayerIdByUserId(userId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM players WHERE user_id = $1',
    [userId]
  );

  return result.length > 0 ? result[0].id : null;
}

/**
 * 更新玩家资源
 * @param userId 用户 ID
 * @param resourcesToAdd 要添加的资源（将合并到现有资源）
 * @returns 更新后的资源
 */
export async function updateResources(
  userId: string,
  resourcesToAdd: Record<string, number>
): Promise<Record<string, number> | null> {
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
    for (const [resourceKey, quantity] of Object.entries(resourcesToAdd)) {
      await addInventoryItem(playerId, 'resource', resourceKey, quantity, {}, client);
    }

    const resourceRows = await clientQuery<{ item_key: string; quantity: number | string }>(
      client,
      `SELECT item_key, COALESCE(SUM(quantity), 0) AS quantity
       FROM inventory_items
       WHERE player_id = $1 AND item_type = $2
       GROUP BY item_key
       ORDER BY item_key`,
      [playerId, 'resource']
    );

    return resourceRows.reduce<Record<string, number>>((resources, row) => {
      resources[row.item_key] = Number(row.quantity);
      return resources;
    }, {});
  });
}

/**
 * 更新玩家离线时间
 * @param userId 用户 ID
 */
export async function updateLastOffline(userId: string): Promise<void> {
  await execute(
    'UPDATE players SET last_offline = NOW(), updated_at = NOW() WHERE user_id = $1',
    [userId]
  );
}

/**
 * 获取玩家基础信息（资源、仓储上限、离线时间）
 * @param userId 用户 ID
 */
export async function getPlayerBaseInfo(userId: string): Promise<{
  resources: Record<string, number>;
  warehouse_limits: Record<string, number>;
  last_offline: Date | null;
} | null> {
  const result = await query<{
    id: string;
    warehouse_limits: Record<string, number>;
    last_offline: Date | null;
  }>(
    'SELECT id, warehouse_limits, last_offline FROM players WHERE user_id = $1',
    [userId]
  );

  if (result.length === 0) {
    return null;
  }

  const inventory = await getInventorySummary(result[0].id);

  return {
    resources: inventory.resource,
    warehouse_limits: result[0].warehouse_limits,
    last_offline: result[0].last_offline,
  };
}

/**
 * 获取玩家完整资料
 * @param userId 用户 ID
 * @returns 玩家完整数据，包含资源、材料、棋子列表等
 */
export async function getPlayerProfile(userId: string): Promise<PlayerProfile | null> {
  // 1. 查询玩家基本信息
  const playerResult = await query<{
    id: string;
    user_id: string;
    username: string;
    warehouse_limits: Record<string, number>;
    last_offline: Date | null;
  }>(
    `SELECT p.id, p.user_id, u.username, p.warehouse_limits, p.last_offline
     FROM players p
     JOIN users u ON p.user_id = u.id
     WHERE p.user_id = $1`,
    [userId]
  );

  if (playerResult.length === 0) {
    return null;
  }

  const player = playerResult[0];
  const inventory = await getInventorySummary(player.id);

  // 2. 查询棋子列表
  const charactersResult = await query<{
    id: string;
    name: string;
    profession: string | null;
    certification_id: string | null;
    health: number;
    max_health: number;
    movement: number;
    energy: number;
    max_energy: number;
    position_x: number | null;
    position_y: number | null;
    is_alive: boolean;
  }>(
    `SELECT id, name, profession, certification_id, health, max_health, movement, energy, max_energy,
            position_x, position_y, is_alive
     FROM characters
     WHERE player_id = $1`,
    [player.id]
  );

  // 3. 组装返回数据
  return {
    id: player.id,
    user_id: player.user_id,
    username: player.username,
    resources: inventory.resource,
    materials: inventory.material,
    production_gear: inventory.gear,
    warehouse_limits: player.warehouse_limits,
    idle_queue: [],
    last_offline: player.last_offline,
    characters: charactersResult.map(char => ({
      id: char.id,
      name: char.name,
      profession: char.profession,
      certification_id: char.certification_id,
      health: char.health,
      max_health: char.max_health,
      movement: char.movement,
      energy: char.energy,
      max_energy: char.max_energy,
      position_x: char.position_x,
      position_y: char.position_y,
      is_alive: char.is_alive,
    })),
  };
}
