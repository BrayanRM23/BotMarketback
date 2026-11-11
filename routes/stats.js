const express = require('express');
const Bot = require('../models/Bot');
const Conversation = require('../models/Conversation');
const authMiddleware = require('../middleware/authMiddleware');
const { topQuestions, topTopics } = require('../utils/statsText');

const router = express.Router();

const TZ = 'America/Bogota';
const ALLOWED_DAYS = [7, 30, 90];
const MAX_TEXTS = 5000;

// Últimos N días calendario en la zona horaria del negocio, del más antiguo al más reciente
function dayKeysFor(days) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(formatter.format(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  }
  return keys;
}

// Estadísticas del dashboard (protegido). Query: days=7|30|90 (default 30), botId opcional.
router.get('/overview', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const requestedDays = Number(req.query.days);
    const days = ALLOWED_DAYS.includes(requestedDays) ? requestedDays : 30;

    const bots = await Bot.find({ user: userId })
      .select('name totalConversations knowledgeDocCount googleCalendar.connected')
      .lean();

    let scope = bots;
    if (req.query.botId) {
      const selected = bots.find((b) => String(b._id) === String(req.query.botId));
      if (!selected) {
        return res.status(404).json({ message: 'Bot no encontrado.' });
      }
      scope = [selected];
    }

    const dayKeys = dayKeysFor(days);
    const since = new Date(`${dayKeys[0]}T00:00:00-05:00`);
    const botIds = scope.map((b) => b._id);

    // Conversaciones iniciadas dentro del rango. La fecha de inicio cae al primer mensaje
    // en las conversaciones anteriores al campo createdAt.
    const base = [
      { $match: { bot: { $in: botIds }, lastMessageAt: { $gte: since } } },
      {
        $addFields: {
          startedAt: { $ifNull: ['$createdAt', { $arrayElemAt: ['$messages.createdAt', 0] }] },
        },
      },
      { $match: { startedAt: { $gte: since } } },
    ];

    const [summary] = await Conversation.aggregate([
      ...base,
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                conversations: { $sum: 1 },
                messages: { $sum: '$messageCount' },
                calendarCreated: {
                  $sum: {
                    $size: {
                      $filter: {
                        input: { $ifNull: ['$calendarActions', []] },
                        as: 'a',
                        cond: { $eq: ['$$a.action', 'create'] },
                      },
                    },
                  },
                },
              },
            },
          ],
          series: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: TZ } },
                count: { $sum: 1 },
              },
            },
          ],
          perBot: [
            {
              $group: {
                _id: '$bot',
                conversations: { $sum: 1 },
                messages: { $sum: '$messageCount' },
                lastActivity: { $max: '$lastMessageAt' },
                calendarCreated: {
                  $sum: {
                    $size: {
                      $filter: {
                        input: { $ifNull: ['$calendarActions', []] },
                        as: 'a',
                        cond: { $eq: ['$$a.action', 'create'] },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    ]);

    // Mensajes de clientes del rango, ya acotados para las listas de preguntas y temas
    const messageRows = await Conversation.aggregate([
      ...base,
      { $unwind: '$messages' },
      {
        $match: {
          'messages.role': 'user',
          $expr: {
            $and: [
              { $gte: [{ $strLenCP: '$messages.content' }, 3] },
              { $lte: [{ $strLenCP: '$messages.content' }, 200] },
            ],
          },
        },
      },
      { $sort: { 'messages.createdAt': -1 } },
      { $limit: MAX_TEXTS },
      { $project: { _id: 0, content: '$messages.content' } },
    ]);

    const totals = summary?.totals?.[0] || { conversations: 0, messages: 0, calendarCreated: 0 };
    const seriesByDay = new Map((summary?.series || []).map((r) => [r._id, r.count]));
    const series = dayKeys.map((date) => ({ date, count: seriesByDay.get(date) || 0 }));

    const clientMessages = Math.round(totals.messages / 2);
    const perBotStats = new Map((summary?.perBot || []).map((r) => [String(r._id), r]));
    const perBot = scope
      .map((b) => {
        const stats = perBotStats.get(String(b._id)) || {};
        return {
          id: String(b._id),
          name: b.name,
          conversations: stats.conversations || 0,
          clientMessages: Math.round((stats.messages || 0) / 2),
          lastActivity: stats.lastActivity || null,
          documents: b.knowledgeDocCount || 0,
          calendarConnected: Boolean(b.googleCalendar?.connected),
          calendarCreated: stats.calendarCreated || 0,
        };
      })
      .sort((a, b) => b.conversations - a.conversations);

    const texts = messageRows.map((r) => r.content);

    return res.json({
      range: { days, since: since.toISOString() },
      bots: bots.map((b) => ({ id: String(b._id), name: b.name })),
      totalBots: bots.length,
      totalConversations: scope.reduce((acc, b) => acc + (b.totalConversations || 0), 0),
      kpis: {
        conversations: totals.conversations,
        clientMessages,
        avgMessagesPerConversation:
          totals.conversations > 0 ? Math.round((clientMessages / totals.conversations) * 10) / 10 : 0,
        calendarCreated: totals.calendarCreated,
        calendarEnabled: scope.some((b) => Boolean(b.googleCalendar?.connected)),
      },
      series,
      perBot,
      topQuestions: topQuestions(texts),
      topTopics: topTopics(texts),
    });
  } catch (error) {
    console.error('Error al obtener estadísticas:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener estadísticas.' });
  }
});

module.exports = router;
