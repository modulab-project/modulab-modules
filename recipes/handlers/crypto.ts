// ── Encryption helpers ───────────────────────────────────────────────────────
//
// AES-256-GCM, same pattern as unifi-network/handlers/crypto.ts and
// my-place/handlers/index.ts. Key source: MODULAB_ENCRYPTION_KEY env var
// (64 hex chars = 32 bytes), set by Core and passed into every Deno worker's
// environment (see Core's deno.go moduleEnv). No module-specific key: a
// compromised MODULAB_ENCRYPTION_KEY already means total loss across every
// module that uses it, so a second key would add key-management overhead
// without closing an additional attack path (same rationale as
// unifi-network).
//
// Used to encrypt the AI provider API keys stored in
// ai_nutrition_providers.api_key_enc (see migrations/0003_ai_nutrition.sql)
// — these keys never touch Core, they are managed entirely inside this
// module (Nutzerentscheidung 2026-07-12: no reuse of Core's
// backend/internal/ai/ai.go provider system).

let _cachedEncKey: CryptoKey | null = null;

function hexToBytes(hexKey: string): Uint8Array | null {
  if (hexKey.length !== 64) return null;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

export async function getEncKey(): Promise<CryptoKey | null> {
  if (_cachedEncKey) return _cachedEncKey;
  const raw = hexToBytes(Deno.env.get("MODULAB_ENCRYPTION_KEY") ?? "");
  if (!raw) return null;
  _cachedEncKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return _cachedEncKey;
}

export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

export async function decrypt(key: CryptoKey, ciphertext: string): Promise<string> {
  const buf = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return new TextDecoder().decode(pt);
}
