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
  storage: ModuleStorageClient;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

export interface ModuleDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ModuleStorageClient {
  write(path: string, data: Uint8Array, contentType: string): Promise<void>;
  delete(path: string): Promise<void>;
  url(path: string): string;
}
