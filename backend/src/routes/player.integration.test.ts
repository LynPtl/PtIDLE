// Integration tests for player API with auth middleware
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import playerRoutes from '../routes/player';
import * as playerService from '../services/playerService';
import * as offlineService from '../services/offlineService';

// Mock the playerService
jest.mock('../services/playerService');
jest.mock('../services/offlineService');

const mockedGetPlayerProfile = playerService.getPlayerProfile as jest.MockedFunction<typeof playerService.getPlayerProfile>;
const mockedClaimOfflineIdleRewards = offlineService.claimOfflineIdleRewards as jest.MockedFunction<typeof offlineService.claimOfflineIdleRewards>;

const app = express();
app.use(express.json());
app.use('/api/player', playerRoutes);

describe('Player API Integration Tests', () => {
  const testUserId = 'test-user-id';
  const testUsername = 'testuser';
  const testPassword = 'password123';
  const jwtSecret = process.env.JWT_SECRET || 'your_jwt_secret_change_in_production';

  // Generate a valid token for testing
  const validToken = jwt.sign({ userId: testUserId, username: testUsername }, jwtSecret);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/player/profile', () => {
    it('should return 401 when no token provided', async () => {
      const response = await request(app)
        .get('/api/player/profile');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('No token provided');
    });

    it('should return 401 when token does not start with Bearer', async () => {
      const response = await request(app)
        .get('/api/player/profile')
        .set('Authorization', validToken);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('No token provided');
    });

    it('should return 401 for invalid token', async () => {
      const response = await request(app)
        .get('/api/player/profile')
        .set('Authorization', 'Bearer invalid_token');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid token');
    });

    it('should return 401 for malformed authorization header', async () => {
      const response = await request(app)
        .get('/api/player/profile')
        .set('Authorization', 'Basic some_token');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('No token provided');
    });

    it('should return 200 and player profile for valid token', async () => {
      const mockProfile = {
        id: 'player-123',
        user_id: testUserId,
        username: testUsername,
        resources: { iron_ore: 10, coal: 5 },
        materials: { iron_ingot: 3 },
        production_gear: {},
        warehouse_limits: { resource: 1000, material: 500 },
        idle_queue: [],
        last_offline: new Date('2026-01-01'),
        characters: [
          {
            id: 'char-1',
            name: '棋子1',
            profession: 'warrior',
            health: 20,
            max_health: 20,
            movement: 2,
            energy: 3,
            max_energy: 3,
            position_x: null,
            position_y: null,
            is_alive: true,
          },
        ],
      };

      mockedGetPlayerProfile.mockResolvedValue(mockProfile);

      const response = await request(app)
        .get('/api/player/profile')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('player-123');
      expect(response.body.username).toBe(testUsername);
      expect(response.body.resources).toEqual({ iron_ore: 10, coal: 5 });
      expect(response.body.characters).toHaveLength(1);
      expect(response.body.characters[0].profession).toBe('warrior');
    });

    it('should return 404 when player not found', async () => {
      mockedGetPlayerProfile.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/player/profile')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Player not found');
    });

    it('should return 401 for expired token', async () => {
      // Generate an expired token (expires in -1 second)
      const expiredToken = jwt.sign(
        { userId: testUserId, username: testUsername },
        jwtSecret,
        { expiresIn: '-1s' }
      );

      const response = await request(app)
        .get('/api/player/profile')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid token');
    });
  });

  describe('POST /api/player/offline-claim', () => {
    it('should return 401 when no token provided', async () => {
      const response = await request(app)
        .post('/api/player/offline-claim');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('No token provided');
    });

    it('should return 404 when player not found', async () => {
      mockedClaimOfflineIdleRewards.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/player/offline-claim')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Player not found');
    });

    it('should return offline earnings for valid request', async () => {
      const lastOffline = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      mockedClaimOfflineIdleRewards.mockResolvedValue({
        offlineTime: 60,
        taskCount: 1,
        earned: { iron_ore: 60 },
        stored: { iron_ore: 60 },
        overflowed: {},
        lastOffline,
      });

      const response = await request(app)
        .post('/api/player/offline-claim')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.offlineTime).toBe(60);
      expect(response.body.data.taskCount).toBe(1);
      expect(response.body.data.earned).toEqual({ iron_ore: 60 });
      expect(response.body.data.stored.iron_ore).toBe(60);
      expect(response.body.data.overflowed).toEqual({});
      expect(mockedClaimOfflineIdleRewards).toHaveBeenCalledWith(testUserId);
    });

    it('should apply warehouse limits correctly', async () => {
      const lastOffline = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      mockedClaimOfflineIdleRewards.mockResolvedValue({
        offlineTime: 60,
        taskCount: 1,
        earned: { iron_ore: 60 },
        stored: { iron_ore: 50 },
        overflowed: { iron_ore: 10 },
        lastOffline,
      });

      const response = await request(app)
        .post('/api/player/offline-claim')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.stored.iron_ore).toBe(50); // Only 50 can be stored (1000-950)
      expect(response.body.data.overflowed.iron_ore).toBe(10); // 10 overflowed
    });

    it('should handle zero offline time', async () => {
      mockedClaimOfflineIdleRewards.mockResolvedValue({
        offlineTime: 0,
        taskCount: 0,
        earned: {},
        stored: {},
        overflowed: {},
        lastOffline: new Date(),
      });

      const response = await request(app)
        .post('/api/player/offline-claim')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.offlineTime).toBe(0);
      expect(response.body.data.earned).toEqual({});
    });
  });
});
