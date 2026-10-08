import { join } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // DuckDB ships a native binding; keep it out of the bundle and trace the platform library
  // (libduckdb.so) into every API function explicitly, since it is loaded via dlopen.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  outputFileTracingRoot: join(import.meta.dirname, ".."),
  outputFileTracingIncludes: {
    "/api/**/*": ["../node_modules/.pnpm/@duckdb+node-bindings-linux-x64@*/node_modules/@duckdb/node-bindings-linux-x64/**/*"],
  },
};

export default config;
