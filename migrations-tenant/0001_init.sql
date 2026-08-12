-- テナント D1 の初期マイグレーション。
-- 各テナントのプロビジョニング時 (POST /api/tenants) に REST API 経由で適用される。
-- 中央 D1 (drizzle-kit 管理) とは別系統: テナント DB は動的作成のため
-- drizzle-kit の対象外とし、プレーン SQL で手動管理する。

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_created_at ON items (created_at);
