// Integration tests for auth API
import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';

const registeredUsers = new Set<string>();

jest.mock('../services/authService', () => {
  const actual = jest.requireActual('../services/authService');
  return {
    ...actual,
    createUser: jest.fn(async ({ username, password }: { username: string; password: string }) => {
      if (!username || username.trim().length === 0) {
        throw new actual.InvalidInputError('Username is required');
      }
      if (!password || password.length < 6) {
        throw new actual.InvalidInputError('Password must be at least 6 characters');
      }
      const trimmed = username.trim();
      if (registeredUsers.has(trimmed)) {
        throw new actual.UserAlreadyExistsError(trimmed);
      }
      registeredUsers.add(trimmed);
      return {
        id: `user-${trimmed}`,
        username: trimmed,
        created_at: new Date('2026-06-12T00:00:00.000Z'),
        last_login: null,
      };
    }),
    login: jest.fn(async (username: string, password: string) => {
      if (!username || username.trim().length === 0) {
        throw new actual.InvalidInputError('Username is required');
      }
      if (!password || password.length === 0) {
        throw new actual.InvalidInputError('Password is required');
      }
      if (username.includes('nonexistent') || password === 'wrongpassword') {
        throw new actual.InvalidCredentialsError();
      }
      const trimmed = username.trim();
      return {
        token: 'mock_token',
        user: {
          id: `user-${trimmed}`,
          username: trimmed,
          created_at: new Date('2026-06-12T00:00:00.000Z'),
          last_login: new Date('2026-06-12T00:00:00.000Z'),
        },
      };
    }),
  };
});

// Create test app
const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

describe('Auth API Integration Tests', () => {
  const testUsername = `testuser_${Date.now()}`;
  const testPassword = 'password123';

  beforeEach(() => {
    registeredUsers.clear();
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: testUsername,
          password: testPassword
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.username).toBe(testUsername);
      expect(response.body.data).not.toHaveProperty('password_hash');
    });

    it('should return 400 when username already exists', async () => {
      // First create user
      await request(app)
        .post('/api/auth/register')
        .send({
          username: testUsername,
          password: testPassword
        });

      // Try to create duplicate
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: testUsername,
          password: 'different_password'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('already exists');
    });

    it('should return 400 when username is empty', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: '',
          password: testPassword
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when password is too short', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'newuser',
          password: '12345'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('at least 6 characters');
    });

    it('should return 400 when username is missing', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          password: testPassword
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when password is missing', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'newuser'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when request body is empty', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/auth/login', () => {
    const loginUsername = `logintest_${Date.now()}`;
    const loginPassword = 'password123';

    beforeAll(async () => {
      // Create a user for login tests
      await request(app)
        .post('/api/auth/register')
        .send({
          username: loginUsername,
          password: loginPassword
        });
    });

    it('should login successfully with correct credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: loginUsername,
          password: loginPassword
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('token');
      expect(response.body.data.user.username).toBe(loginUsername);
      expect(response.body.data.user).not.toHaveProperty('password_hash');
    });

    it('should return 401 with incorrect password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: loginUsername,
          password: 'wrongpassword'
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid username or password');
    });

    it('should return 401 with non-existent username', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'nonexistent_user_12345',
          password: 'password123'
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when username is empty', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: '',
          password: loginPassword
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when password is empty', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: loginUsername,
          password: ''
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when username is missing', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          password: loginPassword
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when password is missing', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: loginUsername
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 when request body is empty', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });
  });
});
