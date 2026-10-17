-- Malvinas 1982 Launcher — esquema completo
-- Ejecutar en MySQL: mysql -u root malvinas-db < sql/schema.sql

CREATE DATABASE IF NOT EXISTS `malvinas-db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `malvinas-db`;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL UNIQUE,
  email VARCHAR(120) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('user', 'admin', 'dev') NOT NULL DEFAULT 'user',
  display_name VARCHAR(48) NULL,
  avatar_url VARCHAR(512) NULL,
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
