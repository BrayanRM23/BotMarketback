const DEFAULT_TTL_DAYS = 90;

// Días que se conservan las conversaciones inactivas. Lo usan el índice TTL y el aviso de privacidad,
// así ambos dicen lo mismo.
function getConversationTtlDays() {
  const value = Number(process.env.CONVERSATION_TTL_DAYS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_DAYS;
}

module.exports = { getConversationTtlDays };
