// Type definitions mirroring the ModuLab Module SDK (modulab-module-sdk).
// Kept local so the module has no external dependencies at runtime.
// Identical to recipes/handlers/types.ts - shared shape across every Tier
// 2/3 module's handler entry point, not specific to this module.

export interface ModuleAuthContext {
  userId: string;
  userEmail: string;
  userName: string;
  roles: string[];
  scopes: string[];
}

export interface HandlerRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  auth: ModuleAuthContext;
  credentials?: Record<string, string>;
  db: ModuleDbClient;
  // crypto.key stays the OLD raw shared key (unchanged from before this
  // module's PII rotation feature existed) until POST /admin/migrate-pii-key
  // has re-encrypted every PII column and Core records pii_migrated_at (see
  // docs/Modul-DB-Sandbox_Plan_2026-08-02.md Part B) - only THEN does it
  // switch to this module's own derived key. Never assume crypto.key is
  // already the derived key.
  crypto: ModulePiiCrypto;
  // legacyCrypto carries this module's NEW derived key, granted only during
  // that same pre-migration window, purely as the re-encryption target for
  // the migrate-pii-key handler below - key/hashKey are both null once
  // migration is done. Nothing in this module should read legacyCrypto
  // anywhere except that one migration handler.
  legacyCrypto: ModulePiiCrypto;
}

// ModulePiiCrypto carries the module-scoped PII encryption key material,
// built once by Core's bootstrap script (backend/internal/modules/deno.go's
// loadPiiCrypto) from MODULAB_MODULE_PII_KEY and passed explicitly into
// every handler call - never read from an env var or any global by this
// module's own code. key is null if the env var is unset or malformed on
// Core's side; module code must treat that as "not configured".
export interface ModulePiiCrypto {
  key: CryptoKey | null;
  // hashKey (HMAC-SHA256) is unused here, kept for a uniform ModulePiiCrypto
  // shape across modules.
  hashKey: CryptoKey | null;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

export interface ModuleDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}
