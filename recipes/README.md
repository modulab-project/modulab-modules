# Recipes

A recipe collection with a weekly meal plan.

## Overview

Recipes is a self-hosted recipe manager: keep your recipes with ingredients, step-by-step instructions, tags, and categories, then plan your week by dropping recipes into a meal-plan grid (breakfast/lunch/dinner/snack, Monday to Sunday).

- **Recipes** — title, image, ingredients, steps, tags, and category.
- **Portion calculator** — recalculates ingredient quantities and nutrition for any number of servings, based on the nutrition values you enter per ingredient (no external nutrition database lookup).
- **Meal plan** — a weekly grid; assign any recipe to a day and slot.
- **Tags & categories** — flexible organization on top of the recipe list, with search and filtering.

## Details

- **Tier:** 2 (sandboxed Deno handler, own database schema)
- **Scope:** per-location — each ModuLab location gets its own independent recipe collection
- **Category:** Productivity
- **Storage:** database + uploaded recipe images
- **External calls:** none — the module makes no outbound network requests; nutrition values are entered manually and all calculations happen locally

## License

AGPL-3.0, part of the [ModuLab](https://github.com/modulab-project/modulab-modules) official module collection.
