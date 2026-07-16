// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
// Same pattern as unifi-network/handlers/crypto.ts and
// recipes/handlers/crypto.ts. Key source: req.crypto.key, built once by
// Core's own bootstrap script (backend/internal/modules/deno.go's
// loadPiiCrypto) and passed explicitly into every handler call - see
// types.ts's ModulePiiCrypto doc comment. Deliberately NOT read from an env
// var here (was Deno.env.get("MODULAB_ENCRYPTION_KEY") until 2026-07-16): a
// rename or rotation of the underlying key now needs zero changes in this
// file, since Core is the only place that ever reads it by name.
//
// Split out of handlers/index.ts into its own file 2026-07-16, to match the
// pattern the other two modules already used - purely cosmetic, no
// behavior change.

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
