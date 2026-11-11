const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 15000 },
});

const DEFAULT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];
const RETRYABLE_STATUSES = [500, 503, 504];
const FALLBACK_STATUSES = [...RETRYABLE_STATUSES, 404, 429];
const COOLDOWN_MS = 60 * 1000;

// Modelos que fallaron recientemente: se saltan mientras dura el cooldown.
// Vive en memoria, así que solo persiste mientras la instancia serverless esté caliente.
const cooldowns = new Map();

function getModels() {
  const raw = process.env.GEMINI_MODELS;
  if (!raw) return DEFAULT_MODELS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateOnce(model, contents, config) {
  try {
    return await ai.models.generateContent({ model, contents, config });
  } catch (error) {
    if (!RETRYABLE_STATUSES.includes(error?.status)) throw error;
    // Un reintento corto en el mismo modelo antes de cambiar de modelo
    await sleep(400 + Math.random() * 400);
    return ai.models.generateContent({ model, contents, config });
  }
}

/**
 * Llama a Gemini probando los modelos en orden hasta que uno responda.
 * Devuelve { response, model }. Si todos fallan, lanza el último error
 * (con `status` del API cuando lo hay).
 */
async function generateWithFallback({ contents, config }) {
  const models = getModels();
  const now = Date.now();
  const available = models.filter((m) => (cooldowns.get(m) ?? 0) <= now);
  const order = available.length ? available : models;

  let lastError = null;
  for (const model of order) {
    try {
      const response = await generateOnce(model, contents, config);
      return { response, model };
    } catch (error) {
      lastError = error;
      if (!FALLBACK_STATUSES.includes(error?.status)) throw error;

      cooldowns.set(model, Date.now() + COOLDOWN_MS);
      console.error(`Modelo ${model} no disponible (${error.status}), probando el siguiente.`);
    }
  }

  throw lastError ?? new Error('No hay modelos de Gemini configurados.');
}

const ALL_FAILED_RETRY_STATUSES = [429, 500, 503, 504];
const ALL_FAILED_RETRY_DELAY_MS = 2000;

// Si fallan todos los modelos por saturación o cuota, se espera un poco y se intenta
// la cadena completa una vez más antes de devolver el error al visitante.
async function generateWithRetry(params) {
  try {
    return await generateWithFallback(params);
  } catch (error) {
    if (!ALL_FAILED_RETRY_STATUSES.includes(error?.status)) throw error;
    console.error(`Fallaron todos los modelos (${error.status}); reintentando una vez.`);
    await sleep(ALL_FAILED_RETRY_DELAY_MS);
    return generateWithFallback(params);
  }
}

module.exports = { ai, generateWithFallback, generateWithRetry };
