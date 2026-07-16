// ── Encryption & hashing helpers ─────────────────────────────────────────────
//
// AES-256-GCM: same pattern as modulab-modules/my-place/handlers/index.ts.
// Key source: req.crypto.key / ctx.crypto.key, built once by Core's own
// bootstrap script (backend/internal/modules/deno.go's loadPiiCrypto) and
// passed explicitly into every handler/job call - see types.ts's
// ModulePiiCrypto doc comment. No env var read here at all (was
// Deno.env.get("MODULAB_ENCRYPTION_KEY"), then MODULAB_MODULE_PII_KEY, until
// 2026-07-16).
//
// HMAC-SHA256 blind index: additional to my-places' pattern. MAC addresses are
// stored GCM-encrypted (probabilistic — no two ciphertexts of the same MAC are
// equal), so a plain `WHERE mac_enc = ...` / JOIN on mac_enc is impossible.
// mac_hash is a deterministic HMAC of the sanitized MAC, used only for equality
// lookups/joins. It must never be used to derive or guess the plaintext MAC —
// it is a blind index, not a substitute for mac_enc.
//
// Reuses the same raw key material as req.crypto.key (no separate
// MODULAB_UNIFI_MAC_HASH_KEY) - see req.crypto.hashKey, imported by Core's
// bootstrap script from the same raw bytes for the HMAC algorithm.
// Rationale: in this deployment's threat model, a compromised PII key
// already means total loss (it decrypts every GCM field across Core), so a
// second key would add key-management overhead without closing an
// additional attack path. See Entscheidungsvorlage, Abschnitt 2
// ("MAC-Matching-Lösung: deterministischer Blind-Index") for the accepted
// trade-offs (OUI rainbow-table risk if the DB dump and this key are
// compromised together).

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

export async function macHash(key: CryptoKey, sanitizedMac: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sanitizedMac));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── MAC sanitizer (Entscheidungsvorlage Abschnitt 4.5) ───────────────────────
//
// Called at every entry point (form submit AND again at the start of the
// gateway loop, defense in depth) before any DB or API call. Strips all
// separators/whitespace, lowercases, and re-formats to aa:bb:cc:dd:ee:ff.
// Throws if the result is not exactly 12 hex characters.

export class InvalidMacError extends Error {
  constructor(input: string) {
    super(`Invalid MAC address: "${input}" does not resolve to exactly 12 hex characters`);
    this.name = "InvalidMacError";
  }
}

export function sanitizeMac(input: string): string {
  const stripped = input.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (stripped.length !== 12 || !/^[0-9a-f]{12}$/.test(stripped)) {
    throw new InvalidMacError(input);
  }
  return stripped.match(/.{2}/g)!.join(":");
}
