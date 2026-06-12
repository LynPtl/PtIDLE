import { DbClient, execute, query } from '../config/database';
import { QueryResultRow } from 'pg';
import type { SkillType } from './gatheringService';

export type IdleTaskStatus = 'active' | 'completed' | 'claimed' | 'cancelled';

export interface IdleTask {
  id: string;
  playerId: string;
  characterId?: string;
  skillType: SkillType;
  status: IdleTaskStatus;
  startedAt: Date;
  endsAt: Date;
  claimedAt?: Date;
  result: Record<string, any>;
}

interface IdleTaskRow {
  id: string;
  player_id: string;
  character_id: string | null;
  skill_type: SkillType;
  status: IdleTaskStatus;
  started_at: Date | string;
  ends_at: Date | string;
  claimed_at: Date | string | null;
  result: Record<string, any> | null;
}

async function runQuery<T extends QueryResultRow = any>(text: string, params?: any[], client?: DbClient): Promise<T[]> {
  if (client) {
    const result = await client.query<T>(text, params);
    return result.rows;
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapIdleTask(row: IdleTaskRow): IdleTask {
  return {
    id: row.id,
    playerId: row.player_id,
    characterId: row.character_id || undefined,
    skillType: row.skill_type,
    status: row.status,
    startedAt: toDate(row.started_at),
    endsAt: toDate(row.ends_at),
    claimedAt: row.claimed_at ? toDate(row.claimed_at) : undefined,
    result: row.result || {},
  };
}

export async function createIdleTask(
  playerId: string,
  skillType: SkillType,
  characterId: string | undefined,
  durationSeconds: number,
  startedAt: Date = new Date(),
  client?: DbClient
): Promise<IdleTask> {
  const endsAt = new Date(startedAt.getTime() + durationSeconds * 1000);
  const rows = await runQuery<IdleTaskRow>(
    `INSERT INTO idle_tasks (player_id, character_id, skill_type, status, started_at, ends_at, result)
     VALUES ($1, $2, $3, 'active', $4, $5, '{}')
     RETURNING id, player_id, character_id, skill_type, status, started_at, ends_at, claimed_at, result`,
    [playerId, characterId || null, skillType, startedAt, endsAt],
    client
  );

  return mapIdleTask(rows[0]);
}

export async function getActiveIdleTaskByPlayerId(
  playerId: string,
  client?: DbClient
): Promise<IdleTask | null> {
  const rows = await runQuery<IdleTaskRow>(
    `SELECT id, player_id, character_id, skill_type, status, started_at, ends_at, claimed_at, result
     FROM idle_tasks
     WHERE player_id = $1 AND status = 'active'
     ORDER BY started_at DESC
     LIMIT 1`,
    [playerId],
    client
  );

  return rows.length > 0 ? mapIdleTask(rows[0]) : null;
}

export async function getActiveIdleTaskByUserId(userId: string): Promise<IdleTask | null> {
  const rows = await query<IdleTaskRow>(
    `SELECT t.id, t.player_id, t.character_id, t.skill_type, t.status, t.started_at, t.ends_at, t.claimed_at, t.result
     FROM idle_tasks t
     JOIN players p ON t.player_id = p.id
     WHERE p.user_id = $1 AND t.status = 'active'
     ORDER BY t.started_at DESC
     LIMIT 1`,
    [userId]
  );

  return rows.length > 0 ? mapIdleTask(rows[0]) : null;
}

export async function completeIdleTask(
  taskId: string,
  result: Record<string, any>,
  client?: DbClient
): Promise<boolean> {
  const rowCount = await runExecute(
    `UPDATE idle_tasks
     SET status = 'completed', result = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'active'`,
    [taskId, JSON.stringify(result)],
    client
  );

  return rowCount > 0;
}

export async function cancelActiveIdleTask(taskId: string, client?: DbClient): Promise<boolean> {
  const rowCount = await runExecute(
    `UPDATE idle_tasks
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND status = 'active'`,
    [taskId],
    client
  );

  return rowCount > 0;
}

export async function listDueActiveIdleTaskUsers(now: Date = new Date()): Promise<Array<{ userId: string }>> {
  const rows = await query<{ user_id: string }>(
    `SELECT DISTINCT p.user_id
     FROM idle_tasks t
     JOIN players p ON t.player_id = p.id
     WHERE t.status = 'active' AND t.ends_at <= $1`,
    [now]
  );

  return rows.map(row => ({ userId: row.user_id }));
}
