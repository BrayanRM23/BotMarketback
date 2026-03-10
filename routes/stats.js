const express = require('express');
const Bot = require('../models/Bot');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// Estadísticas del dashboard (protegido)
router.get('/overview', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const bots = await Bot.find({ user: userId });
    const totalBots = bots.length;
    const totalConversations = bots.reduce((acc, bot) => acc + (bot.totalConversations || 0), 0);

    // Por ahora devolvemos datos dummy para "most asked questions"
    const topQuestions = [
      { question: '¿Cómo puedo integrar este bot en mi web?', count: 24 },
      { question: '¿Qué modelo de IA utiliza?', count: 18 },
      { question: '¿Puedo personalizar las respuestas?', count: 15 },
      { question: '¿Cómo entreno el bot con mis datos?', count: 12 },
      { question: '¿Tiene límite de conversaciones?', count: 9 },
    ];

    return res.json({
      totalBots,
      totalConversations,
      topQuestions,
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener estadísticas.' });
  }
});

module.exports = router;

