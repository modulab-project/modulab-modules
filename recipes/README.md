# Recipes

A recipe collection with a weekly meal plan.

## Overview

Recipes is a self-hosted recipe manager: keep your recipes with ingredients, step-by-step instructions, tags, and categories, then plan your week by dropping recipes into a meal-plan grid (breakfast/lunch/dinner/snack, Monday to Sunday).

- **Recipes** — title, image, ingredients, steps, tags, category, and notes.
- **Portion calculator** — recalculates ingredient quantities and nutrition for any number of servings, based on the nutrition values you enter per ingredient or the AI-estimated per-serving totals.
- **AI nutrition estimation** — optionally configure an API key for OpenAI, Google Gemini, Anthropic Claude, or DeepSeek under the module's own Settings tab (Admin only), then estimate a recipe's nutrition from its title, servings, and ingredient list with one click. Fully optional — the module works without any AI provider configured, falling back to manual entry / the ingredient-based portion calculator.
- **Meal plan** — a weekly grid; assign any recipe to a day and slot.
- **Tags & categories** — flexible organization on top of the recipe list, with search and filtering.

## Details

- **Tier:** 3 (sandboxed Deno handler, own database schema)
- **Scope:** per-location — each ModuLab location gets its own independent recipe collection
- **Category:** Productivity
- **Storage:** database + uploaded recipe images
- **External calls:** only when AI nutrition estimation is configured and triggered — outbound HTTPS to whichever provider(s) an Admin has set up (`api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`, `api.deepseek.com`; see `egress_allowlist` in `manifest.yaml`). API keys are AES-256-GCM encrypted and stored entirely inside this module's own database schema — never sent to or stored by ModuLab Core.

## License

AGPL-3.0, part of the [ModuLab](https://github.com/modulab-project/modulab-modules) official module collection.
