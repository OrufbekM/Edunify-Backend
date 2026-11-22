export function assertTestDatabase(databaseUrl: string | undefined): void {
  const name = databaseUrl ? URL.parse(databaseUrl)?.pathname.slice(1) : undefined;

  if (!name?.endsWith('_test')) {
    throw new Error('Refusing to run: DATABASE_URL must name a database ending in _test');
  }
}
