-- PtIDLE 数据库初始化脚本
-- 版本: 001
-- 日期: 2026-06-12
-- 说明: 未上线项目采用破坏式初始 schema 重建，统一库存、挂机任务、职业认证和卡牌实例域模型。

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 未上线项目：破坏式重建初始 schema，避免旧 JSONB 结构残留
DROP TABLE IF EXISTS battles CASCADE;
DROP TABLE IF EXISTS character_deck CASCADE;
DROP TABLE IF EXISTS profession_certifications CASCADE;
DROP TABLE IF EXISTS gear_instances CASCADE;
DROP TABLE IF EXISTS card_instances CASCADE;
DROP TABLE IF EXISTS player_cards CASCADE;
DROP TABLE IF EXISTS card_templates CASCADE;
DROP TABLE IF EXISTS idle_tasks CASCADE;
DROP TABLE IF EXISTS characters CASCADE;
DROP TABLE IF EXISTS crafting_recipes CASCADE;
DROP TABLE IF EXISTS processing_recipes CASCADE;
DROP TABLE IF EXISTS gathering_skills CASCADE;
DROP TABLE IF EXISTS inventory_items CASCADE;
DROP TABLE IF EXISTS professions CASCADE;
DROP TABLE IF EXISTS players CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ========================================
-- 用户表
-- ========================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- ========================================
-- 玩家表：仅保留玩家主体信息和仓储配置
-- ========================================
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    warehouse_limits JSONB DEFAULT '{"resource": 1000, "material": 500, "gear": 50, "certification": 10, "card": 200, "consumable": 100}',
    last_offline TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 统一库存表：资源、材料、装备、职业认证、卡牌、消耗品的唯一库存入口
-- ========================================
CREATE TABLE IF NOT EXISTS inventory_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('resource', 'material', 'gear', 'certification', 'card', 'consumable')),
    item_key VARCHAR(80) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, item_type, item_key, metadata)
);

-- ========================================
-- 职业属性表
-- ========================================
CREATE TABLE IF NOT EXISTS professions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(20) UNIQUE NOT NULL CHECK (name IN ('warrior', 'ranger', 'mage')),
    base_health INTEGER NOT NULL,
    base_movement INTEGER NOT NULL,
    base_energy INTEGER NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 棋子表：注册时为白板棋子，职业由认证装置绑定后写入快照
-- ========================================
CREATE TABLE IF NOT EXISTS characters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    profession VARCHAR(20) CHECK (profession IN ('warrior', 'ranger', 'mage')),
    certification_id UUID,
    health INTEGER DEFAULT 10,
    max_health INTEGER DEFAULT 10,
    movement INTEGER DEFAULT 2,
    energy INTEGER DEFAULT 3,
    max_energy INTEGER DEFAULT 3,
    position_x INTEGER,
    position_y INTEGER,
    is_alive BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 独立挂机任务表：替代 players.idle_queue
-- ========================================
CREATE TABLE IF NOT EXISTS idle_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    skill_type VARCHAR(20) NOT NULL CHECK (skill_type IN ('mining', 'woodcutting', 'herbalism')),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'claimed', 'cancelled')),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    claimed_at TIMESTAMP WITH TIME ZONE,
    result JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 卡牌定义表（模板）
-- ========================================
CREATE TABLE IF NOT EXISTS card_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('attack', 'defense', 'tactical')),
    cost INTEGER NOT NULL DEFAULT 1,
    effect JSONB NOT NULL DEFAULT '{}',
    profession VARCHAR(20) CHECK (profession IN ('warrior', 'ranger', 'mage', 'common')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 玩家卡牌实例表：替代 player_cards
-- ========================================
CREATE TABLE IF NOT EXISTS card_instances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    card_template_id UUID REFERENCES card_templates(id),
    inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('attack', 'defense', 'tactical')),
    cost INTEGER NOT NULL,
    effect JSONB NOT NULL DEFAULT '{}',
    profession VARCHAR(20) CHECK (profession IN ('warrior', 'ranger', 'mage', 'common')),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 棋子卡牌分配表：引用 card_instances
-- ========================================
CREATE TABLE IF NOT EXISTS character_deck (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    card_instance_id UUID NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(character_id, card_instance_id)
);

-- ========================================
-- 生产装备实例表
-- ========================================
CREATE TABLE IF NOT EXISTS gear_instances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    gear_key VARCHAR(80) NOT NULL,
    skill_type VARCHAR(20) CHECK (skill_type IN ('mining', 'woodcutting', 'herbalism')),
    bonus_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    durability INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 职业认证装置实例表
-- ========================================
CREATE TABLE IF NOT EXISTS profession_certifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    profession VARCHAR(20) NOT NULL CHECK (profession IN ('warrior', 'ranger', 'mage')),
    bound_character_id UUID REFERENCES characters(id) ON DELETE SET NULL,
    bound_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_characters_certification'
          AND conrelid = 'characters'::regclass
    ) THEN
        ALTER TABLE characters
            ADD CONSTRAINT fk_characters_certification
            FOREIGN KEY (certification_id) REFERENCES profession_certifications(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ========================================
-- 采集技能表
-- ========================================
CREATE TABLE IF NOT EXISTS gathering_skills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) NOT NULL,
    type VARCHAR(20) UNIQUE NOT NULL CHECK (type IN ('mining', 'woodcutting', 'herbalism')),
    yields JSONB NOT NULL DEFAULT '{}',
    base_yield INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 加工配方表
-- ========================================
CREATE TABLE IF NOT EXISTS processing_recipes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) UNIQUE NOT NULL CHECK (type IN ('smelting', 'carpentry', 'grinding')),
    input JSONB NOT NULL DEFAULT '{}',
    output JSONB NOT NULL DEFAULT '{}',
    efficiency DECIMAL(5,2) DEFAULT 1.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 制造配方表：制造输出必须声明统一库存 item_type/item_key/quantity
-- ========================================
CREATE TABLE IF NOT EXISTS crafting_recipes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) UNIQUE NOT NULL,
    category VARCHAR(20) NOT NULL CHECK (category IN ('card', 'gear', 'certification', 'consumable')),
    input JSONB NOT NULL DEFAULT '{}',
    output JSONB NOT NULL DEFAULT '{}',
    profession_required VARCHAR(20) CHECK (profession_required IN ('warrior', 'ranger', 'mage')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================
-- 对战记录表
-- ========================================
CREATE TABLE IF NOT EXISTS battles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player1_id UUID NOT NULL REFERENCES players(id),
    player2_id UUID NOT NULL REFERENCES players(id),
    winner_id UUID REFERENCES players(id),
    duration INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'ongoing', 'finished')),
    battle_data JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP WITH TIME ZONE
);

-- ========================================
-- 索引
-- ========================================
CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_player_type ON inventory_items(player_id, item_type);
CREATE INDEX IF NOT EXISTS idx_inventory_player_key ON inventory_items(player_id, item_type, item_key);
CREATE INDEX IF NOT EXISTS idx_characters_player_id ON characters(player_id);
CREATE INDEX IF NOT EXISTS idx_characters_certification_id ON characters(certification_id);
CREATE INDEX IF NOT EXISTS idx_idle_tasks_player_status ON idle_tasks(player_id, status);
CREATE INDEX IF NOT EXISTS idx_idle_tasks_status_ends_at ON idle_tasks(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_card_instances_player_id ON card_instances(player_id);
CREATE INDEX IF NOT EXISTS idx_card_instances_template_id ON card_instances(card_template_id);
CREATE INDEX IF NOT EXISTS idx_card_instances_inventory_item_id ON card_instances(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_character_deck_character_id ON character_deck(character_id);
CREATE INDEX IF NOT EXISTS idx_gear_instances_player_id ON gear_instances(player_id);
CREATE INDEX IF NOT EXISTS idx_gear_instances_inventory_item_id ON gear_instances(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_profession_certifications_player_id ON profession_certifications(player_id);
CREATE INDEX IF NOT EXISTS idx_profession_certifications_inventory_item_id ON profession_certifications(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_profession_certifications_bound_character_id ON profession_certifications(bound_character_id);
CREATE INDEX IF NOT EXISTS idx_battles_player1_id ON battles(player1_id);
CREATE INDEX IF NOT EXISTS idx_battles_player2_id ON battles(player2_id);

-- ========================================
-- 初始化数据
-- ========================================

-- 插入职业数据
INSERT INTO professions (name, base_health, base_movement, base_energy, description) VALUES
    ('warrior', 20, 2, 3, '战士 - 高血量，近战坦克'),
    ('ranger', 15, 3, 3, '弓手 - 中等血量，远程单体'),
    ('mage', 12, 2, 3, '法师 - 低血量，远程AOE')
ON CONFLICT (name) DO NOTHING;

-- 插入采集技能
INSERT INTO gathering_skills (name, type, yields, base_yield) VALUES
    ('采矿', 'mining', '{"iron_ore": 1, "coal": 0.3}', 1),
    ('伐木', 'woodcutting', '{"wood": 1, "sap": 0.2}', 1),
    ('草药学', 'herbalism', '{"herb": 1, "mushroom": 0.3}', 1)
ON CONFLICT (type) DO NOTHING;

-- 插入加工配方
INSERT INTO processing_recipes (name, type, input, output, efficiency) VALUES
    ('冶炼', 'smelting', '{"iron_ore": 2, "coal": 1}', '{"iron_ingot": 1}', 1.0),
    ('木工', 'carpentry', '{"wood": 2}', '{"plank": 1}', 1.0),
    ('研磨', 'grinding', '{"herb": 2}', '{"herb_powder": 1}', 1.0)
ON CONFLICT (type) DO NOTHING;

-- 插入基础卡牌模板
INSERT INTO card_templates (name, description, type, cost, effect, profession) VALUES
    ('轻击', '造成2点伤害', 'attack', 1, '{"damage": 2}', 'common'),
    ('移动', '移动1格', 'tactical', 0, '{"movement": 1}', 'common'),
    ('重击', '造成4点伤害', 'attack', 2, '{"damage": 4}', 'warrior'),
    ('精准射击', '造成3点伤害', 'attack', 1, '{"damage": 3, "range": 3}', 'ranger'),
    ('火球术', '造成3点AOE伤害', 'attack', 2, '{"damage": 3, "aoe": true}', 'mage'),
    ('防御', '获得3点护盾', 'defense', 1, '{"shield": 3}', 'common'),
    ('治疗', '恢复3点生命', 'tactical', 1, '{"heal": 3}', 'common')
ON CONFLICT (name) DO NOTHING;

-- 插入制造配方，output 统一使用 item_type/item_key/quantity 标准字段
INSERT INTO crafting_recipes (name, category, input, output, profession_required) VALUES
    ('战士认证装置', 'certification', '{"iron_ingot": 2}', '{"item_type":"certification","item_key":"warrior_certification","profession":"warrior","quantity":1}', NULL),
    ('弓手认证装置', 'certification', '{"plank": 2}', '{"item_type":"certification","item_key":"ranger_certification","profession":"ranger","quantity":1}', NULL),
    ('法师认证装置', 'certification', '{"herb_powder": 2}', '{"item_type":"certification","item_key":"mage_certification","profession":"mage","quantity":1}', NULL),
    ('基础移动卡', 'card', '{"iron_ingot": 1}', '{"item_type":"card","item_key":"move","card_name":"移动","quantity":1}', NULL),
    ('基础轻击卡', 'card', '{"iron_ingot": 2}', '{"item_type":"card","item_key":"light_attack","card_name":"轻击","quantity":1}', NULL),
    ('战士重击卡', 'card', '{"iron_ingot": 3}', '{"item_type":"card","item_key":"heavy_attack","card_name":"重击","quantity":1}', 'warrior'),
    ('弓手精准射击卡', 'card', '{"iron_ingot": 3, "plank": 1}', '{"item_type":"card","item_key":"precise_shot","card_name":"精准射击","quantity":1}', 'ranger'),
    ('法师火球卡', 'card', '{"iron_ingot": 3, "herb_powder": 1}', '{"item_type":"card","item_key":"fireball","card_name":"火球术","quantity":1}', 'mage'),
    ('矿镐', 'gear', '{"iron_ingot": 5, "plank": 2}', '{"item_type":"gear","item_key":"pickaxe","skill_type":"mining","bonus_rate":0.5,"quantity":1}', NULL),
    ('伐木斧', 'gear', '{"iron_ingot": 3, "plank": 3}', '{"item_type":"gear","item_key":"woodcutting_axe","skill_type":"woodcutting","bonus_rate":0.5,"quantity":1}', NULL),
    ('采集手套', 'gear', '{"plank": 5}', '{"item_type":"gear","item_key":"gathering_gloves","skill_type":"herbalism","bonus_rate":0.3,"quantity":1}', NULL),
    ('治疗药剂', 'consumable', '{"herb_powder": 2}', '{"item_type":"consumable","item_key":"healing_potion","quantity":1}', NULL)
ON CONFLICT (name) DO NOTHING;

-- ========================================
-- 注释
-- ========================================
COMMENT ON TABLE users IS '用户账户表';
COMMENT ON TABLE players IS '玩家主体表，仅保存用户关联、仓储配置和离线时间，不再承载资源/材料/装备/挂机队列核心状态';
COMMENT ON TABLE inventory_items IS '统一库存表，保存资源、材料、装备、职业认证、卡牌和消耗品数量及元数据';
COMMENT ON TABLE professions IS '职业属性表，作为职业数值来源';
COMMENT ON TABLE characters IS '棋子表，初始为白板棋子，职业和属性可在绑定职业认证装置时写入快照';
COMMENT ON TABLE idle_tasks IS '挂机任务表，替代 players.idle_queue，在线和离线收益都从真实任务结算';
COMMENT ON TABLE card_templates IS '卡牌模板表';
COMMENT ON TABLE card_instances IS '玩家卡牌实例表，替代 player_cards';
COMMENT ON TABLE character_deck IS '棋子牌库分配表，引用玩家卡牌实例';
COMMENT ON TABLE gear_instances IS '生产装备实例表，关联统一库存中的 gear 物品';
COMMENT ON TABLE profession_certifications IS '职业认证装置实例表，绑定后授予棋子职业';
COMMENT ON TABLE gathering_skills IS '采集技能表';
COMMENT ON TABLE processing_recipes IS '加工配方表，将资源加工为材料';
COMMENT ON TABLE crafting_recipes IS '制造配方表，将材料制造为卡牌、装备、职业认证或消耗品';
COMMENT ON TABLE battles IS '对战记录表';

COMMENT ON COLUMN players.warehouse_limits IS '按 item_type 配置仓储上限';
COMMENT ON COLUMN inventory_items.metadata IS '实例或可堆叠物品扩展信息，例如装备加成、卡牌模板快照、认证职业';
COMMENT ON COLUMN idle_tasks.result IS '任务产出结果快照，用于防止重复计算与支持离线结算';
COMMENT ON COLUMN characters.certification_id IS '当前绑定的职业认证装置实例 ID';
COMMENT ON COLUMN crafting_recipes.output IS '标准制造输出，必须包含 item_type、item_key、quantity，可附带 profession/card_name/skill_type 等元数据';
