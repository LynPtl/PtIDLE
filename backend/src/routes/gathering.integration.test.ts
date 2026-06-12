// Integration tests for gathering API
import request from 'supertest';
import express from 'express';
import gatheringRoutes from '../routes/gathering';
import { query, execute, withTransaction } from '../config/database';
import * as skillService from '../services/skillService';

// Create test app
const app = express();
app.use(express.json());
app.use('/api/gathering', gatheringRoutes);

// Mock the database module
jest.mock('../config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  withTransaction: jest.fn(),
}));

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
  AuthRequest: {} as any
}));

// Mock skillService
jest.mock('../services/skillService', () => ({
  ...jest.requireActual('../services/skillService'),
  getGatheringConfig: jest.fn().mockResolvedValue({
    mining: {
      primaryResource: 'iron_ore',
      baseRate: 1,
      byproduct: 'coal',
      byproductChance: 0.3,
    },
    woodcutting: {
      primaryResource: 'wood',
      baseRate: 1,
      byproduct: 'sap',
      byproductChance: 0.2,
    },
    herbalism: {
      primaryResource: 'herb',
      baseRate: 1,
      byproduct: 'mushroom',
      byproductChance: 0.3,
    },
  }),
  clearSkillsCache: jest.fn(),
}));

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedExecute = execute as jest.MockedFunction<typeof execute>;
const mockedWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
const mockTransactionClient = { query: jest.fn() };

function idleTaskRow(overrides: Partial<any> = {}) {
  const startedAt = overrides.started_at || new Date(Date.now() - 30000);
  const endsAt = overrides.ends_at || new Date(Date.now() + 30000);
  return {
    id: 'task-1',
    player_id: 'player-1',
    character_id: null,
    skill_type: 'mining',
    status: 'active',
    started_at: startedAt,
    ends_at: endsAt,
    claimed_at: null,
    result: {},
    ...overrides,
  };
}

describe('Gathering API Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWithTransaction.mockImplementation(async callback => callback(mockTransactionClient as any));
  });

  describe('POST /api/gathering/start', () => {
    it('should start a new mining gathering task', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [idleTaskRow()], rowCount: 1 });

      const response = await request(app)
        .post('/api/gathering/start')
        .send({ skillType: 'mining' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.skillType).toBe('mining');
      expect(response.body.data.status).toBe('active');
    });

    it('should start a new woodcutting gathering task', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [idleTaskRow({ skill_type: 'woodcutting' })], rowCount: 1 });

      const response = await request(app)
        .post('/api/gathering/start')
        .send({ skillType: 'woodcutting' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.skillType).toBe('woodcutting');
    });

    it('should reject invalid skill type', async () => {
      const response = await request(app)
        .post('/api/gathering/start')
        .send({ skillType: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid skill type');
    });

    it('should reject if already has active task', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [idleTaskRow()], rowCount: 1 });

      const response = await request(app)
        .post('/api/gathering/start')
        .send({ skillType: 'mining' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Already has active gathering task');
    });
  });

  describe('GET /api/gathering/status', () => {
    it('should return active gathering task with progress', async () => {
      mockedQuery.mockResolvedValueOnce([idleTaskRow()]);

      const response = await request(app)
        .get('/api/gathering/status');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.status).toBe('active');
      expect(response.body.data.progress).toBeGreaterThan(0);
    });

    it('should return null when no active task', async () => {
      mockedQuery.mockResolvedValueOnce([]);

      const response = await request(app)
        .get('/api/gathering/status');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeNull();
      expect(response.body.message).toBe('No active gathering task');
    });
  });

  describe('POST /api/gathering/cancel', () => {
    it('should cancel active gathering task', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [idleTaskRow()], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const response = await request(app)
        .post('/api/gathering/cancel');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return error when no active task to cancel', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const response = await request(app)
        .post('/api/gathering/cancel');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No active gathering task to cancel');
    });
  });

  describe('POST /api/gathering/complete', () => {
    it('should return error when task not yet completed', async () => {
      mockTransactionClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'player-1', warehouse_limits: { resource: 1000 } }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [idleTaskRow({ started_at: new Date(), ends_at: new Date(Date.now() + 60000) })], rowCount: 1 });

      const response = await request(app)
        .post('/api/gathering/complete');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not yet completed');
    });
  });
});
