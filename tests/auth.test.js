// Rutas protegidas: sin cookie o con token inválido responden 401 antes de tocar la base de datos.

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.JWT_SECRET = 'secreto-de-prueba';

const botRoutes = require('../routes/bots');
const documentRoutes = require('../routes/documents');
const statsRoutes = require('../routes/stats');

const app = express();
app.use(express.json());
app.use('/api/bots', botRoutes);
app.use('/api/bots', documentRoutes);
app.use('/api/stats', statsRoutes);

const BOT_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('sin cookie de sesión', () => {
  test.each([
    ['GET', '/api/bots'],
    ['POST', '/api/bots'],
    ['PUT', `/api/bots/${BOT_ID}`],
    ['GET', `/api/bots/${BOT_ID}/documents`],
    ['DELETE', `/api/bots/${BOT_ID}/documents/00000000-0000-4000-8000-000000000000`],
    ['GET', '/api/stats/overview'],
  ])('%s %s devuelve 401', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/No autorizado/);
  });
});

test('un token firmado con otro secreto devuelve 401', async () => {
  const forged = jwt.sign({ id: 'u1' }, 'otro-secreto');
  const res = await request(app).get('/api/bots').set('Cookie', `token=${forged}`);
  expect(res.status).toBe(401);
  expect(res.body.message).toMatch(/inválido o expirado/);
});

test('un token vencido devuelve 401', async () => {
  const expired = jwt.sign({ id: 'u1' }, process.env.JWT_SECRET, { expiresIn: -10 });
  const res = await request(app).get('/api/stats/overview').set('Cookie', `token=${expired}`);
  expect(res.status).toBe(401);
});
