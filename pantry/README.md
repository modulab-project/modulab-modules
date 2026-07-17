# Pantry

A household pantry/stock inventory: what you have, how much, where it's stored, and when it expires.

## Overview

- **Items** — name, category, quantity, unit, storage location (free text, e.g. "Cellar", "Fridge"), expiry date, minimum stock level, notes.
- **Low-stock and expiry indicators** — items below their configured minimum stock, or expiring within a few days, are flagged in the list without any extra configuration.
- **AI receipt scanning** — optionally configure an API key for OpenAI, Google Gemini, or Anthropic Claude under the module's own Settings tab (Admin only), then photograph a receipt and let the configured provider suggest a list of items (name, quantity, unit, category guess) to add in one batch. Fully optional — the module works entirely without any AI provider configured, via manual entry.
- **Categories** — flexible, admin-managed list for organizing and filtering items.

## Details

- **Tier:** 3 (sandboxed Deno handler, own database schema, outbound network access to AI providers)
- **Category:** Productivity
- **Storage:** database + uploaded receipt photos
- **External calls:** only when AI receipt scanning is configured and triggered — outbound HTTPS to whichever provider an Admin has set up (`api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`; see `egress_allowlist` in `manifest.yaml`). API keys are AES-256-GCM encrypted and stored entirely inside this module's own database schema — never sent to or stored by ModuLab Core.

## License

AGPL-3.0, part of the [ModuLab](https://github.com/modulab-project/modulab-modules) official module collection.
