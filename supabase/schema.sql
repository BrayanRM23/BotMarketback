-- Esquema RAG de BotMarket. Ejecutar en el SQL Editor de Supabase.
-- Es idempotente: sirve para una instalación nueva y para actualizar una existente.
-- Dimensión de embeddings: 768 (gemini-embedding-001 con outputDimensionality = 768).

begin;

create extension if not exists vector with schema extensions;

-- ── Documentos subidos por el usuario ───────────────────────────────────────
create table if not exists knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  bot_id text not null,
  user_id text not null,
  filename text not null,
  storage_path text not null,
  mime_type text,
  status text not null default 'processing' check (status in ('processing', 'ready', 'error')),
  chunk_count int not null default 0,
  error text,
  created_at timestamptz not null default now()
);

-- Última actividad de la carga: sirve para detectar documentos atascados en 'processing'
alter table knowledge_documents add column if not exists updated_at timestamptz not null default now();
-- Documento al que reemplaza: se borra solo cuando este queda en 'ready'
alter table knowledge_documents add column if not exists replaces_id uuid;

create index if not exists knowledge_documents_bot_id_idx on knowledge_documents (bot_id);

-- ── Fragmentos con embedding y texto completo ───────────────────────────────
create table if not exists knowledge_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references knowledge_documents (id) on delete cascade,
  bot_id text not null,
  chunk_index int not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  fts tsvector generated always as (to_tsvector('spanish', content)) stored,
  embedding extensions.vector(768) not null
);

-- Lote de carga al que pertenece el fragmento: permite reintentar un lote sin duplicar
alter table knowledge_chunks add column if not exists batch_index int not null default 0;

create index if not exists knowledge_chunks_bot_id_idx on knowledge_chunks (bot_id);
create index if not exists knowledge_chunks_fts_idx on knowledge_chunks using gin (fts);
create index if not exists knowledge_chunks_document_batch_idx on knowledge_chunks (document_id, batch_index);

-- Sin políticas: la anon key no puede leer nada. El backend usa la service_role key, que ignora RLS.
alter table knowledge_documents enable row level security;
alter table knowledge_chunks enable row level security;

-- ── Bucket privado para los archivos originales ─────────────────────────────
insert into storage.buckets (id, name, public)
values ('knowledge-files', 'knowledge-files', false)
on conflict (id) do nothing;

-- ── Búsqueda híbrida (vectorial + palabras clave) fusionada con RRF ─────────
-- Solo considera fragmentos de documentos en estado 'ready'.
-- query_embedding puede ser null: entonces solo se usan palabras clave y `similarity` es null.
-- La consulta de texto usa OR entre términos: una pregunta en lenguaje natural
-- casi nunca contiene todas sus palabras en un mismo fragmento.
-- Se borra antes porque cambió el tipo de retorno (create or replace no lo permite).
drop function if exists match_knowledge(text, text, extensions.vector, int, int);

create function match_knowledge(
  p_bot_id text,
  query_text text,
  query_embedding extensions.vector(768) default null,
  match_count int default 6,
  rrf_k int default 50
)
returns table (
  chunk_id bigint,
  doc_id uuid,
  doc_filename text,
  doc_status text,
  chunk_bot_id text,
  chunk_content text,
  chunk_metadata jsonb,
  relevance float,
  similarity float
)
language sql stable
as $$
with q as (
  select replace(plainto_tsquery('spanish', query_text)::text, '&', '|')::tsquery as tsq
),
ready_chunks as (
  select c.id, c.fts, c.embedding
  from knowledge_chunks c
  join knowledge_documents d on d.id = c.document_id
  where c.bot_id = p_bot_id
    and d.status = 'ready'
),
ft as (
  select rc.id, row_number() over (order by ts_rank_cd(rc.fts, q.tsq) desc) as r
  from ready_chunks rc
  cross join q
  where rc.fts @@ q.tsq
  order by ts_rank_cd(rc.fts, q.tsq) desc
  limit least(match_count, 30) * 2
),
sem as (
  select rc.id, row_number() over (order by rc.embedding <=> query_embedding) as r
  from ready_chunks rc
  where query_embedding is not null
  order by rc.embedding <=> query_embedding
  limit least(match_count, 30) * 2
)
select
  c.id,
  c.document_id,
  d.filename,
  d.status,
  c.bot_id,
  c.content,
  c.metadata,
  (coalesce(1.0 / (rrf_k + ft.r), 0) + coalesce(1.0 / (rrf_k + sem.r), 0))::float as relevance,
  case
    when query_embedding is null then null
    else (1 - (c.embedding <=> query_embedding))::float
  end as similarity
from ft
full outer join sem on ft.id = sem.id
join knowledge_chunks c on c.id = coalesce(ft.id, sem.id)
join knowledge_documents d on d.id = c.document_id
order by relevance desc
limit least(match_count, 30);
$$;

commit;
