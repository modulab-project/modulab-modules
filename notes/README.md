# Notes

A simple, private notepad.

## Overview

Notes is a Tier 1 (config-driven CRUD) module: it ships only `manifest.yaml`
and `migrations/0001_initial.sql`, no handler code and no `ui/bundle.js`.
Core generates the REST API and the list/edit UI directly from the `crud`
block in the manifest.

- **Title + body** — one required title, one optional body.
- **Private by default** — `owner_scoped: true` in the manifest means every
  note is strictly visible only to the user who created it, including
  admins. There is no shared/team view.
- **Body is encrypted at rest** — the `body` field is declared
  `encrypted: true`, so it is stored AES-256-GCM encrypted and transparently
  decrypted on read.

## Details

See modulab-module-sdk's `GUIDE.md`, chapter "Tier 1: config-driven CRUD",
for how the generated API and UI work.
