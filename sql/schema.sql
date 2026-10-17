-- Malvinas 1982 Launcher — esquema completo
-- Ejecutar en MySQL: mysql -u root malvinas < sql/schema.sql

CREATE DATABASE IF NOT EXISTS `malvinas` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `malvinas`;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  email VARCHAR(120) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('user', 'admin', 'dev') NOT NULL DEFAULT 'user',
  display_name VARCHAR(48) NULL,
  avatar_url VARCHAR(512) NULL,
  bio VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Si ya tenías users sin role:
-- ALTER TABLE users ADD COLUMN role ENUM('user','admin','dev') NOT NULL DEFAULT 'user';
-- ALTER TABLE users ADD COLUMN display_name VARCHAR(48) NULL;
-- ALTER TABLE users ADD COLUMN avatar_url VARCHAR(512) NULL;

CREATE TABLE IF NOT EXISTS announcements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  author_id INT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  category VARCHAR(64) NOT NULL DEFAULT 'Novedad',
  sections JSON NULL COMMENT '["ACTUALIZACION","CHERNARUS"]',
  media_type ENUM('none','image','video','link','file') NOT NULL DEFAULT 'none',
  media_url VARCHAR(1024) NULL,
  media_name VARCHAR(255) NULL,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ann_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ann_created (created_at DESC),
  INDEX idx_ann_pinned (pinned DESC, created_at DESC)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS announcement_reactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  announcement_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  reaction ENUM('like','fire','heart','clap','wow') NOT NULL DEFAULT 'like',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reaction (announcement_id, user_id, reaction),
  CONSTRAINT fk_react_ann FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  CONSTRAINT fk_react_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS announcement_comments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  announcement_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  content VARCHAR(1000) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cmt_ann FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_cmt_ann (announcement_id, created_at)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS store_packs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  icon VARCHAR(32) NOT NULL DEFAULT 'shield',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pack_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_pack_active (active, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tickets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  subject VARCHAR(200) NOT NULL,
  status ENUM('Abierto','En Proceso','Cerrado') NOT NULL DEFAULT 'Abierto',
  claimed_by INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ticket_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_claim FOREIGN KEY (claimed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_ticket_user (user_id, status),
  INDEX idx_ticket_status (status, updated_at DESC)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  content VARCHAR(2000) NOT NULL DEFAULT '',
  media_type ENUM('none','image','video','file') NOT NULL DEFAULT 'none',
  media_url VARCHAR(512) NULL,
  media_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tmsg_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_tmsg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_tmsg_ticket (ticket_id, created_at)
) ENGINE=InnoDB;

-- Packs de ejemplo (solo si la tabla está vacía)
INSERT INTO store_packs (name, description, price, icon)
SELECT * FROM (
  SELECT 'Pack Soldado Raso' AS name, 'Arma secundaria, 3 cargadores y kit médico básico.' AS description, 5.00 AS price, 'shield' AS icon
  UNION ALL SELECT 'Pack Comando Táctico', 'Fusil de asalto, chaleco nivel 3 y brújula militar.', 12.50, 'lock'
  UNION ALL SELECT 'Membresía VIP Mensual', 'Acceso prioritario al servidor, kit VIP diario y color de chat exclusivo.', 20.00, 'star'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM store_packs LIMIT 1);

-- Primer admin (password: Admin123!). Cambiá la contraseña después.
-- Hash bcrypt de "Admin123!" (cost 10):
INSERT INTO users (username, email, password, role, display_name)
VALUES (
  'admin',
  'admin@malvinas.local',
  '$2b$10$K9UiGSgIALU2pP02g4OGSeV8oZQzxXewyxBv/9BZmmGxS2Rby77y.',
  'admin',
  'Administración'
) ON DUPLICATE KEY UPDATE role = 'admin';
