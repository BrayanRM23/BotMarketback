// Análisis de texto para el panel de estadísticas. Funciones puras, sin acceso a base de datos.

const MIN_LENGTH = 3;
const MAX_LENGTH = 200;
const MIN_REPEATS = 2;

const STOPWORDS_RAW = [
  'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por', 'un', 'para', 'con',
  'no', 'una', 'su', 'al', 'lo', 'como', 'mas', 'pero', 'sus', 'le', 'ya', 'o', 'este', 'si',
  'porque', 'esta', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'tambien', 'me', 'hasta', 'hay',
  'donde', 'quien', 'desde', 'todo', 'nos', 'uno', 'les', 'ni', 'ese', 'eso', 'ante', 'esto',
  'otro', 'otra', 'tanto', 'esa', 'estos', 'mucho', 'nada', 'muchos', 'poco', 'ella', 'estar',
  'estas', 'algo', 'mi', 'mis', 'tu', 'tus', 'te', 'ti', 'ser', 'son', 'es', 'son', 'fue',
  'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'gracias', 'favor', 'quiero',
  'puedo', 'puedes', 'necesito', 'tiene', 'tienen', 'hacer', 'algun', 'alguna', 'cual',
  'cuales', 'que', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'como', 'the', 'and', 'you',
];

// Se normaliza igual que los textos para que las comparaciones coincidan
function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(STOPWORDS_RAW.map(normalizeText));

// Correos y teléfonos no deben aparecer en las listas, aunque se repitan
function containsPersonalData(text) {
  if (text.includes('@')) return true;
  const digitsOnly = text.replace(/[\s.\-()+]/g, '');
  return /\d{7,}/.test(digitsOnly);
}

function isEligible(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH && !containsPersonalData(trimmed);
}

// Preguntas repetidas: mismo texto tras normalizar, al menos MIN_REPEATS veces.
// Se muestra la redacción original más usada.
function topQuestions(texts, limit = 8) {
  const groups = new Map();

  for (const raw of texts) {
    if (!isEligible(raw)) continue;
    const key = normalizeText(raw);
    if (!key) continue;

    const group = groups.get(key) || { count: 0, variants: new Map() };
    group.count += 1;
    const original = raw.trim();
    group.variants.set(original, (group.variants.get(original) || 0) + 1);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((g) => g.count >= MIN_REPEATS)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => {
      const [question] = [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0];
      return { question, count: g.count };
    });
}

// Términos que aparecen en varios mensajes. Cada término cuenta una vez por mensaje.
function topTopics(texts, limit = 10) {
  const counts = new Map();

  for (const raw of texts) {
    if (!isEligible(raw)) continue;
    const tokens = new Set(
      normalizeText(raw)
        .split(' ')
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t))
    );
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_REPEATS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic, count]) => ({ topic, count }));
}

module.exports = { normalizeText, containsPersonalData, topQuestions, topTopics };
