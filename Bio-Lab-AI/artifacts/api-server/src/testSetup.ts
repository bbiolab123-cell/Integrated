// Unit tests never contact Postgres, but the shared database package validates
// its configuration at module load. Provide an unreachable local placeholder
// when a test runner has not supplied DATABASE_URL explicitly.
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/biolab_test";
