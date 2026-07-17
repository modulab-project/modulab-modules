// ── Encryption helpers ───────────────────────────────────────────────────────
//
// AES-256-GCM, same pattern as recipes/handlers/crypto.ts and
// unifi-network/handlers/crypto.ts. Key source: req.crypto.key, built once by
// Core's own bootstrap script (backend/internal/modules/deno.go's
// loadPiiCrypto) and passed explicitly into every handler call - see
// types.ts's ModulePiiCrypto doc comment. No module-specific key: a
// compromised key already means total loss across every module that uses
// it, so a second key would add key-management overhead without closing an
// additional attack path.
//
// Used to encrypt the AI provider API keys stored in
// ai_pantry_providers.api_key_enc (see migrations/0001_initial.sql) - these
// keys never touch Core, they are managed entirely inside this module
// (project decision 2026-07-18: modules build their own AI logic/credentials
// rather than reusing Core's backend/internal/ai/ai.go provider system).

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
