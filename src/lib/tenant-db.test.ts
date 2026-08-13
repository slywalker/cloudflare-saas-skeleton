import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./tenant-db";

describe("splitSqlStatements", () => {
  it("複数のCREATE文をセミコロンで分割する", () => {
    const sql = "CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);";
    expect(splitSqlStatements(sql)).toEqual([
      "CREATE TABLE a (id INTEGER)",
      "CREATE TABLE b (id INTEGER)",
    ]);
  });

  it("行コメント (--) を除去してから分割する (行全体が -- で始まる行のみ対象)", () => {
    const sql = [
      "-- これはコメント",
      "CREATE TABLE a (id INTEGER);",
      "-- 別のコメント行",
      "CREATE TABLE b (id INTEGER);",
    ].join("\n");
    expect(splitSqlStatements(sql)).toEqual([
      "CREATE TABLE a (id INTEGER)",
      "CREATE TABLE b (id INTEGER)",
    ]);
  });

  it("ファイル冒頭のコメント行に続く最初のCREATE文を消さない (旧バグの回帰)", () => {
    const sql = ["-- ファイル冒頭のコメント", "CREATE TABLE a (id INTEGER);"].join("\n");
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE a (id INTEGER)"]);
  });

  it("空文字列の場合は空配列を返す", () => {
    expect(splitSqlStatements("")).toEqual([]);
  });

  it("コメント行のみの場合は空配列を返す", () => {
    expect(splitSqlStatements("-- コメントのみ\n-- もう一行")).toEqual([]);
  });

  it("空文 (連続するセミコロンや前後の空白) を除去する", () => {
    const sql = "  ;;\nCREATE TABLE a (id INTEGER);;  \n  ;";
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE a (id INTEGER)"]);
  });

  it("文中の改行を保持したまま分割する", () => {
    const sql = "CREATE TABLE a (\n  id INTEGER,\n  name TEXT\n);";
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE a (\n  id INTEGER,\n  name TEXT\n)"]);
  });
});
