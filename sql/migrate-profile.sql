USE `malvinas`;
-- Biografía de perfil
ALTER TABLE users ADD COLUMN bio VARCHAR(500) NULL AFTER avatar_url;
