-- Mejoras red social: emojis libres + respuestas a comentarios
USE `malvinas-db`;

-- Reacciones: cualquier emoji (no solo like/fire/…)
ALTER TABLE announcement_reactions
  MODIFY COLUMN reaction VARCHAR(16) NOT NULL;

-- Una sola reacción por usuario por anuncio
-- (si falla por duplicados previos, limpiá antes)
ALTER TABLE announcement_reactions
  DROP INDEX uq_reaction;

ALTER TABLE announcement_reactions
  ADD UNIQUE KEY uq_user_ann (announcement_id, user_id);

-- Respuestas en hilos
ALTER TABLE announcement_comments
  ADD COLUMN parent_id INT NULL DEFAULT NULL AFTER user_id;

ALTER TABLE announcement_comments
  ADD KEY idx_cmt_parent (parent_id);
