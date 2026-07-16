// Type definitions mirroring the ModuLab Module SDK (modulab-module-sdk).
// Kept local so the module has no external dependencies at runtime.

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
  crypto: ModulePiiCrypto;
}

// ModulePiiCrypto carries the module-scoped PII encryption key material,
// built once by Core's bootstrap script (backend/internal/modules/deno.go's
// loadPiiCrypto) from MODULAB_MODULE_PII_KEY and passed explicitly into
// every handler call - never read from an env var or any global by this
// module's own code. key is null if the env var is unset or malformed on
// Core's side; module code must treat that as "not configured" (same
// contract getEncKey() -> null had before this was moved to Core).
export interface ModulePiiCrypto {
  key: CryptoKey | null;
  // hashKey (HMAC-SHA256) is only used by modules that need a deterministic
  // blind index alongside AES-GCM (e.g. unifi-network's mac_hash) - unused
  // here, kept for a uniform ModulePiiCrypto shape across modules.
  hashKey: CryptoKey | null;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

export interface ModuleDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}
