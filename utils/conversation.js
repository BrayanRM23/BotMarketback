const Bot = require('../models/Bot');
const Conversation = require('../models/Conversation');

const MAX_WINDOW_CHARS = 24000;
const MAX_WINDOW_MESSAGES = 60;
const MAX_STORED_MESSAGES = 200;
const MAX_STORED_ACTIONS = 20;
const FIRST_MESSAGE_CHARS = 500;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && UUID_REGEX.test(sessionId);
}

// Recorre el historial de más nuevo a más viejo y toma pares completos (user + assistant)
// hasta el presupuesto. Como solo se guardan turnos exitosos, la secuencia siempre alterna.
// Si la ventana no incluye el primer mensaje del cliente, se devuelve aparte para fijarlo
// en el system prompt (así se conserva un dato como el nombre aunque la charla sea larga).
function buildHistoryWindow(messages) {
  const window = [];
  let chars = 0;

  for (let i = messages.length - 1; i >= 1; i -= 2) {
    const pair = [messages[i - 1], messages[i]];
    const pairChars = pair.reduce((acc, m) => acc + m.content.length, 0);
    if (chars + pairChars > MAX_WINDOW_CHARS || window.length + 2 > MAX_WINDOW_MESSAGES) break;
    window.unshift(...pair);
    chars += pairChars;
  }

  const first = messages[0];
  const pinnedFirst =
    first && first.role === 'user' && !window.includes(first)
      ? first.content.slice(0, FIRST_MESSAGE_CHARS)
      : null;

  return {
    history: window.map((m) => ({ role: m.role, content: m.content })),
    pinnedFirst,
  };
}

// Eventos creados o editados que siguen vigentes. Se inyecta en el prompt para que el bot
// pueda editar o borrar sin volver a listar el calendario.
function formatCalendarMemory(actions) {
  const live = new Map();
  for (const a of actions) {
    if (!a.eventId) continue;
    if (a.action === 'delete') live.delete(a.eventId);
    else live.set(a.eventId, a);
  }
  if (!live.size) return '';

  const lines = [...live.values()].map(
    (a) => `- ${a.summary || 'Evento'} (${a.start || '?'} a ${a.end || '?'}) — eventId: ${a.eventId}`
  );
  return (
    'Eventos que creaste o editaste en esta conversación y que siguen vigentes ' +
    '(úsalos directamente para editar o eliminar sin volver a listar):\n' +
    lines.join('\n')
  );
}

async function loadConversation(botId, sessionId) {
  return Conversation.findOne({ bot: botId, sessionId }).lean();
}

// Guarda un turno exitoso. Si la conversación es nueva, cuenta una conversación en el bot.
// `model` es el modelo de Gemini que respondió; `privacyAcceptedAt` se guarda con $min,
// así queda la primera fecha de aceptación aunque el visitante la renueve.
async function saveTurn({
  botId,
  sessionId,
  userText,
  assistantText,
  model,
  privacyAcceptedAt,
  calendarActions = [],
}) {
  const now = new Date();
  const newMessages = [
    { role: 'user', content: userText, createdAt: now },
    { role: 'assistant', content: assistantText, createdAt: now, ...(model && { model }) },
  ];

  const write = () =>
    Conversation.updateOne(
      { bot: botId, sessionId },
      {
        $push: {
          messages: { $each: newMessages, $slice: -MAX_STORED_MESSAGES },
          ...(calendarActions.length && {
            calendarActions: { $each: calendarActions, $slice: -MAX_STORED_ACTIONS },
          }),
        },
        $set: { lastMessageAt: now },
        $setOnInsert: { createdAt: now },
        $inc: { messageCount: newMessages.length },
        ...(privacyAcceptedAt && { $min: { privacyAcceptedAt } }),
      },
      { upsert: true }
    );

  let result;
  try {
    result = await write();
  } catch (error) {
    // Dos primeros mensajes simultáneos pueden chocar con el índice único: se reintenta una vez
    if (error?.code !== 11000) throw error;
    result = await write();
  }

  if (result.upsertedCount === 1) {
    await Bot.updateOne({ _id: botId }, { $inc: { totalConversations: 1 } });
  }
}

// Borrado a petición del visitante. totalConversations no se descuenta: es un conteo
// agregado sin datos personales.
async function deleteConversation(botId, sessionId) {
  const result = await Conversation.deleteOne({ bot: botId, sessionId });
  return result.deletedCount === 1;
}

// Fecha de aceptación del aviso enviada por el cliente: válida y no en el futuro
function parsePrivacyAcceptance(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() > Date.now() + 5 * 60 * 1000) return null;
  return date;
}

module.exports = {
  isValidSessionId,
  buildHistoryWindow,
  formatCalendarMemory,
  loadConversation,
  saveTurn,
  deleteConversation,
  parsePrivacyAcceptance,
};
