const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const Bot = require('../models/Bot');
const authMiddleware = require('../middleware/authMiddleware');
const { getSupabase, BUCKET } = require('../utils/supabase');
const { buildChunks } = require('../utils/chunker');
const { embedTexts } = require('../utils/embeddings');

const router = express.Router();

const MAX_SEGMENTS_PER_REQUEST = 200;
const MAX_CHUNKS_PER_REQUEST = 300;
// chunk_index = batchIndex * CHUNKS_PER_BATCH_SLOT + posición: único y estable al reintentar
const CHUNKS_PER_BATCH_SLOT = 1000;
const MAX_BATCH_INDEX = 100000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const STALE_ERROR_MESSAGE =
  'La carga se interrumpió (más de 10 minutos sin actividad). Vuelve a subir el archivo.';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers de propiedad: todo documento se valida contra el bot y el usuario ──

async function findOwnedBot(botId, userId) {
  if (!mongoose.isValidObjectId(botId)) return null;
  return Bot.findOne({ _id: botId, user: userId }).select('_id');
}

async function findOwnedDocument(docId, botId, userId) {
  if (!UUID_REGEX.test(String(docId))) return null;
  const { data, error } = await getSupabase()
    .from('knowledge_documents')
    .select('*')
    .eq('id', docId)
    .eq('bot_id', botId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function countChunks(documentId) {
  const { count, error } = await getSupabase()
    .from('knowledge_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', documentId);
  if (error) throw error;
  return count || 0;
}

async function deleteChunks(documentIds) {
  if (!documentIds.length) return;
  const { error } = await getSupabase().from('knowledge_chunks').delete().in('document_id', documentIds);
  if (error) throw error;
}

// Borra archivo, fila y fragmentos (en cascada) y ajusta el contador del bot
async function removeDocument(doc, botId) {
  const supabase = getSupabase();

  // Si falla el borrado del archivo se registra, pero se sigue: el documento ya no debe consultarse
  const { error: storageError } = await supabase.storage.from(BUCKET).remove([doc.storage_path]);
  if (storageError) console.error('No se pudo borrar el archivo original:', storageError);

  const { error } = await supabase.from('knowledge_documents').delete().eq('id', doc.id);
  if (error) throw error;

  if (doc.status === 'ready') {
    await Bot.updateOne({ _id: botId, knowledgeDocCount: { $gt: 0 } }, { $inc: { knowledgeDocCount: -1 } });
  }
}

// Documentos sin actividad en 'processing' (navegador cerrado, carga abandonada):
// se marcan como error y se borran sus fragmentos parciales.
async function expireStaleDocuments(botId, userId) {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();

  const { data: stale, error } = await supabase
    .from('knowledge_documents')
    .select('id')
    .eq('bot_id', botId)
    .eq('user_id', userId)
    .eq('status', 'processing')
    .lt('updated_at', cutoff);
  if (error) throw error;
  if (!stale.length) return;

  const ids = stale.map((d) => d.id);
  await deleteChunks(ids);
  const { error: updateError } = await supabase
    .from('knowledge_documents')
    .update({ status: 'error', chunk_count: 0, error: STALE_ERROR_MESSAGE })
    .in('id', ids)
    .eq('status', 'processing');
  if (updateError) throw updateError;
}

// ─── Paso 1: registrar el documento y obtener URL firmada para subir el original ──

router.post('/:id/documents', authMiddleware, async (req, res) => {
  try {
    const bot = await findOwnedBot(req.params.id, req.user.id);
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const filename = String(req.body?.filename || '').trim();
    if (!filename) {
      return res.status(400).json({ message: 'El nombre del archivo es obligatorio.' });
    }

    // Reemplazo: el documento anterior debe ser del mismo bot y usuario, y no estar en proceso
    let replacesId = null;
    if (req.body?.replacesDocId) {
      const previous = await findOwnedDocument(req.body.replacesDocId, String(bot._id), req.user.id);
      if (!previous) {
        return res.status(404).json({ message: 'El documento a reemplazar no existe.' });
      }
      if (previous.status === 'processing') {
        return res.status(409).json({ message: 'No se puede reemplazar un documento que aún está en proceso.' });
      }
      replacesId = previous.id;
    }

    const docId = crypto.randomUUID();
    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const storagePath = `${bot._id}/${docId}/${safeName}`;
    const supabase = getSupabase();

    const { error: insertError } = await supabase.from('knowledge_documents').insert({
      id: docId,
      bot_id: String(bot._id),
      user_id: req.user.id,
      filename,
      storage_path: storagePath,
      mime_type: String(req.body?.mimeType || '').slice(0, 100) || null,
      status: 'processing',
      replaces_id: replacesId,
    });
    if (insertError) throw insertError;

    // upsert: si la subida se reintenta después de haber llegado, sobrescribe en vez de fallar
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath, { upsert: true });
    if (error) throw error;

    return res.status(201).json({ docId, path: data.path, token: data.token });
  } catch (error) {
    console.error('Error al registrar documento:', error);
    return res.status(500).json({ message: 'Error en el servidor al registrar el documento.' });
  }
});

// ─── Paso 2: recibir segmentos extraídos en el front, fragmentar, embeber e insertar ──
// Idempotente por lote: reenviar el mismo batchIndex reemplaza lo insertado antes,
// así el front puede reintentar sin duplicar fragmentos.

router.post('/:id/documents/:docId/chunks', authMiddleware, async (req, res) => {
  try {
    const bot = await findOwnedBot(req.params.id, req.user.id);
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const doc = await findOwnedDocument(req.params.docId, String(bot._id), req.user.id);
    if (!doc) {
      return res.status(404).json({ message: 'Documento no encontrado.' });
    }
    if (doc.status !== 'processing') {
      return res.status(409).json({ message: 'El documento ya fue procesado.' });
    }

    const rawBatch = req.body?.batchIndex;
    const hasBatchIndex = Number.isInteger(rawBatch) && rawBatch >= 0 && rawBatch < MAX_BATCH_INDEX;
    if (rawBatch !== undefined && !hasBatchIndex) {
      return res.status(400).json({ message: 'batchIndex inválido.' });
    }

    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    if (!segments.length || segments.length > MAX_SEGMENTS_PER_REQUEST) {
      return res
        .status(400)
        .json({ message: `Envía entre 1 y ${MAX_SEGMENTS_PER_REQUEST} segmentos por petición.` });
    }

    const chunks = segments.flatMap((segment) => buildChunks(segment));
    if (chunks.length > MAX_CHUNKS_PER_REQUEST) {
      return res
        .status(400)
        .json({ message: `Este lote genera ${chunks.length} fragmentos; el máximo es ${MAX_CHUNKS_PER_REQUEST}.` });
    }

    const supabase = getSupabase();

    if (hasBatchIndex) {
      const { error: cleanupError } = await supabase
        .from('knowledge_chunks')
        .delete()
        .eq('document_id', doc.id)
        .eq('batch_index', rawBatch);
      if (cleanupError) throw cleanupError;
    }

    if (chunks.length) {
      const vectors = await embedTexts(
        chunks.map((chunk) => chunk.content),
        'RETRIEVAL_DOCUMENT'
      );

      // Clientes anteriores no envían batchIndex: se continúa numerando tras lo existente
      const base = hasBatchIndex ? rawBatch * CHUNKS_PER_BATCH_SLOT : await countChunks(doc.id);
      const rows = chunks.map((chunk, i) => ({
        document_id: doc.id,
        bot_id: doc.bot_id,
        batch_index: hasBatchIndex ? rawBatch : 0,
        chunk_index: base + i,
        content: chunk.content,
        metadata: chunk.metadata,
        embedding: JSON.stringify(vectors[i]),
      }));

      const { error } = await supabase.from('knowledge_chunks').insert(rows);
      if (error) throw error;
    }

    // Marca actividad para que el documento no se considere atascado
    const { error: touchError } = await supabase
      .from('knowledge_documents')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (touchError) throw touchError;

    return res.json({ inserted: chunks.length });
  } catch (error) {
    console.error('Error al procesar fragmentos:', error);
    return res.status(500).json({ message: 'Error en el servidor al procesar el documento.' });
  }
});

// ─── Paso 3: cerrar el documento como listo o con error ──────────────────────
// Con error: se borran los fragmentos parciales (el bot nunca usa un documento a medias).
// Listo y con replaces_id: se borra el documento anterior en el mismo paso.

router.post('/:id/documents/:docId/complete', authMiddleware, async (req, res) => {
  try {
    const bot = await findOwnedBot(req.params.id, req.user.id);
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const doc = await findOwnedDocument(req.params.docId, String(bot._id), req.user.id);
    if (!doc) {
      return res.status(404).json({ message: 'Documento no encontrado.' });
    }
    if (doc.status !== 'processing') {
      return res.status(409).json({ message: 'El documento ya fue procesado.' });
    }

    const supabase = getSupabase();
    const failure = req.body?.error ? String(req.body.error).slice(0, 300) : null;

    if (failure) {
      await deleteChunks([doc.id]);
      const { error } = await supabase
        .from('knowledge_documents')
        .update({ status: 'error', chunk_count: 0, error: failure, updated_at: new Date().toISOString() })
        .eq('id', doc.id);
      if (error) throw error;
      return res.json({ status: 'error', chunkCount: 0, replaced: false });
    }

    const chunkCount = await countChunks(doc.id);
    if (chunkCount === 0) {
      const message = 'No se generaron fragmentos: el archivo no tiene texto utilizable.';
      const { error } = await supabase
        .from('knowledge_documents')
        .update({ status: 'error', chunk_count: 0, error: message, updated_at: new Date().toISOString() })
        .eq('id', doc.id);
      if (error) throw error;
      return res.json({ status: 'error', chunkCount: 0, replaced: false });
    }

    const { error } = await supabase
      .from('knowledge_documents')
      .update({ status: 'ready', chunk_count: chunkCount, error: null, updated_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (error) throw error;

    await Bot.updateOne({ _id: bot._id }, { $inc: { knowledgeDocCount: 1 } });

    let replaced = false;
    if (doc.replaces_id) {
      const previous = await findOwnedDocument(doc.replaces_id, String(bot._id), req.user.id);
      if (previous) {
        try {
          await removeDocument(previous, bot._id);
          replaced = true;
        } catch (removeError) {
          // La versión nueva ya está lista; la anterior queda visible para borrarla a mano
          console.error('No se pudo borrar el documento reemplazado:', removeError);
        }
      }
    }

    return res.json({ status: 'ready', chunkCount, replaced });
  } catch (error) {
    console.error('Error al completar documento:', error);
    return res.status(500).json({ message: 'Error en el servidor al completar el documento.' });
  }
});

// ─── Listar y borrar ─────────────────────────────────────────────────────────

router.get('/:id/documents', authMiddleware, async (req, res) => {
  try {
    const bot = await findOwnedBot(req.params.id, req.user.id);
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    try {
      await expireStaleDocuments(String(bot._id), req.user.id);
    } catch (staleError) {
      // No impide listar: se reintenta en la siguiente consulta
      console.error('No se pudieron marcar los documentos atascados:', staleError);
    }

    const { data, error } = await getSupabase()
      .from('knowledge_documents')
      .select('id, filename, status, chunk_count, error, created_at, replaces_id')
      .eq('bot_id', String(bot._id))
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return res.json({
      documents: data.map((d) => ({
        id: d.id,
        filename: d.filename,
        status: d.status,
        chunkCount: d.chunk_count,
        error: d.error,
        createdAt: d.created_at,
        replacesId: d.replaces_id,
      })),
    });
  } catch (error) {
    console.error('Error al listar documentos:', error);
    return res.status(500).json({ message: 'Error en el servidor al obtener los documentos.' });
  }
});

router.delete('/:id/documents/:docId', authMiddleware, async (req, res) => {
  try {
    const bot = await findOwnedBot(req.params.id, req.user.id);
    if (!bot) {
      return res.status(404).json({ message: 'Bot no encontrado.' });
    }

    const doc = await findOwnedDocument(req.params.docId, String(bot._id), req.user.id);
    if (!doc) {
      return res.status(404).json({ message: 'Documento no encontrado.' });
    }

    await removeDocument(doc, bot._id);
    return res.json({ message: 'Documento eliminado.' });
  } catch (error) {
    console.error('Error al eliminar documento:', error);
    return res.status(500).json({ message: 'Error en el servidor al eliminar el documento.' });
  }
});

module.exports = router;
