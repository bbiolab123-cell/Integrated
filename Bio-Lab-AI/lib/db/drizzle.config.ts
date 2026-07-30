import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// A path built with path.join(__dirname, ...) resolves to backslashes on
// Windows, which drizzle-kit's glob-based schema resolution can't match —
// it reports "No schema files found" even though the file exists. A plain
// relative (POSIX-style) string, resolved by drizzle-kit itself against this
// config file's own directory, works on every OS.
export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
