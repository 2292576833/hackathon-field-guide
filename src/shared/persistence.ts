/** Parameterized SQL contracts; the coordinator wires a real PostgreSQL pool. */
export interface SqlResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

export interface DatabasePort extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
}
