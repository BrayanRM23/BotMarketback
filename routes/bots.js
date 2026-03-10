const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const Bot = require('../models/Bot');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Crear nuevo bot (protegido)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'El nombre del bot es obligatorio.' });
    }

    const bot = await Bot.create({
      user: req.user.id,
      name,
      description: description || '',
    });

    return res.status(201).json({ bot });
  } catch (error) {
    console.error('Error al crear bot:', error);
    return res.status(500).json({ message: 'Error en el servidor al crear el bot.' });
  }
});

// Listar bots del usuario actual (protegido)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const bots = await Bot.find({ user: req.user.id }).sort({ createdAt: -1 });
    return res.json({ bots });
  } catch (error) {
    console.error('Error al obtener bots:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener los bots.' });
  }
});

// Obtener un bot específico para editar (protegido)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const bot = await Bot.findOne({ _id: req.params.id, user: req.user.id });
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }
    return res.json({ bot });
  } catch (error) {
    console.error('Error al obtener bot:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener el bot.' });
  }
});

// Actualizar un bot (protegido)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;

    const bot = await Bot.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { name, description },
      { new: true }
    );

    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    return res.json({ bot });
  } catch (error) {
    console.error('Error al actualizar bot:', error);
    return res.status(500).json({ message: 'Error en el servidor al actualizar el bot.' });
  }
});

// Endpoint público para obtener info básica del bot por id (para /chat/:botId)
router.get('/public/:id', async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).select('name description createdAt');
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }
    return res.json({ bot });
  } catch (error) {
    console.error('Error en endpoint público de bot:', error);
    return res.status(500).json({ message: 'Error en el servidor.' });
  }
});

// Chat con el bot (público): recibe mensaje, devuelve respuesta con Gemini usando el contexto del bot
router.post('/:id/chat', async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).select('name description');
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'El mensaje es obligatorio.' });
    }

    const context = (bot.description || '').trim();
    const systemPrompt = context
      ? `Eres el asistente "${bot.name}". Actúa según esta base de conocimiento:\n\n${context}\n\nResponde siempre en el mismo idioma que el usuario, de forma clara y útil.`
      : `Eres el asistente "${bot.name}". Responde de forma clara y útil en el mismo idioma que el usuario.`;

    const fullPrompt = `${systemPrompt}\n\n---\nUsuario: ${message.trim()}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: fullPrompt,
    });

    const text = response?.text ?? response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) {
      return res.status(502).json({ message: 'No se pudo generar una respuesta.' });
    }

    await Bot.findByIdAndUpdate(req.params.id, { $inc: { totalConversations: 1 } });

    return res.json({ reply: text.trim() });
  } catch (error) {
    console.error('Error en chat del bot:', error);
    return res.status(500).json({
      message: error?.message?.includes('API key') ? 'Configura GEMINI_API_KEY en el servidor.' : 'Error al generar la respuesta.',
    });
  }
});

module.exports = router;

