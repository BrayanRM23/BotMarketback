const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middlewares
app.set('trust proxy', 1);
app.use(express.json());

function parseAllowedOrigins() {
  const raw = process.env.CLIENT_URL || 'http://localhost:5173';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

const MONGO_URI = process.env.MONGO_URI;

let mongoConnPromise = null;
async function connectMongoOnce() {
  if (mongoose.connection.readyState === 1) return;
  if (!mongoConnPromise) {
    mongoConnPromise = mongoose.connect(MONGO_URI);
  }
  await mongoConnPromise;
}

// Asegura MongoDB antes de manejar cualquier request (Vercel/serverless friendly)
app.use(async (req, res, next) => {
  try {
    await connectMongoOnce();
    return next();
  } catch (error) {
    console.error('Error al conectar a MongoDB:', error);
    return res.status(500).json({ message: 'Error conectando a la base de datos.' });
  }
});

// Rutas (se montan después de asegurar la conexión)
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bots');
const statsRoutes = require('./routes/stats');
const calendarRoutes = require('./routes/calendar');

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / server-to-server / curl (no Origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS bloqueado para el origen: ${origin}`));
    },
    credentials: true,
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/calendar', calendarRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Bot Market API funcionando' });
});

// Solo levantar servidor en local (no en Vercel)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  connectMongoOnce()
    .then(() => {
      console.log('Conectado a MongoDB');
      app.listen(PORT, () => {
        console.log(`Servidor escuchando en el puerto ${PORT}`);
      });
    })
    .catch((error) => {
      console.error('Error al conectar a MongoDB:', error);
      process.exit(1);
    });
}

module.exports = app;

