// End-to-End tests for user registration and player initialization flow
import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import playerRoutes from '../routes/player';
import { query, execute, withTransaction } from '../config/database';

// Create test app
const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/player', playerRoutes);

// Mock the database module
jest.mock('../config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  withTransaction: jest.fn(),
}));

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed_password'),
  compare: jest.fn().mockResolvedValue(true)
}));

// Mock jsonwebtoken
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockImplementation((payload: any, _secret: string, _options: any) => {
    return `token_for_${payload.username || payload.userId}`;
  })
}));

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedExecute = execute as jest.MockedFunction<typeof execute>;
const mockedWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
const mockTransactionClient = { query: jest.fn() };

describe('E2E: User Registration and Player Initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockReset();
    mockedExecute.mockReset();
    mockTransactionClient.query.mockReset();
    mockedWithTransaction.mockImplementation(async callback => callback(mockTransactionClient as any));
    mockTransactionClient.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT id') && sql.includes('FROM inventory_items')) {
        return { rows: [{ id: `inventory-${params?.[2]}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    process.env.JWT_SECRET = 'test_secret';
    process.env.JWT_EXPIRES_IN = '7d';
  });

  it('should complete full user flow: register -> login -> get player info', async () => {
    const username = 'e2euser';
    const password = 'password123';

    mockedQuery.mockReturnValueOnce(Promise.resolve([]));

    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({ username, password });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body.success).toBe(true);
    expect(registerResponse.body.data.username).toBe(username);

    expect(mockedWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionClient.query.mock.calls.filter(call => String(call[0]).includes('INSERT INTO characters'))).toHaveLength(3);

    // Step 2: Login with registered user
    mockedQuery
      .mockReturnValueOnce(Promise.resolve([{
        id: 'user-123',
        username: 'e2euser',
        password_hash: 'hashed_password',
        created_at: new Date(),
        last_login: null
      }] as any))
      .mockReturnValue(Promise.resolve([]));
    mockedExecute.mockResolvedValue(1);

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ username, password });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.success).toBe(true);
    expect(loginResponse.body.data.token).toBeDefined();
  });

  it('should create player with 3 characters on registration', async () => {
    mockedQuery.mockReturnValueOnce(Promise.resolve([]));

    await request(app)
      .post('/api/auth/register')
      .send({ username: 'newplayer', password: 'password123' });

    const characterCalls = mockTransactionClient.query.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO characters')
    ) as Array<[string, any[]]>;

    // Check that 3 character inserts were made
    expect(characterCalls.length).toBe(3);

    const professions = characterCalls.map(call => call[1][3]);
    expect(professions).toEqual([null, null, null]);
  });

  it('should initialize player with correct resources', async () => {
    mockedQuery.mockReturnValueOnce(Promise.resolve([]));

    await request(app)
      .post('/api/auth/register')
      .send({ username: 'resourceuser', password: 'password123' });

    // Get the player insert call
    const playerCall = mockTransactionClient.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO players'))!;
    const warehouseLimits = JSON.parse(playerCall[1]![2]!);
    expect(warehouseLimits).toEqual({
      resource: 1000,
      material: 500,
      gear: 50,
      certification: 10,
      card: 200,
      consumable: 100,
    });
    expect(playerCall[0]).not.toContain('resources');
    expect(playerCall[0]).not.toContain('materials');
  });

  it('should create characters with correct initial stats', async () => {
    mockedQuery.mockReturnValueOnce(Promise.resolve([]));

    await request(app)
      .post('/api/auth/register')
      .send({ username: 'statsuser', password: 'password123' });

    // Get character insert calls
    const characterCalls = mockTransactionClient.query.mock.calls.filter(call =>
      String(call[0]).includes('INSERT INTO characters')
    );

    const warriorStats = characterCalls[0]![1]!;
    expect(warriorStats[3]).toBeNull(); // profession
    expect(warriorStats[5]).toBe(10); // health
    expect(warriorStats[7]).toBe(2); // movement
    expect(warriorStats[9]).toBe(3); // max_energy

    const rangerStats = characterCalls[1]![1]!;
    expect(rangerStats[3]).toBeNull();
    expect(rangerStats[5]).toBe(10);
    expect(rangerStats[7]).toBe(2);
    expect(rangerStats[9]).toBe(3);

    const mageStats = characterCalls[2]![1]!;
    expect(mageStats[3]).toBeNull();
    expect(mageStats[5]).toBe(10);
    expect(mageStats[7]).toBe(2);
    expect(mageStats[9]).toBe(3);
  });

  it('should prevent registration with duplicate username', async () => {
    // First registration succeeds
    mockedQuery.mockReturnValueOnce(Promise.resolve([]));

    await request(app)
      .post('/api/auth/register')
      .send({ username: 'duplicate', password: 'password123' });

    // Second registration with same username should fail
    mockedQuery.mockResolvedValue([{ id: 'existing-id' }] as any);

    const response = await request(app)
      .post('/api/auth/register')
      .send({ username: 'duplicate', password: 'password123' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('already exists');
  });

  it('should fail login with wrong password', async () => {
    // Setup user exists
    mockedQuery.mockResolvedValue([{
      id: 'user-123',
      username: 'testuser',
      password_hash: 'hashed_password',
      created_at: new Date(),
      last_login: null
    }] as any);

    // Mock bcrypt compare to return false (wrong password)
    const bcrypt = require('bcryptjs');
    (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser', password: 'wrongpassword' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid username or password');
  });
});
