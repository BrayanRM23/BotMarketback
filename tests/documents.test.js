// Aislamiento: un usuario autenticado no puede ver ni borrar documentos de un bot que no es suyo.
// El modelo Bot y Supabase se simulan.

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.JWT_SECRET = 'secreto-de-prueba';

const mockFrom = jest.fn();
const mockFindOne = jest.fn();

jest.mock('../utils/supabase', () => ({
  getSupabase: () => ({ from: mockFrom, storage: { from: jest.fn() } }),
  BUCKET: 'knowledge-files',
}));
jest.mock('../utils/embeddings', () => ({ embedTexts: jest.fn() }));
jest.mock('../models/Bot', () => ({ findOne: (...args) => mockFindOne(...args), updateOne: jest.fn() }));

const documentRoutes = require('../routes/documents');

const app = express();
app.use(express.json());
app.use('/api/bots', documentRoutes);

const OWN_BOT = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_BOT = '64b7f0c2a1b2c3d4e5f60799';
const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
const cookie = `token=${token}`;

beforeEach(() => {
  mockFrom.mockReset();
  mockFindOne.mockReset();
  // Solo existe el bot propio para user-1
  mockFindOne.mockImplementation((filter) => ({
    select: () =>
      Promise.resolve(filter._id === OWN_BOT && filter.user === 'user-1' ? { _id: OWN_BOT } : null),
  }));
});

test('listar documentos de un bot ajeno devuelve 404 sin consultar Supabase', async () => {
  const res = await request(app).get(`/api/bots/${OTHER_BOT}/documents`).set('Cookie', cookie);
  expect(res.status).toBe(404);
  expect(mockFindOne).toHaveBeenCalledWith({ _id: OTHER_BOT, user: 'user-1' });
  expect(mockFrom).not.toHaveBeenCalled();
});

test('borrar un documento de un bot ajeno devuelve 404 sin consultar Supabase', async () => {
  const res = await request(app)
    .delete(`/api/bots/${OTHER_BOT}/documents/00000000-0000-4000-8000-000000000000`)
    .set('Cookie', cookie);
  expect(res.status).toBe(404);
  expect(mockFrom).not.toHaveBeenCalled();
});

test('un id de bot inválido devuelve 404', async () => {
  const res = await request(app).get('/api/bots/no-es-un-id/documents').set('Cookie', cookie);
  expect(res.status).toBe(404);
  expect(mockFindOne).not.toHaveBeenCalled();
});

test('en el bot propio, las consultas a Supabase filtran por bot_id y user_id', async () => {
  const filters = [];
  const query = {
    select: () => query,
    update: () => query,
    delete: () => query,
    in: () => query,
    lt: () => query,
    eq: (column, value) => {
      filters.push([column, value]);
      return query;
    },
    order: () => Promise.resolve({ data: [], error: null }),
    then: (resolve) => resolve({ data: [], error: null }),
  };
  mockFrom.mockReturnValue(query);

  const res = await request(app).get(`/api/bots/${OWN_BOT}/documents`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  expect(filters).toEqual(expect.arrayContaining([['bot_id', OWN_BOT], ['user_id', 'user-1']]));
});
