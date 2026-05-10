const express = require('express');
const Bot = require('../models/Bot');
const authMiddleware = require('../middleware/authMiddleware');
const gcal = require('../utils/googleCalendar');

const router = express.Router();

// Inicia el flujo OAuth2 — el usuario es redirigido a Google
router.get('/auth/:botId', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.botId, user: req.user.id });
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }
    const url = gcal.getAuthorizationUrl(req.params.botId);
    return res.redirect(url);
  } catch (error) {
    console.error('Error iniciando OAuth:', error);
    return res.status(500).json({ message: 'Error iniciando autenticación con Google.' });
  }
});

// Callback de Google OAuth2 — guarda tokens y redirige al frontend
router.get('/callback', async (req, res) => {
  const { code, state: botId, error } = req.query;
  const clientUrl = process.env.CLIENT_URL?.split(',')[0]?.trim() || 'http://localhost:5173';

  if (error || !code || !botId) {
    return res.redirect(`${clientUrl}/dashboard/bots?calendar=error`);
  }

  try {
    const tokens = await gcal.exchangeCodeForTokens(code);
    await Bot.findByIdAndUpdate(botId, {
      'googleCalendar.connected': true,
      'googleCalendar.accessToken': tokens.accessToken,
      'googleCalendar.refreshToken': tokens.refreshToken,
      'googleCalendar.expiryDate': tokens.expiryDate,
    });
    return res.redirect(`${clientUrl}/dashboard/bots/${botId}/edit?calendar=connected`);
  } catch (err) {
    console.error('Error en callback OAuth:', err);
    return res.redirect(`${clientUrl}/dashboard/bots?calendar=error`);
  }
});

// Obtener configuración de calendar del bot (protegido)
router.get('/bots/:botId', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.botId, user: req.user.id }).select(
      'googleCalendar calendarLog'
    );
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado.' });

    // Nunca devolver tokens al frontend
    const calData = bot.googleCalendar?.toObject?.() || bot.googleCalendar || {};
    delete calData.accessToken;
    delete calData.refreshToken;

    return res.json({ calendar: calData, log: bot.calendarLog?.slice(-50) || [] });
  } catch (error) {
    console.error('Error obteniendo config calendar:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// Actualizar configuración de calendar (permisos, instrucciones, campos, etc.)
router.put('/bots/:botId', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.botId, user: req.user.id });
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado.' });

    const {
      permissions,
      instructions,
      customFields,
      defaultDuration,
      timezone,
      calendarId,
    } = req.body;

    if (permissions !== undefined) bot.googleCalendar.permissions = permissions;
    if (instructions !== undefined) bot.googleCalendar.instructions = instructions;
    if (customFields !== undefined) bot.googleCalendar.customFields = customFields;
    if (defaultDuration !== undefined) bot.googleCalendar.defaultDuration = defaultDuration;
    if (timezone !== undefined) bot.googleCalendar.timezone = timezone;
    if (calendarId !== undefined) bot.googleCalendar.calendarId = calendarId;

    await bot.save();

    return res.json({ message: 'Configuración guardada correctamente.' });
  } catch (error) {
    console.error('Error actualizando config calendar:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// Desconectar Google Calendar
router.delete('/bots/:botId', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.botId, user: req.user.id });
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado.' });

    bot.googleCalendar = {
      connected: false,
      accessToken: '',
      refreshToken: '',
      expiryDate: 0,
      calendarId: 'primary',
      timezone: 'America/Bogota',
      permissions: {},
      instructions: '',
      customFields: [],
      defaultDuration: 60,
    };
    await bot.save();

    return res.json({ message: 'Google Calendar desconectado correctamente.' });
  } catch (error) {
    console.error('Error desconectando calendar:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// Listar calendarios disponibles de la cuenta Google conectada
router.get('/bots/:botId/calendars', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.botId, user: req.user.id });
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado.' });
    if (!bot.googleCalendar?.connected) {
      return res.status(400).json({ message: 'Google Calendar no está conectado.' });
    }

    const auth = gcal.getAuthenticatedClient(bot.googleCalendar);
    const calendars = await gcal.listCalendars(auth);
    return res.json({ calendars });
  } catch (error) {
    console.error('Error listando calendarios:', error);
    return res.status(500).json({ message: 'Error al obtener calendarios de Google.' });
  }
});

// Historial de acciones del calendar
router.get('/bots/:botId/log', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.botId, user: req.user.id }).select('calendarLog');
    if (!bot) return res.status(404).json({ message: 'Bot no encontrado.' });
    return res.json({ log: bot.calendarLog?.slice(-100) || [] });
  } catch (error) {
    console.error('Error obteniendo log:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

module.exports = router;
