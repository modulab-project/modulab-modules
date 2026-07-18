# My Places

Save and explore your favourite places — restaurants, beaches, hotels, sights, and more — on an interactive map.

## Overview

My Places lets you build a personal (or shared, per-location) catalog of places you care about, organized into trips and categories, with photos attached to each entry. Everything is shown on an interactive map so you can see at a glance where things are.

- **Spots** — the core entity: a place with a name, location, category, notes, and photos.
- **Trips** — group spots together (e.g. "Summer 2026 in Portugal").
- **Categories** — organize spots by type (restaurant, beach, hotel, sight, ...); you start with an empty list and create your own.
- **Photos** — attach one or more photos to a spot.

## Setup

The interactive map is powered by [MapTiler](https://www.maptiler.com/). An admin needs to add a free MapTiler API key in the module's settings before the map will render — everything else (creating spots, trips, categories) works without any external service.

## Details

- **Tier:** 2 (sandboxed Deno handler, own database schema)
- **Scope:** per-location — each ModuLab location gets its own independent set of places
- **Category:** Lifestyle
- **Storage:** database + uploaded photos
- **External calls:** only to MapTiler, for map tiles (once configured)

## License

AGPL-3.0, part of the [ModuLab](https://github.com/modulab-project/modulab-modules) official module collection.
