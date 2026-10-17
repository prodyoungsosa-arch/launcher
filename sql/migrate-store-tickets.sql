-- FIX: recrear tablas de tickets/tienda con el esquema correcto
-- Ejecutar: mysql -u root -p malvinas < sql/migrate-store-tickets.sql
USE `malvinas`;

-- Si las tablas quedaron a medias, las recreamos limpias
DROP TABLE IF EXISTS ticket_messages;
DROP TABLE IF EXISTS tickets;

CREATE TABLE tickets (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  subject VARCHAR(200) NOT NULL,
  status ENUM('Abierto','En Proceso','Cerrado') NOT NULL DEFAULT 'Abierto',
  claimed_by INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ticket_user (user_id, status),
  INDEX idx_ticket_status (status, updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE ticket_messages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  content VARCHAR(2000) NOT NULL DEFAULT '',
  media_type ENUM('none','image','video','file') NOT NULL DEFAULT 'none',
  media_url VARCHAR(512) NULL,
  media_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tmsg_ticket (ticket_id, created_at),
  CONSTRAINT fk_tmsg_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
  INDEX idx_pack_active (active, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Asegurar columnas de store_packs si la tabla ya existía incompleta
-- (MySQL 8 no tiene IF NOT EXISTS en ADD COLUMN de forma portable; usamos procedure simple)

INSERT INTO store_packs (name, description, price, icon)
SELECT * FROM (
  SELECT 'Pack Soldado Raso' AS name, 'Arma secundaria, 3 cargadores y kit médico básico.' AS description, 5.00 AS price, 'shield' AS icon
  UNION ALL SELECT 'Pack Comando Táctico', 'Fusil de asalto, chaleco nivel 3 y brújula militar.', 12.50, 'lock'
  UNION ALL SELECT 'Membresía VIP Mensual', 'Acceso prioritario al servidor, kit VIP diario y color de chat exclusivo.', 20.00, 'star'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM store_packs LIMIT 1);
