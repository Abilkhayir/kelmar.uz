CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL
);
-- state: 0 = to'lov kutilmoqda, 1 = to'langan, -1 = qaytarilgan
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, amount INTEGER NOT NULL,      -- amount tiyinda
  state INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
-- state: 1 = yaratilgan, 2 = bajarilgan, -1 = bekor (to'lovdan oldin), -2 = qaytarilgan (to'lovdan keyin)
CREATE TABLE IF NOT EXISTS transactions (
  payme_id TEXT PRIMARY KEY, order_id INTEGER NOT NULL,
  time INTEGER NOT NULL, amount INTEGER NOT NULL,
  create_time INTEGER NOT NULL, perform_time INTEGER NOT NULL DEFAULT 0, cancel_time INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL, reason INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(time);
