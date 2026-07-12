-- AI-based nutrition calculation: per-provider API key config, encrypted
-- entirely within this module (Nutzerentscheidung 2026-07-12: does NOT reuse
-- Core's backend/internal/ai/ai.go provider system — mirrors unifi-network's
-- gateways table pattern instead, own schema + own AES-256-GCM encryption via
-- MODULAB_ENCRYPTION_KEY, encrypted/decrypted only in handlers/crypto.ts).
--
-- One row per provider (openai/google/anthropic/deepseek); api_key_enc is
-- NULL-able only in the sense that a provider simply has no row until an
-- admin configures it via PUT /ai-providers/:provider.
CREATE TABLE IF NOT EXISTS ai_nutrition_providers (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider       TEXT        NOT NULL UNIQUE CHECK (provider IN ('openai', 'google', 'anthropic', 'deepseek')),
    api_key_enc    TEXT        NOT NULL,           -- AES-256-GCM verschlüsselt (base64)
    model          TEXT        NOT NULL,           -- z.B. "gpt-5.6", "gemini-3.1-flash-lite", "claude-haiku-4-5", "deepseek-v4-flash"
    enabled        BOOLEAN     NOT NULL DEFAULT true,
    is_default     BOOLEAN     NOT NULL DEFAULT false,
    created_by_enc TEXT        NOT NULL,           -- AES-256-GCM verschlüsselt (base64), E-Mail des Admins
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one default provider at a time (used when POST .../nutrition/ai
-- is called without an explicit provider).
CREATE UNIQUE INDEX IF NOT EXISTS ai_nutrition_providers_one_default_idx
    ON ai_nutrition_providers (is_default) WHERE is_default;

-- Allow 'ai' as a nutrition_source alongside the existing 'manual' /
-- 'off' (unused since 2026-07-03, see handlers/index.ts) / 'calculated'.
ALTER TABLE recipes DROP CONSTRAINT IF EXISTS recipes_nutrition_source_check;
ALTER TABLE recipes ADD CONSTRAINT recipes_nutrition_source_check
    CHECK (nutrition_source IN ('manual', 'off', 'calculated', 'ai'));
