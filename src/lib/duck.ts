import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/** Open a DuckDB database (in-memory by default), run `fn`, and always close it. */
export async function withDuck<T>(fn: (db: DuckDBConnection) => Promise<T>, path = ":memory:"): Promise<T> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    return await fn(conn);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

export async function queryRows<T = Record<string, unknown>>(db: DuckDBConnection, sql: string): Promise<T[]> {
  const reader = await db.runAndReadAll(sql);
  return reader.getRowObjectsJson() as T[];
}
