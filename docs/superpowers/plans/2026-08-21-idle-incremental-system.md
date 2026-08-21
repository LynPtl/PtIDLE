# Idle Incremental Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first complete PtIDLE idle incremental backend loop: deterministic gathering yields, unified inventory capacity, processing, crafting, production gear bonuses, warehouse summaries, and rule simulation.

**Architecture:** Keep the current Express + TypeScript + PostgreSQL shape. Move all resource mutations through inventory and capacity helpers, then layer crafting, gear bonuses, and simulation services on top. Online gathering and offline task settlement must use the same yield and capacity rules so tests and player-facing previews match real settlement.

**Tech Stack:** Node.js 20, TypeScript, Express, PostgreSQL `pg`, Jest, Supertest.

## Global Constraints

- The first implementation version is backend-only; do not build frontend UI in this plan.
- Do not implement PVP battle logic, rune inlay, remote expedition dungeons, random gear affixes, market trading, or multi-character parallel queues.
- Preserve fair battle design: idle growth must not directly increase chess unit base HP, base movement, base energy, or raw card damage.
- Use deterministic gathering byproduct math for this version; do not call `Math.random()` in production yield settlement.
- Every inventory mutation must happen inside a PostgreSQL transaction when it consumes and produces inventory in the same operation.
- Keep one active gathering task per player in this version.
- Leave unrelated dirty files untouched, especially current `backend/node_modules/*` and `backend/package-lock.json` changes unless the execution owner explicitly decides to clean dependency hygiene first.

---

## Scope Check

This plan covers one subsystem: the idle incremental backend. It deliberately stops before frontend screens, battle rules, and long-term production facilities. The deliverable is still testable end to end through services and REST routes.

---

## File Structure

### Database

- Modify: `backend/src/migrations/001_initial_schema.sql`
  - Add `storage` to `inventory_items.item_type`.
  - Add first-version warehouse expansion crafting recipes.
  - Adjust the base movement card recipe to consume `plank x1`.

### Services

- Modify: `backend/src/services/inventoryService.ts`
  - Keep low-level inventory summary, add, consume, and quantity functions.
  - Add support for consuming multiple item types when crafting and processing need it.
  - Extend `InventoryItemType`, `InventorySummary`, and `INVENTORY_ITEM_TYPES` with `storage`.
- Create: `backend/src/services/capacityService.ts`
  - Own capacity summaries, storable amount calculation, partial store, and strict store preflight.
- Modify: `backend/src/services/processingService.ts`
  - Keep recipe reads.
  - Add `processMaterials(userId, recipeType, quantity)` that uses unified inventory and capacity.
- Create: `backend/src/services/craftingService.ts`
  - Read crafting recipes.
  - Execute manufacturing for gear, card, certification, consumable, and storage expansion outputs.
- Create: `backend/src/services/gearService.ts`
  - Compute production gear bonuses from `gear_instances`.
- Modify: `backend/src/services/gatheringService.ts`
  - Replace random byproducts with deterministic yield math.
  - Use `gearService` and `capacityService`.
- Modify: `backend/src/services/offlineService.ts`
  - Reuse the same gathering yield and capacity logic as online task completion.
- Create: `backend/src/services/idleSimulationService.ts`
  - Simulate gathering outcomes, craftability, raw material gaps, and recommended next actions.
- Modify: `backend/src/services/warehouseService.ts`
  - Return inventory buckets plus capacity usage and active production bonuses.

### Routes

- Modify: `backend/src/routes/processing.ts`
  - Move processing mutation out of the route and into `processingService`.
- Create: `backend/src/routes/crafting.ts`
  - Expose recipe list and craft endpoint.
- Create: `backend/src/routes/idle.ts`
  - Expose rules and simulation endpoints.
- Modify: `backend/src/routes/warehouse.ts`
  - Return enhanced warehouse payload.
- Modify: `backend/src/index.ts`
  - Mount `craftingRoutes` and `idleRoutes`.

### Tests

- Create: `backend/src/services/capacityService.test.ts`
- Modify: `backend/src/services/inventoryService.test.ts`
- Modify: `backend/src/services/processingService.test.ts`
- Create: `backend/src/services/craftingService.test.ts`
- Create: `backend/src/services/gearService.test.ts`
- Modify: `backend/src/services/gatheringService.test.ts`
- Modify: `backend/src/services/offlineService.test.ts`
- Create: `backend/src/services/idleSimulationService.test.ts`
- Modify: `backend/src/services/warehouseService.test.ts`
- Modify: `backend/src/routes/processing.integration.test.ts`
- Create: `backend/src/routes/crafting.integration.test.ts`
- Create: `backend/src/routes/idle.integration.test.ts`
- Create or extend: `backend/src/routes/e2e.test.ts`

### Docs

- Modify: `memory-bank/architecture.md`
- Modify: `memory-bank/progress.md`
- Modify: `docs/todo.md`

---

## Task 1: Capacity Service And Inventory Helpers

**Files:**
- Create: `backend/src/services/capacityService.ts`
- Create: `backend/src/services/capacityService.test.ts`
- Modify: `backend/src/services/inventoryService.ts`
- Modify: `backend/src/services/inventoryService.test.ts`

**Interfaces:**
- Consumes: `getInventorySummary(playerId, client?)`, `addInventoryItem(playerId, itemType, itemKey, quantity, metadata?, client?)`
- Produces:
  - `CapacityUsage { used: number; limit: number; remaining: number }`
  - `CapacitySummary = Record<InventoryItemType, CapacityUsage>`
  - `DEFAULT_WAREHOUSE_LIMITS`
  - `getCapacitySummary(playerId: string, warehouseLimits: Record<string, number>, client?: DbClient): Promise<CapacitySummary>`
  - `calculateStorableAmount(currentUsed: number, incoming: number, limit: number): number`
  - `storeWithCapacity(playerId: string, itemType: InventoryItemType, items: Record<string, number>, warehouseLimits: Record<string, number>, mode: 'partial' | 'strict', client?: DbClient): Promise<{ stored: Record<string, number>; overflowed: Record<string, number> }>`
  - `consumeInventoryByType(playerId: string, itemType: InventoryItemType, costs: Record<string, number>, client?: DbClient): Promise<void>`
  - `consumeInventoryCostMap(playerId: string, costs: Partial<Record<InventoryItemType, Record<string, number>>>, client?: DbClient): Promise<void>`

- [ ] **Step 1: Write capacity tests**

Add these test cases in `backend/src/services/capacityService.test.ts`:

```ts
import {
  calculateStorableAmount,
  getCapacitySummary,
  storeWithCapacity,
} from './capacityService';
import { addInventoryItem, getInventorySummary } from './inventoryService';

jest.mock('./inventoryService', () => ({
  addInventoryItem: jest.fn(),
  getInventorySummary: jest.fn(),
}));

const mockAddInventoryItem = addInventoryItem as jest.MockedFunction<typeof addInventoryItem>;
const mockGetInventorySummary = getInventorySummary as jest.MockedFunction<typeof getInventorySummary>;

describe('capacityService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calculates storable amount for empty, partial, full, and invalid incoming values', () => {
    expect(calculateStorableAmount(0, 10, 100)).toBe(10);
    expect(calculateStorableAmount(95, 10, 100)).toBe(5);
    expect(calculateStorableAmount(100, 10, 100)).toBe(0);
    expect(calculateStorableAmount(20, 0, 100)).toBe(0);
  });

  it('summarizes capacity by inventory type', async () => {
    mockGetInventorySummary.mockResolvedValue({
      resource: { iron_ore: 100, coal: 20 },
      material: { iron_ingot: 5 },
      gear: { pickaxe: 1 },
      certification: {},
      card: {},
      consumable: {},
    });

    const summary = await getCapacitySummary('player-1', { resource: 150, material: 10, gear: 5 });

    expect(summary.resource).toEqual({ used: 120, limit: 150, remaining: 30 });
    expect(summary.material).toEqual({ used: 5, limit: 10, remaining: 5 });
    expect(summary.gear).toEqual({ used: 1, limit: 5, remaining: 4 });
  });

  it('partially stores items and reports overflow', async () => {
    mockGetInventorySummary.mockResolvedValue({
      resource: { iron_ore: 98 },
      material: {},
      gear: {},
      certification: {},
      card: {},
      consumable: {},
    });

    const result = await storeWithCapacity(
      'player-1',
      'resource',
      { iron_ore: 5, coal: 4 },
      { resource: 100 },
      'partial'
    );

    expect(result).toEqual({
      stored: { iron_ore: 2 },
      overflowed: { iron_ore: 3, coal: 4 },
    });
    expect(mockAddInventoryItem).toHaveBeenCalledTimes(1);
    expect(mockAddInventoryItem).toHaveBeenCalledWith('player-1', 'resource', 'iron_ore', 2, {}, undefined);
  });

  it('rejects strict storage when total output exceeds remaining capacity', async () => {
    mockGetInventorySummary.mockResolvedValue({
      resource: {},
      material: { iron_ingot: 499 },
      gear: {},
      certification: {},
      card: {},
      consumable: {},
    });

    await expect(
      storeWithCapacity('player-1', 'material', { plank: 2 }, { material: 500 }, 'strict')
    ).rejects.toThrow('仓储空间不足: material');

    expect(mockAddInventoryItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run capacity tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- capacityService.test.ts --runInBand
```

Expected: FAIL because `capacityService.ts` does not exist.

- [ ] **Step 3: Implement `capacityService.ts`**

Use this shape:

```ts
import { DbClient } from '../config/database';
import {
  addInventoryItem,
  getInventorySummary,
  InventoryItemType,
} from './inventoryService';

export interface CapacityUsage {
  used: number;
  limit: number;
  remaining: number;
}

export type CapacitySummary = Record<InventoryItemType, CapacityUsage>;

export const DEFAULT_WAREHOUSE_LIMITS: Record<InventoryItemType, number> = {
  resource: 1000,
  material: 500,
  gear: 50,
  certification: 10,
  card: 200,
  consumable: 100,
  storage: 20,
};

export function calculateStorableAmount(currentUsed: number, incoming: number, limit: number): number {
  if (incoming <= 0) return 0;
  return Math.min(incoming, Math.max(0, limit - currentUsed));
}

function sumBucket(bucket: Record<string, number> = {}): number {
  return Object.values(bucket).reduce((total, value) => total + Number(value || 0), 0);
}

export async function getCapacitySummary(
  playerId: string,
  warehouseLimits: Record<string, number> = {},
  client?: DbClient
): Promise<CapacitySummary> {
  const inventory = await getInventorySummary(playerId, client);
  const result = {} as CapacitySummary;

  for (const itemType of Object.keys(DEFAULT_WAREHOUSE_LIMITS) as InventoryItemType[]) {
    const used = sumBucket(inventory[itemType]);
    const limit = warehouseLimits[itemType] ?? DEFAULT_WAREHOUSE_LIMITS[itemType];
    result[itemType] = {
      used,
      limit,
      remaining: Math.max(0, limit - used),
    };
  }

  return result;
}

export async function storeWithCapacity(
  playerId: string,
  itemType: InventoryItemType,
  items: Record<string, number>,
  warehouseLimits: Record<string, number> = {},
  mode: 'partial' | 'strict',
  client?: DbClient
): Promise<{ stored: Record<string, number>; overflowed: Record<string, number> }> {
  const capacity = await getCapacitySummary(playerId, warehouseLimits, client);
  let remaining = capacity[itemType].remaining;
  const stored: Record<string, number> = {};
  const overflowed: Record<string, number> = {};
  const entries = Object.entries(items).filter(([, quantity]) => quantity > 0);

  const incomingTotal = entries.reduce((total, [, quantity]) => total + quantity, 0);
  if (mode === 'strict' && incomingTotal > remaining) {
    throw new Error(`仓储空间不足: ${itemType}`);
  }

  for (const [itemKey, quantity] of entries) {
    const storable = calculateStorableAmount(capacity[itemType].used + (capacity[itemType].remaining - remaining), quantity, capacity[itemType].limit);
    const actualStored = Math.min(storable, remaining);
    if (actualStored > 0) {
      stored[itemKey] = actualStored;
      remaining -= actualStored;
      await addInventoryItem(playerId, itemType, itemKey, actualStored, {}, client);
    }
    if (quantity > actualStored) {
      overflowed[itemKey] = quantity - actualStored;
    }
  }

  return { stored, overflowed };
}
```

- [ ] **Step 4: Extend inventory helper tests**

Add `storage` bucket coverage and `consumeInventoryCostMap` tests in `backend/src/services/inventoryService.test.ts`:

```ts
import { consumeInventoryCostMap } from '../services/inventoryService';

it('includes storage in inventory summaries', async () => {
  mockQuery.mockResolvedValueOnce([
    { item_type: 'storage', item_key: 'basic_resource_storage', quantity: 1 },
  ] as any);

  const summary = await getInventorySummary('player-1');

  expect(summary.storage).toEqual({ basic_resource_storage: 1 });
});

it('consumes mixed resource and material costs in one transaction', async () => {
  const client = createMockClient();
  mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
  client.query
    .mockResolvedValueOnce({ rows: [{ id: 'ore-1', quantity: 4 }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ id: 'ingot-1', quantity: 2 }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });

  await consumeInventoryCostMap('player-1', {
    resource: { iron_ore: 4 },
    material: { iron_ingot: 2 },
  });

  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('WHERE player_id = $1 AND item_type = $2'), ['player-1', 'resource', 'iron_ore']);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('WHERE player_id = $1 AND item_type = $2'), ['player-1', 'material', 'iron_ingot']);
});
```

- [ ] **Step 5: Implement inventory helper exports**

In `backend/src/services/inventoryService.ts`, rename no existing public functions. Add:

```ts
export type InventoryItemType =
  | 'resource'
  | 'material'
  | 'gear'
  | 'certification'
  | 'card'
  | 'consumable'
  | 'storage';

export async function consumeInventoryByType(
  playerId: string,
  itemType: InventoryItemType,
  costs: Record<string, number>,
  client?: DbClient
): Promise<void> {
  return consumeInventoryItems(playerId, costs, itemType, client);
}

export async function consumeInventoryCostMap(
  playerId: string,
  costs: Partial<Record<InventoryItemType, Record<string, number>>>,
  client?: DbClient
): Promise<void> {
  const run = async (transactionClient: DbClient): Promise<void> => {
    for (const itemType of INVENTORY_ITEM_TYPES) {
      const typedCosts = costs[itemType];
      if (typedCosts && Object.keys(typedCosts).length > 0) {
        await consumeInventoryItems(playerId, typedCosts, itemType, transactionClient);
      }
    }
  };

  if (client) {
    await run(client);
    return;
  }

  await withTransaction(run);
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- capacityService.test.ts inventoryService.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/capacityService.ts backend/src/services/capacityService.test.ts backend/src/services/inventoryService.ts backend/src/services/inventoryService.test.ts
git commit -m "feat: add inventory capacity service"
```

---

## Task 2: Processing Uses Unified Inventory

**Files:**
- Modify: `backend/src/services/processingService.ts`
- Modify: `backend/src/services/processingService.test.ts`
- Modify: `backend/src/routes/processing.ts`
- Modify: `backend/src/routes/processing.integration.test.ts`

**Interfaces:**
- Consumes:
  - `consumeInventoryByType(playerId, 'resource', costs, client)`
  - `storeWithCapacity(playerId, 'material', outputs, warehouseLimits, 'strict', client)`
- Produces:
  - `processMaterials(userId: string, recipeType: string, quantity?: number): Promise<ProcessingResult | null>`
  - `ProcessingResult { recipe: string; type: ProcessingRecipe['type']; quantity: number; input: Record<string, number>; output: Record<string, number>; stored: Record<string, number>; overflowed: Record<string, number> }`

- [ ] **Step 1: Write service tests for unified inventory processing**

Add tests in `backend/src/services/processingService.test.ts`:

```ts
import { processMaterials } from '../services/processingService';
import { query, withTransaction } from '../config/database';
import { consumeInventoryByType } from '../services/inventoryService';
import { storeWithCapacity } from '../services/capacityService';

jest.mock('../services/inventoryService', () => ({
  consumeInventoryByType: jest.fn(),
}));

jest.mock('../services/capacityService', () => ({
  storeWithCapacity: jest.fn(),
}));

const mockWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
const mockConsumeInventoryByType = consumeInventoryByType as jest.MockedFunction<typeof consumeInventoryByType>;
const mockStoreWithCapacity = storeWithCapacity as jest.MockedFunction<typeof storeWithCapacity>;

it('processes resources into material inventory inside one transaction', async () => {
  const client = { query: jest.fn() };
  mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
  (query as jest.Mock).mockResolvedValueOnce([{ id: 'player-1', warehouse_limits: { material: 500 } }]);
  mockStoreWithCapacity.mockResolvedValueOnce({ stored: { iron_ingot: 2 }, overflowed: {} });

  const result = await processMaterials('user-1', 'smelting', 2);

  expect(mockConsumeInventoryByType).toHaveBeenCalledWith('player-1', 'resource', { iron_ore: 4, coal: 2 }, client);
  expect(mockStoreWithCapacity).toHaveBeenCalledWith('player-1', 'material', { iron_ingot: 2 }, { material: 500 }, 'strict', client);
  expect(result?.output).toEqual({ iron_ingot: 2 });
});

it('returns null when player does not exist', async () => {
  const client = { query: jest.fn() };
  mockWithTransaction.mockImplementationOnce(async (callback: any) => callback(client));
  (query as jest.Mock).mockResolvedValueOnce([]);

  await expect(processMaterials('missing-user', 'smelting', 1)).resolves.toBeNull();
});
```

- [ ] **Step 2: Run service tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- processingService.test.ts --runInBand
```

Expected: FAIL because `processMaterials` does not exist.

- [ ] **Step 3: Implement `processMaterials`**

Add to `backend/src/services/processingService.ts`:

```ts
import { DbClient, query, withTransaction } from '../config/database';
import { consumeInventoryByType } from './inventoryService';
import { storeWithCapacity } from './capacityService';

export interface ProcessingResult {
  recipe: string;
  type: ProcessingRecipe['type'];
  quantity: number;
  input: Record<string, number>;
  output: Record<string, number>;
  stored: Record<string, number>;
  overflowed: Record<string, number>;
}

function multiplyItems(items: Record<string, number>, quantity: number, efficiency = 1): Record<string, number> {
  return Object.fromEntries(
    Object.entries(items).map(([key, value]) => [key, Math.floor(value * quantity * efficiency)])
  );
}

async function clientQuery<T = any>(client: DbClient, text: string, params?: any[]): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows;
}

export async function processMaterials(
  userId: string,
  recipeType: string,
  quantity = 1
): Promise<ProcessingResult | null> {
  const recipe = await getProcessingRecipeByType(recipeType);
  if (!recipe) {
    throw new Error('加工配方不存在');
  }

  return withTransaction(async client => {
    const players = await clientQuery<{ id: string; warehouse_limits: Record<string, number> | null }>(
      client,
      'SELECT id, warehouse_limits FROM players WHERE user_id = $1',
      [userId]
    );

    if (players.length === 0) {
      return null;
    }

    const player = players[0];
    const input = multiplyItems(recipe.input, quantity);
    const output = multiplyItems(recipe.output, quantity, recipe.efficiency);

    await consumeInventoryByType(player.id, 'resource', input, client);
    const storage = await storeWithCapacity(player.id, 'material', output, player.warehouse_limits || {}, 'strict', client);

    return {
      recipe: recipe.name,
      type: recipe.type,
      quantity,
      input,
      output,
      stored: storage.stored,
      overflowed: storage.overflowed,
    };
  });
}
```

- [ ] **Step 4: Simplify processing route mutation**

In `backend/src/routes/processing.ts`, replace the body of `POST /process` after quantity validation with:

```ts
const result = await processMaterials(userId, recipeType, quantity);

if (!result) {
  res.status(404).json({ error: 'Player not found' });
  return;
}

res.json({ success: true, data: result });
```

Map known thrown errors:

```ts
if (error instanceof Error) {
  if (error.message === '加工配方不存在') {
    res.status(404).json({ error: 'Recipe not found' });
    return;
  }
  if (error.message.startsWith('库存不足')) {
    res.status(400).json({ error: 'Insufficient materials' });
    return;
  }
  if (error.message.startsWith('仓储空间不足')) {
    res.status(400).json({ error: error.message });
    return;
  }
}
```

- [ ] **Step 5: Update processing route tests**

Change route integration tests to mock `processMaterials` instead of `getPlayerProfile` and raw `execute`.

Use this passing success shape:

```ts
(processingService.processMaterials as jest.Mock).mockResolvedValueOnce({
  recipe: '冶炼',
  type: 'smelting',
  quantity: 1,
  input: { iron_ore: 2, coal: 1 },
  output: { iron_ingot: 1 },
  stored: { iron_ingot: 1 },
  overflowed: {},
});
```

- [ ] **Step 6: Run focused processing tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- processingService.test.ts processing.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/processingService.ts backend/src/services/processingService.test.ts backend/src/routes/processing.ts backend/src/routes/processing.integration.test.ts
git commit -m "feat: process materials through inventory"
```

---

## Task 3: Crafting Service And Crafting Routes

**Files:**
- Create: `backend/src/services/craftingService.ts`
- Create: `backend/src/services/craftingService.test.ts`
- Create: `backend/src/routes/crafting.ts`
- Create: `backend/src/routes/crafting.integration.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/migrations/001_initial_schema.sql`

**Interfaces:**
- Consumes:
  - `consumeInventoryByType(playerId, 'material', input, client)`
  - `storeWithCapacity(playerId, output.item_type, { [output.item_key]: quantity }, warehouseLimits, 'strict', client)`
- Produces:
  - `CraftingRecipe { id: string; name: string; category: 'card' | 'gear' | 'certification' | 'consumable' | 'storage'; input: Record<string, number>; output: CraftingOutput; profession_required: string | null }`
  - `getAllCraftingRecipes(category?: string): Promise<CraftingRecipe[]>`
  - `getCraftingRecipeByName(name: string): Promise<CraftingRecipe | null>`
  - `craftItem(userId: string, recipeName: string, quantity?: number): Promise<CraftResult | null>`

- [ ] **Step 1: Update schema seed data**

In `backend/src/migrations/001_initial_schema.sql`, add storage expansion recipes and extend the item type check:

```sql
item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('resource', 'material', 'gear', 'certification', 'card', 'consumable', 'storage')),
```

Add recipes:

```sql
('简易资源仓', 'storage', '{"plank": 10, "iron_ingot": 3}', '{"item_type":"storage","item_key":"basic_resource_storage","limit_type":"resource","limit_increase":500,"quantity":1}', NULL),
('材料货架', 'storage', '{"plank": 8, "herb_powder": 2}', '{"item_type":"storage","item_key":"material_shelf","limit_type":"material","limit_increase":250,"quantity":1}', NULL)
```

Also extend the `crafting_recipes.category` check with `'storage'`.

- [ ] **Step 2: Write crafting service tests**

Create `backend/src/services/craftingService.test.ts` with cases:

```ts
import { craftItem, getAllCraftingRecipes } from './craftingService';
import { query, withTransaction } from '../config/database';
import { consumeInventoryByType, addInventoryItem } from './inventoryService';
import { storeWithCapacity } from './capacityService';

jest.mock('../config/database', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./inventoryService', () => ({ consumeInventoryByType: jest.fn(), addInventoryItem: jest.fn() }));
jest.mock('./capacityService', () => ({ storeWithCapacity: jest.fn() }));

it('lists crafting recipes ordered by category and name', async () => {
  (query as jest.Mock).mockResolvedValueOnce([
    { id: 'r1', name: '矿镐', category: 'gear', input: { iron_ingot: 5 }, output: { item_type: 'gear', item_key: 'pickaxe', skill_type: 'mining', bonus_rate: 0.5, quantity: 1 }, profession_required: null },
  ]);

  const recipes = await getAllCraftingRecipes();

  expect(recipes[0].name).toBe('矿镐');
});

it('crafts gear and creates a gear instance', async () => {
  const client = { query: jest.fn() };
  (withTransaction as jest.Mock).mockImplementationOnce(async (callback: any) => callback(client));
  client.query
    .mockResolvedValueOnce({ rows: [{ id: 'player-1', warehouse_limits: { gear: 50 } }] })
    .mockResolvedValueOnce({ rows: [{ id: 'inventory-1' }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  (query as jest.Mock).mockResolvedValueOnce([
    { id: 'r1', name: '矿镐', category: 'gear', input: { iron_ingot: 5, plank: 2 }, output: { item_type: 'gear', item_key: 'pickaxe', skill_type: 'mining', bonus_rate: 0.5, quantity: 1 }, profession_required: null },
  ]);
  (storeWithCapacity as jest.Mock).mockResolvedValueOnce({ stored: { pickaxe: 1 }, overflowed: {} });

  const result = await craftItem('user-1', '矿镐', 1);

  expect(consumeInventoryByType).toHaveBeenCalledWith('player-1', 'material', { iron_ingot: 5, plank: 2 }, client);
  expect(storeWithCapacity).toHaveBeenCalledWith('player-1', 'gear', { pickaxe: 1 }, { gear: 50 }, 'strict', client);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO gear_instances'), expect.any(Array));
  expect(result?.produced.gear).toEqual({ pickaxe: 1 });
});

it('applies storage expansion by increasing warehouse_limits', async () => {
  const client = { query: jest.fn() };
  (withTransaction as jest.Mock).mockImplementationOnce(async (callback: any) => callback(client));
  client.query
    .mockResolvedValueOnce({ rows: [{ id: 'player-1', warehouse_limits: { resource: 1000, material: 500 } }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  (query as jest.Mock).mockResolvedValueOnce([
    { id: 'r2', name: '简易资源仓', category: 'storage', input: { plank: 10, iron_ingot: 3 }, output: { item_type: 'storage', item_key: 'basic_resource_storage', limit_type: 'resource', limit_increase: 500, quantity: 1 }, profession_required: null },
  ]);

  const result = await craftItem('user-1', '简易资源仓', 1);

  expect(client.query).toHaveBeenCalledWith(
    'UPDATE players SET warehouse_limits = $2, updated_at = NOW() WHERE id = $1',
    ['player-1', JSON.stringify({ resource: 1500, material: 500 })]
  );
  expect(result?.warehouseLimits).toEqual({ resource: 1500, material: 500 });
});
```

- [ ] **Step 3: Run crafting tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- craftingService.test.ts --runInBand
```

Expected: FAIL because `craftingService.ts` does not exist.

- [ ] **Step 4: Implement crafting service**

Implement `backend/src/services/craftingService.ts` with these signatures:

```ts
export type CraftingCategory = 'card' | 'gear' | 'certification' | 'consumable' | 'storage';

export interface CraftingOutput {
  item_type: CraftingCategory;
  item_key: string;
  quantity: number;
  card_name?: string;
  skill_type?: 'mining' | 'woodcutting' | 'herbalism';
  bonus_rate?: number;
  profession?: 'warrior' | 'ranger' | 'mage';
  limit_type?: string;
  limit_increase?: number;
}

export interface CraftResult {
  recipeName: string;
  category: CraftingCategory;
  quantity: number;
  consumed: Record<string, number>;
  produced: Partial<Record<CraftingCategory, Record<string, number>>>;
  warehouseLimits?: Record<string, number>;
}
```

Core behavior:

```ts
const totalInput = multiplyItems(recipe.input, quantity);
const totalOutputQuantity = recipe.output.quantity * quantity;
await consumeInventoryByType(player.id, 'material', totalInput, client);

if (recipe.category === 'storage') {
  const nextLimits = { ...(player.warehouse_limits || {}) };
  const limitType = recipe.output.limit_type!;
  nextLimits[limitType] = (nextLimits[limitType] || DEFAULT_WAREHOUSE_LIMITS[limitType as InventoryItemType] || 0) + recipe.output.limit_increase! * quantity;
  await client.query('UPDATE players SET warehouse_limits = $2, updated_at = NOW() WHERE id = $1', [player.id, JSON.stringify(nextLimits)]);
  return { recipeName: recipe.name, category: recipe.category, quantity, consumed: totalInput, produced: { storage: { [recipe.output.item_key]: quantity } }, warehouseLimits: nextLimits };
}

await storeWithCapacity(player.id, recipe.output.item_type as InventoryItemType, { [recipe.output.item_key]: totalOutputQuantity }, player.warehouse_limits || {}, 'strict', client);
```

For instance outputs:

- `gear`: insert `gear_instances`.
- `certification`: insert `profession_certifications`.
- `card`: look up `card_templates` by `output.card_name`, then insert `card_instances`.
- `consumable`: no extra instance table in first version.

- [ ] **Step 5: Add crafting routes**

Create `backend/src/routes/crafting.ts`:

```ts
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { craftItem, getAllCraftingRecipes } from '../services/craftingService';

const router = Router();

router.get('/recipes', async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const recipes = await getAllCraftingRecipes(category);
  res.json({ success: true, data: recipes });
});

router.post('/craft', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const { recipeName, quantity = 1 } = req.body;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!recipeName) {
      res.status(400).json({ error: 'recipeName is required' });
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      res.status(400).json({ error: 'quantity must be a positive integer' });
      return;
    }

    const result = await craftItem(userId, recipeName, quantity);
    if (!result) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to craft item';
    if (message === '制造配方不存在') {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }
    if (message.startsWith('库存不足') || message.startsWith('仓储空间不足')) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: 'Failed to craft item' });
  }
});

export default router;
```

Mount in `backend/src/index.ts`:

```ts
import craftingRoutes from './routes/crafting';
app.use('/api/crafting', craftingRoutes);
```

- [ ] **Step 6: Add crafting integration tests**

Create `backend/src/routes/crafting.integration.test.ts` with these cases:

```ts
import request from 'supertest';
import express from 'express';
import craftingRoutes from '../routes/crafting';
import * as craftingService from '../services/craftingService';

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', username: 'testuser' };
    next();
  },
  AuthRequest: {} as any,
}));

jest.mock('../services/craftingService');

const app = express();
app.use(express.json());
app.use('/api/crafting', craftingRoutes);

const mockedGetAllCraftingRecipes = craftingService.getAllCraftingRecipes as jest.MockedFunction<typeof craftingService.getAllCraftingRecipes>;
const mockedCraftItem = craftingService.craftItem as jest.MockedFunction<typeof craftingService.craftItem>;

describe('Crafting API Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all crafting recipes', async () => {
    mockedGetAllCraftingRecipes.mockResolvedValueOnce([
      { id: 'r1', name: '矿镐', category: 'gear', input: { iron_ingot: 5 }, output: { item_type: 'gear', item_key: 'pickaxe', quantity: 1 }, profession_required: null },
    ] as any);

    const response = await request(app).get('/api/crafting/recipes');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data[0].name).toBe('矿镐');
  });

  it('passes category filter to recipe service', async () => {
    mockedGetAllCraftingRecipes.mockResolvedValueOnce([]);

    await request(app).get('/api/crafting/recipes?category=gear');

    expect(mockedGetAllCraftingRecipes).toHaveBeenCalledWith('gear');
  });

  it('validates recipeName', async () => {
    const response = await request(app).post('/api/crafting/craft').send({ quantity: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('recipeName is required');
  });

  it('validates positive integer quantity', async () => {
    const response = await request(app).post('/api/crafting/craft').send({ recipeName: '矿镐', quantity: 1.5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('quantity must be a positive integer');
  });

  it('returns crafted item payload', async () => {
    mockedCraftItem.mockResolvedValueOnce({
      recipeName: '矿镐',
      category: 'gear',
      quantity: 1,
      consumed: { iron_ingot: 5, plank: 2 },
      produced: { gear: { pickaxe: 1 } },
    } as any);

    const response = await request(app).post('/api/crafting/craft').send({ recipeName: '矿镐', quantity: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.produced.gear.pickaxe).toBe(1);
  });

  it('maps inventory shortage to 400', async () => {
    mockedCraftItem.mockRejectedValueOnce(new Error('库存不足: iron_ingot'));

    const response = await request(app).post('/api/crafting/craft').send({ recipeName: '矿镐', quantity: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('库存不足: iron_ingot');
  });
});
```

- [ ] **Step 7: Run focused crafting tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- craftingService.test.ts crafting.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/migrations/001_initial_schema.sql backend/src/services/craftingService.ts backend/src/services/craftingService.test.ts backend/src/routes/crafting.ts backend/src/routes/crafting.integration.test.ts backend/src/index.ts
git commit -m "feat: add idle crafting system"
```

---

## Task 4: Production Gear Bonuses And Deterministic Gathering

**Files:**
- Create: `backend/src/services/gearService.ts`
- Create: `backend/src/services/gearService.test.ts`
- Modify: `backend/src/services/gatheringService.ts`
- Modify: `backend/src/services/gatheringService.test.ts`
- Modify: `backend/src/routes/gathering.integration.test.ts`

**Interfaces:**
- Produces:
  - `ProductionBonusMap = Partial<Record<SkillType, number>>`
  - `getProductionBonuses(playerId: string, client?: DbClient): Promise<ProductionBonusMap>`
  - `calculateGatheringYield(task, config, bonuses): { earned: Record<string, number> }`
- Consumes:
  - `storeWithCapacity(playerId, 'resource', earned, warehouseLimits, 'partial', client)`

- [ ] **Step 1: Write gear service tests**

Create `backend/src/services/gearService.test.ts`:

```ts
import { getProductionBonuses } from './gearService';
import { query } from '../config/database';

jest.mock('../config/database', () => ({ query: jest.fn() }));

it('returns highest bonus per skill type', async () => {
  (query as jest.Mock).mockResolvedValueOnce([
    { skill_type: 'mining', bonus_rate: '0.20' },
    { skill_type: 'mining', bonus_rate: '0.50' },
    { skill_type: 'woodcutting', bonus_rate: '0.30' },
  ]);

  await expect(getProductionBonuses('player-1')).resolves.toEqual({
    mining: 0.5,
    woodcutting: 0.3,
  });
});
```

- [ ] **Step 2: Implement gear service**

Create `backend/src/services/gearService.ts`:

```ts
import { DbClient, query } from '../config/database';
import { SkillType } from './gatheringService';

export type ProductionBonusMap = Partial<Record<SkillType, number>>;

async function runQuery<T = any>(text: string, params?: any[], client?: DbClient): Promise<T[]> {
  if (client) {
    const result = await client.query(text, params);
    return result.rows;
  }
  return query<T>(text, params);
}

export async function getProductionBonuses(playerId: string, client?: DbClient): Promise<ProductionBonusMap> {
  const rows = await runQuery<{ skill_type: SkillType; bonus_rate: number | string }>(
    `SELECT skill_type, MAX(bonus_rate) AS bonus_rate
     FROM gear_instances
     WHERE player_id = $1 AND skill_type IS NOT NULL
     GROUP BY skill_type`,
    [playerId],
    client
  );

  return rows.reduce<ProductionBonusMap>((bonuses, row) => {
    bonuses[row.skill_type] = Number(row.bonus_rate);
    return bonuses;
  }, {});
}
```

- [ ] **Step 3: Write deterministic gathering tests**

In `backend/src/services/gatheringService.test.ts`, add tests that prove:

```ts
it('completes a due gathering task with deterministic byproduct and gear bonus', async () => {
  const startedAt = new Date(Date.now() - 10 * 60 * 1000);
  const endsAt = new Date(Date.now() - 1000);
  mockTransactionClient.query
    .mockResolvedValueOnce({ rows: [{ id: 'player-1', warehouse_limits: { resource: 1000 } }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [idleTaskRow({ started_at: startedAt, ends_at: endsAt })], rowCount: 1 });

  const result = await gatheringService.completeGathering('user-123');

  expect(result?.result?.resources).toEqual({ iron_ore: 10, coal: 1 });
});
```

Then extend the mock setup for `gearService.getProductionBonuses` and `capacityService.storeWithCapacity` so the test asserts:

```ts
expect(storeWithCapacity).toHaveBeenCalledWith('player-1', 'resource', { iron_ore: 15, coal: 2 }, { resource: 1000 }, 'partial', mockTransactionClient);
```

- [ ] **Step 4: Run gathering tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- gearService.test.ts gatheringService.test.ts --runInBand
```

Expected: FAIL until `gatheringService` stops using `Math.random()` and starts using gear/capacity services.

- [ ] **Step 5: Refactor gathering yield**

In `backend/src/services/gatheringService.ts`:

- Export `calculateGatheringYield`.
- Remove the private `productionGear` object lookup.
- Use `getProductionBonuses(player.id, client)` in `completeGathering`.
- Replace `Math.random()` with deterministic expected byproduct.
- Replace manual capacity loop with `storeWithCapacity`.

Yield helper signature:

```ts
export function calculateGatheringYield(
  skillType: SkillType,
  durationSeconds: number,
  config: Record<SkillType, {
    primaryResource: string;
    baseRate: number;
    byproduct: string;
    byproductChance: number;
  }>,
  bonuses: Partial<Record<SkillType, number>> = {}
): Record<string, number> {
  const skill = config[skillType];
  const durationMinutes = durationSeconds / 60;
  const multiplier = 1 + (bonuses[skillType] || 0);
  const primaryQuantity = Math.floor(skill.baseRate * durationMinutes * multiplier);
  const result: Record<string, number> = {};
  if (primaryQuantity > 0) {
    result[skill.primaryResource] = primaryQuantity;
  }
  if (skill.byproduct && skill.byproductChance > 0 && primaryQuantity > 0) {
    const byproductQuantity = Math.floor(primaryQuantity * skill.byproductChance * 0.5);
    if (byproductQuantity > 0) {
      result[skill.byproduct] = byproductQuantity;
    }
  }
  return result;
}
```

- [ ] **Step 6: Run focused gathering tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- gearService.test.ts gatheringService.test.ts gathering.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/gearService.ts backend/src/services/gearService.test.ts backend/src/services/gatheringService.ts backend/src/services/gatheringService.test.ts backend/src/routes/gathering.integration.test.ts
git commit -m "feat: apply production gear to gathering"
```

---

## Task 5: Offline Settlement Reuses Gathering Rules

**Files:**
- Modify: `backend/src/services/offlineService.ts`
- Modify: `backend/src/services/offlineService.test.ts`
- Modify: `backend/src/routes/player.integration.test.ts`

**Interfaces:**
- Consumes:
  - `calculateGatheringYield(skillType, durationSeconds, config, bonuses)`
  - `getProductionBonuses(playerId, client)`
  - `storeWithCapacity(playerId, 'resource', earned, warehouseLimits, 'partial', client)`
- Produces: unchanged `claimOfflineIdleRewards(userId, now?)`

- [ ] **Step 1: Write offline deterministic tests**

In `backend/src/services/offlineService.test.ts`, add:

```ts
it('settles due idle tasks using deterministic gathering yield and gear bonuses', async () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  const startedAt = new Date('2026-08-21T11:50:00.000Z');
  const endsAt = new Date('2026-08-21T12:00:00.000Z');
  const client = { query: jest.fn() };
  mockedWithTransaction.mockImplementationOnce(async callback => callback(client as any));
  client.query
    .mockResolvedValueOnce({ rows: [{ id: 'player-1', warehouse_limits: { resource: 1000 }, last_offline: startedAt }] })
    .mockResolvedValueOnce({ rows: [{ id: 'task-1', skill_type: 'mining', started_at: startedAt, ends_at: endsAt }] })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });

  const result = await claimOfflineIdleRewards('user-1', now);

  expect(storeWithCapacity).toHaveBeenCalledWith('player-1', 'resource', { iron_ore: 10, coal: 1 }, { resource: 1000 }, 'partial', client);
  expect(result?.earned).toEqual({ iron_ore: 10, coal: 1 });
});
```

- [ ] **Step 2: Run offline tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- offlineService.test.ts --runInBand
```

Expected: FAIL while `offlineService` still has direct `Math.random()` and manual capacity logic.

- [ ] **Step 3: Refactor offline settlement**

In `backend/src/services/offlineService.ts`:

- Keep `MAX_OFFLINE_MINUTES` export.
- Stop using `RESOURCE_RATES` for task settlement.
- Fetch gathering config once.
- Fetch production bonuses once per player.
- For each due task, call `calculateGatheringYield`.
- For each due task, call `storeWithCapacity` in partial mode.
- Aggregate `earned`, `stored`, and `overflowed` from returned values.
- Update `idle_tasks.result` with stored and overflowed per task.
- Update `players.last_offline` as it does now.

- [ ] **Step 4: Run focused offline tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- offlineService.test.ts player.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/offlineService.ts backend/src/services/offlineService.test.ts backend/src/routes/player.integration.test.ts
git commit -m "feat: reuse gathering rules for offline settlement"
```

---

## Task 6: Warehouse Payload Includes Capacity And Bonuses

**Files:**
- Modify: `backend/src/services/warehouseService.ts`
- Modify: `backend/src/services/warehouseService.test.ts`
- Modify: `backend/src/routes/warehouse.ts`

**Interfaces:**
- Consumes:
  - `getInventorySummary(playerId)`
  - `getCapacitySummary(playerId, warehouseLimits)`
  - `getProductionBonuses(playerId)`
- Produces:
  - `WarehouseData { inventory: InventorySummary; resources; materials; production_gear; storageLimits; capacity: CapacitySummary; activeBonuses: ProductionBonusMap }`

- [ ] **Step 1: Update warehouse service tests**

In `backend/src/services/warehouseService.test.ts`, assert the enhanced result:

```ts
expect(result?.capacity.resource).toEqual({ used: 180, limit: 1000, remaining: 820 });
expect(result?.activeBonuses).toEqual({ mining: 0.5 });
expect(result?.inventory.resource).toEqual({ iron_ore: 100, coal: 50, wood: 30 });
```

Mock:

```ts
jest.mock('./capacityService', () => ({
  getCapacitySummary: jest.fn().mockResolvedValue({
    resource: { used: 180, limit: 1000, remaining: 820 },
    material: { used: 15, limit: 500, remaining: 485 },
    gear: { used: 1, limit: 50, remaining: 49 },
    certification: { used: 0, limit: 10, remaining: 10 },
    card: { used: 0, limit: 200, remaining: 200 },
    consumable: { used: 0, limit: 100, remaining: 100 },
  }),
}));

jest.mock('./gearService', () => ({
  getProductionBonuses: jest.fn().mockResolvedValue({ mining: 0.5 }),
}));
```

- [ ] **Step 2: Run warehouse tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- warehouseService.test.ts --runInBand
```

Expected: FAIL because the current return type has no `capacity`, `inventory`, or `activeBonuses`.

- [ ] **Step 3: Implement enhanced warehouse service**

Update `WarehouseData`:

```ts
export interface WarehouseData {
  inventory: InventorySummary;
  resources: Record<string, number>;
  materials: Record<string, number>;
  production_gear: Record<string, any>;
  storageLimits: Record<string, number>;
  capacity: CapacitySummary;
  activeBonuses: ProductionBonusMap;
}
```

Inside `getWarehouseData`:

```ts
const inventory = await getInventorySummary(player.id);
const capacity = await getCapacitySummary(player.id, player.warehouse_limits || {});
const activeBonuses = await getProductionBonuses(player.id);
```

- [ ] **Step 4: Update warehouse route response**

Return both legacy and new fields:

```ts
res.json({
  success: true,
  data: {
    inventory: warehouse.inventory,
    resources: warehouse.resources,
    materials: warehouse.materials,
    production_gear: warehouse.production_gear,
    storageLimits: warehouse.storageLimits,
    capacity: warehouse.capacity,
    activeBonuses: warehouse.activeBonuses,
  },
});
```

- [ ] **Step 5: Run focused warehouse tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- warehouseService.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/warehouseService.ts backend/src/services/warehouseService.test.ts backend/src/routes/warehouse.ts
git commit -m "feat: expose warehouse capacity summary"
```

---

## Task 7: Idle Rules And Simulation API

**Files:**
- Create: `backend/src/services/idleSimulationService.ts`
- Create: `backend/src/services/idleSimulationService.test.ts`
- Create: `backend/src/routes/idle.ts`
- Create: `backend/src/routes/idle.integration.test.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**
- Consumes:
  - `getAllGatheringSkills()`
  - `getAllProcessingRecipes()`
  - `getAllCraftingRecipes()`
  - `getWarehouseData(userId)`
  - `getProductionBonuses(playerId)`
- Produces:
  - `getIdleRules(): Promise<IdleRules>`
  - `simulateIdleGoal(userId: string, request: IdleSimulationRequest): Promise<IdleSimulationResult | null>`

- [ ] **Step 1: Write simulation service tests**

Create `backend/src/services/idleSimulationService.test.ts`:

```ts
import { simulateIdleGoal } from './idleSimulationService';
import { getWarehouseData } from './warehouseService';
import { getAllCraftingRecipes } from './craftingService';

jest.mock('./warehouseService', () => ({ getWarehouseData: jest.fn() }));
jest.mock('./craftingService', () => ({ getAllCraftingRecipes: jest.fn() }));

it('reports craftable target when materials are already available', async () => {
  (getWarehouseData as jest.Mock).mockResolvedValueOnce({
    id: 'player-1',
    inventory: { resource: {}, material: { iron_ingot: 5, plank: 2 }, gear: {}, certification: {}, card: {}, consumable: {} },
    capacity: {},
    activeBonuses: {},
  });
  (getAllCraftingRecipes as jest.Mock).mockResolvedValueOnce([
    { name: '矿镐', category: 'gear', input: { iron_ingot: 5, plank: 2 }, output: { item_type: 'gear', item_key: 'pickaxe', quantity: 1 } },
  ]);

  const result = await simulateIdleGoal('user-1', { goal: { type: 'craft', recipeName: '矿镐', quantity: 1 }, horizonMinutes: 60 });

  expect(result?.goal.craftableNow).toBe(true);
  expect(result?.missing).toEqual({});
  expect(result?.recommendedActions[0].action).toBe('craft');
});

it('reports missing processed and raw materials for a target recipe', async () => {
  (getWarehouseData as jest.Mock).mockResolvedValueOnce({
    id: 'player-1',
    inventory: { resource: {}, material: { iron_ingot: 1 }, gear: {}, certification: {}, card: {}, consumable: {} },
    capacity: {},
    activeBonuses: {},
  });
  (getAllCraftingRecipes as jest.Mock).mockResolvedValueOnce([
    { name: '矿镐', category: 'gear', input: { iron_ingot: 5, plank: 2 }, output: { item_type: 'gear', item_key: 'pickaxe', quantity: 1 } },
  ]);

  const result = await simulateIdleGoal('user-1', { goal: { type: 'craft', recipeName: '矿镐', quantity: 1 }, horizonMinutes: 60 });

  expect(result?.missing).toEqual({ iron_ingot: 4, plank: 2 });
  expect(result?.recommendedActions.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run simulation tests and confirm failure**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- idleSimulationService.test.ts --runInBand
```

Expected: FAIL because `idleSimulationService.ts` does not exist.

- [ ] **Step 3: Implement simulation service**

Create these exported types:

```ts
export interface IdleSimulationRequest {
  goal: {
    type: 'craft';
    recipeName: string;
    quantity: number;
  };
  horizonMinutes: number;
}

export interface IdleRecommendation {
  action: 'craft' | 'process' | 'gather' | 'expand_storage';
  skillType?: string;
  recipeType?: string;
  recipeName?: string;
  minutes?: number;
  reason: string;
}

export interface IdleSimulationResult {
  goal: {
    recipeName: string;
    quantity: number;
    craftableNow: boolean;
  };
  missing: Record<string, number>;
  rawMaterialGap: Record<string, number>;
  recommendedActions: IdleRecommendation[];
  capacityWarnings: string[];
}
```

Implement deterministic first-version behavior:

- Find target crafting recipe by exact `recipeName`.
- Compare required material input with `warehouse.inventory.material`.
- If no missing materials, return one `craft` recommendation.
- Convert missing `iron_ingot`, `plank`, and `herb_powder` back to raw resources with the known processing recipes.
- Recommend mining, woodcutting, or herbalism by raw gaps.
- If capacity remaining is zero for `resource` or `material`, recommend `expand_storage`.

- [ ] **Step 4: Add idle routes**

Create `backend/src/routes/idle.ts`:

```ts
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getIdleRules, simulateIdleGoal } from '../services/idleSimulationService';

const router = Router();

router.get('/rules', async (_req, res) => {
  const rules = await getIdleRules();
  res.json({ success: true, data: rules });
});

router.post('/simulate', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await simulateIdleGoal(userId, req.body);
  if (!result) {
    res.status(404).json({ error: 'Player not found' });
    return;
  }
  res.json({ success: true, data: result });
});

export default router;
```

Mount in `backend/src/index.ts`:

```ts
import idleRoutes from './routes/idle';
app.use('/api/idle', idleRoutes);
```

- [ ] **Step 5: Write idle route integration tests**

Create `backend/src/routes/idle.integration.test.ts`:

```ts
import request from 'supertest';
import express from 'express';
import idleRoutes from '../routes/idle';
import * as idleSimulationService from '../services/idleSimulationService';

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', username: 'testuser' };
    next();
  },
  AuthRequest: {} as any,
}));

jest.mock('../services/idleSimulationService');

const app = express();
app.use(express.json());
app.use('/api/idle', idleRoutes);

describe('Idle API Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns idle rules', async () => {
    (idleSimulationService.getIdleRules as jest.Mock).mockResolvedValueOnce({
      gathering: [],
      processing: [],
      crafting: [],
      warehouseDefaults: { resource: 1000 },
    });

    const response = await request(app).get('/api/idle/rules');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.warehouseDefaults.resource).toBe(1000);
  });

  it('returns simulation result for authenticated user', async () => {
    (idleSimulationService.simulateIdleGoal as jest.Mock).mockResolvedValueOnce({
      goal: { recipeName: '矿镐', quantity: 1, craftableNow: false },
      missing: { iron_ingot: 4 },
      rawMaterialGap: { iron_ore: 8, coal: 4 },
      recommendedActions: [{ action: 'gather', skillType: 'mining', minutes: 12, reason: '需要铁矿石和煤炭来冶炼铁锭' }],
      capacityWarnings: [],
    });

    const response = await request(app).post('/api/idle/simulate').send({ goal: { type: 'craft', recipeName: '矿镐', quantity: 1 }, horizonMinutes: 60 });

    expect(response.status).toBe(200);
    expect(response.body.data.missing.iron_ingot).toBe(4);
  });

  it('maps missing player to 404', async () => {
    (idleSimulationService.simulateIdleGoal as jest.Mock).mockResolvedValueOnce(null);

    const response = await request(app).post('/api/idle/simulate').send({ goal: { type: 'craft', recipeName: '矿镐', quantity: 1 }, horizonMinutes: 60 });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Player not found');
  });
});
```

- [ ] **Step 6: Run focused simulation tests**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- idleSimulationService.test.ts idle.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/idleSimulationService.ts backend/src/services/idleSimulationService.test.ts backend/src/routes/idle.ts backend/src/routes/idle.integration.test.ts backend/src/index.ts
git commit -m "feat: add idle rules simulation api"
```

---

## Task 8: Full Backend Loop Verification And Docs

**Files:**
- Modify: `backend/src/routes/e2e.test.ts`
- Modify: `memory-bank/architecture.md`
- Modify: `memory-bank/progress.md`
- Modify: `docs/todo.md`

**Interfaces:**
- Consumes all public services and routes from Tasks 1 through 7.
- Produces a verified end-to-end idle loop and updated project docs.

- [ ] **Step 1: Add full loop e2e test**

Extend `backend/src/routes/e2e.test.ts` by importing and mounting the new routes:

```ts
import processingRoutes from '../routes/processing';
import craftingRoutes from '../routes/crafting';
import gatheringRoutes from '../routes/gathering';
import warehouseRoutes from '../routes/warehouse';

app.use('/api/processing', processingRoutes);
app.use('/api/crafting', craftingRoutes);
app.use('/api/gathering', gatheringRoutes);
app.use('/api/warehouse', warehouseRoutes);
```

Mock the new route-facing services near the existing mocks:

```ts
jest.mock('../services/processingService');
jest.mock('../services/craftingService');
jest.mock('../services/gatheringService');
jest.mock('../services/warehouseService');
```

Add this concrete e2e test:

```ts
it('completes the idle incremental loop from processing to gear-assisted gathering', async () => {
  const processingService = require('../services/processingService');
  const craftingService = require('../services/craftingService');
  const gatheringService = require('../services/gatheringService');
  const warehouseService = require('../services/warehouseService');

  processingService.processMaterials.mockResolvedValueOnce({
    recipe: '冶炼',
    type: 'smelting',
    quantity: 5,
    input: { iron_ore: 10, coal: 5 },
    output: { iron_ingot: 5 },
    stored: { iron_ingot: 5 },
    overflowed: {},
  });
  processingService.processMaterials.mockResolvedValueOnce({
    recipe: '木工',
    type: 'carpentry',
    quantity: 2,
    input: { wood: 4 },
    output: { plank: 2 },
    stored: { plank: 2 },
    overflowed: {},
  });
  craftingService.craftItem.mockResolvedValueOnce({
    recipeName: '矿镐',
    category: 'gear',
    quantity: 1,
    consumed: { iron_ingot: 5, plank: 2 },
    produced: { gear: { pickaxe: 1 } },
  });
  gatheringService.completeGathering.mockResolvedValueOnce({
    id: 'task-1',
    skillType: 'mining',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    duration: 60,
    status: 'completed',
    result: { resources: { iron_ore: 1 }, overflowed: {} },
  });
  warehouseService.getWarehouseData.mockResolvedValueOnce({
    inventory: {
      resource: { iron_ore: 1 },
      material: {},
      gear: { pickaxe: 1 },
      certification: {},
      card: {},
      consumable: {},
    },
    resources: { iron_ore: 1 },
    materials: {},
    production_gear: { pickaxe: 1 },
    storageLimits: { resource: 1000, material: 500, gear: 50, certification: 10, card: 200, consumable: 100 },
    capacity: {
      resource: { used: 1, limit: 1000, remaining: 999 },
      material: { used: 0, limit: 500, remaining: 500 },
      gear: { used: 1, limit: 50, remaining: 49 },
      certification: { used: 0, limit: 10, remaining: 10 },
      card: { used: 0, limit: 200, remaining: 200 },
      consumable: { used: 0, limit: 100, remaining: 100 },
    },
    activeBonuses: { mining: 0.5 },
  });

  const smelt = await request(app).post('/api/processing/process').send({ recipeType: 'smelting', quantity: 5 });
  const carpentry = await request(app).post('/api/processing/process').send({ recipeType: 'carpentry', quantity: 2 });
  const craft = await request(app).post('/api/crafting/craft').send({ recipeName: '矿镐', quantity: 1 });
  const complete = await request(app).post('/api/gathering/complete');
  const warehouse = await request(app).get('/api/warehouse');

  expect(smelt.status).toBe(200);
  expect(carpentry.status).toBe(200);
  expect(craft.body.data.produced.gear.pickaxe).toBe(1);
  expect(complete.body.data.result.resources.iron_ore).toBe(1);
  expect(warehouse.body.data.activeBonuses.mining).toBe(0.5);
  expect(warehouse.body.data.capacity.gear.remaining).toBe(49);
});
```

Use the current e2e style in this repository: mocked service calls through Express route tests. Assert the public route payloads rather than setting up a real PostgreSQL database.

- [ ] **Step 2: Run the complete test suite**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- --runInBand
```

Expected: PASS for all suites.

- [ ] **Step 3: Run TypeScript build**

Run:

```bash
cd /Users/bytedance/PtIDLE/backend && npm run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Update architecture notes**

In `memory-bank/architecture.md`, add a section `## 挂机增量系统 v0.1`:

```md
## 挂机增量系统 v0.1

挂机系统现在以 `inventory_items` 为唯一库存来源，`capacityService` 统一处理容量摘要、部分入库和严格入库。`processingService` 负责资源到材料的转化，`craftingService` 负责材料到生产装备、职业认证、卡牌、消耗品和仓储扩容的制造。`gearService` 按技能类型计算生产装备最高加成，采集和离线结算共享同一套确定性收益公式。`idleSimulationService` 提供规则查询和目标模拟，供后续前端工坊界面直接使用。
```

- [ ] **Step 5: Update progress and task docs**

In `memory-bank/progress.md`, append completed rows for:

```md
| T019 | 统一仓储上限管理 | 2026-08-21 |
| T020 | 制造配方规则与查询 | 2026-08-21 |
| T021 | 统一制造 API 与卡牌制造 | 2026-08-21 |
| T022 | 生产装备制造与实例化 | 2026-08-21 |
| T023 | 战术消耗品制造 | 2026-08-21 |
| T024 | 生产装备采集效率加成 | 2026-08-21 |
| T025 | 规则模拟与统一离线结算 | 2026-08-21 |
```

In `docs/todo.md`, mark the same task range as complete if it still uses checklist status.

- [ ] **Step 6: Check staged diff**

Run:

```bash
cd /Users/bytedance/PtIDLE && git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/e2e.test.ts memory-bank/architecture.md memory-bank/progress.md docs/todo.md
git commit -m "test: verify idle incremental loop"
```

---

## Final Verification

Run after all tasks:

```bash
cd /Users/bytedance/PtIDLE/backend && npm test -- --runInBand
cd /Users/bytedance/PtIDLE/backend && npm run build
cd /Users/bytedance/PtIDLE && git status --short
```

Expected:

- All Jest suites pass.
- TypeScript build passes.
- Only pre-existing unrelated dependency changes remain if they were present before execution.

---

## Review Checkpoints

Review after each task before moving to the next one:

1. Confirm no service bypasses `inventory_items` for mutable resource, material, gear, card, certification, or consumable state.
2. Confirm no idle growth changes battle base stats.
3. Confirm gathering and offline settlement call the same yield calculation.
4. Confirm manufacturing failures do not deduct materials.
5. Confirm tests cover the behavior introduced in the task.
