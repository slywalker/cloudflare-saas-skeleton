import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// テストは workerd (miniflare) 上で実行する (@cloudflare/vitest-pool-workers)。
// wrangler.jsonc をそのまま読ませると database_id/KV id が "TODO" のままの
// 未設定バインディング (DB_CONTROL, KV 等) まで含めて起動を試み、テストに
// 不要な依存(実 D1 作成やアカウント設定)を持ち込んでしまう。そのため
// wrangler.jsonc は参照せず、テストが実際に必要とする最小限のバインディング
// (applyPendingMigrations のテストで使う D1) のみをここで直接定義する。
export default defineWorkersConfig({
  test: {
    include: ["src/**/*.test.ts"],
    poolOptions: {
      workers: {
        miniflare: {
          // @cloudflare/vitest-pool-workers はテスト専用に独自バージョンの
          // miniflare/workerd を内部依存として持つ (プロジェクト本体の wrangler とは
          // 別物。CLAUDE.md「依存管理」参照)。wrangler.jsonc の compatibility_date
          // (2026-08-11) をそのまま指定すると、この内部 workerd の対応上限を
          // 超えてしまう。指定しなければ内部 workerd がサポートする上限日付へ
          // 自動的にフォールバックされ、着地する挙動自体は明示指定と変わらない
          // (フォールバック時に警告ログが出るだけ)。ここで明示しているのは
          // その警告を抑止するためであり、値を固定しないと動かないわけではない。
          // `@cloudflare/vitest-pool-workers` を更新した際は、内部 workerd の
          // 対応上限も変わりうるため、この日付を見直すこと (放置しても動作は
          // 変わらないが、警告が復活する)。
          compatibilityDate: "2026-03-10",
          // wrangler.jsonc (本体) の compatibility_flags と揃える。nodejs_compat
          // 前提のコード (Node組み込みモジュール利用等) をテストで動かす場合に
          // 必要。
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB_TENANT_LOCAL"],
        },
      },
    },
  },
});
