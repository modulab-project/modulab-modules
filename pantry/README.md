# Pantry

A household pantry/stock inventory: what you have, how much, where it's stored, and when it expires.

## Overview

- **Items are products, batches are purchases** — an item (e.g. "Milk") is created once per distinct product: name, category, unit, minimum stock level, notes. Quantity, expiry date, and storage location live on that item's batches instead, since a household routinely buys the same product more than once with a different best-before date each time (e.g. steaks bought Jan 1 and again Apr 1 — same item, two batches). An item can have any number of batches.
- **Storage locations** — admin-managed list (e.g. "Cellar", "Fridge"), same concept as categories below, not free text. Each batch is assigned a location from that list.
- **Low-stock and expiry indicators** — items whose batch quantities sum below their configured minimum stock, or batches expiring within a few days, are flagged in the list without any extra configuration.
- **AI receipt scanning** — optionally configure an API key for OpenAI, Google Gemini, or Anthropic Claude under the module's own Settings tab (Admin only), then photograph a receipt and let the configured provider suggest a list of items (name, quantity, unit, category guess) to add in one batch. Fully optional — the module works entirely without any AI provider configured, via manual entry.
- **Categories** — flexible, admin-managed list for organizing and filtering items. Empty on first start; admins build it up themselves (no seeded categories).

## Details

- **Tier:** 3 (sandboxed Deno handler, own database schema, outbound network access to AI providers)
- **Category:** Productivity
- **Storage:** database + uploaded receipt photos
- **External calls:** only when AI receipt scanning is configured and triggered — outbound HTTPS to whichever provider an Admin has set up (`api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`; see `egress_allowlist` in `manifest.yaml`). API keys are AES-256-GCM encrypted and stored entirely inside this module's own database schema — never sent to or stored by ModuLab Core.

## License

AGPL-3.0, part of the [ModuLab](https://github.com/modulab-project/modulab-modules) official module collection.
