const mongoose = require('mongoose');
const { getConversationTtlDays } = require('../utils/retention');

const TTL_DAYS = getConversationTtlDays();

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    // Solo en mensajes del asistente: modelo de Gemini que respondió (puede variar por el fallback)
    model: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const calendarActionSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ['create', 'edit', 'delete'], required: true },
    eventId: { type: String, default: '' },
    summary: { type: String, default: '' },
    start: { type: String, default: '' },
    end: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    bot: { type: mongoose.Schema.Types.ObjectId, ref: 'Bot', required: true },
    sessionId: { type: String, required: true },
    messages: { type: [messageSchema], default: [] },
    calendarActions: { type: [calendarActionSchema], default: [] },
    messageCount: { type: Number, default: 0 },
    // Inicio de la conversación. Las anteriores a este campo no lo tienen: se usa el primer mensaje.
    createdAt: { type: Date },
    // Fecha en que el visitante aceptó el aviso de privacidad (Ley 1581 de 2012)
    privacyAcceptedAt: { type: Date },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Una conversación por visitante y bot
conversationSchema.index({ bot: 1, sessionId: 1 }, { unique: true });
// Estadísticas por bot en un rango de fechas
conversationSchema.index({ bot: 1, lastMessageAt: -1 });
// Limpieza automática de conversaciones inactivas
conversationSchema.index({ lastMessageAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });

module.exports = mongoose.model('Conversation', conversationSchema);
