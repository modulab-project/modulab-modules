# UniFi Network

Manage RADIUS-based MAC authentication, dynamic VLAN assignment, and live connection status across multiple independent UniFi gateways.

## Overview

UniFi Network centralizes device onboarding and network access control for one or more UniFi gateways. Instead of managing RADIUS/MAC entries separately on each controller, you manage them once in ModuLab, and the module keeps every configured gateway in sync.

- **Multi-gateway** — connect any number of independent UniFi gateways; each is polled and managed on its own.
- **Device onboarding** — users submit a device (MAC address, note, target VLAN); an admin approves or rejects it before it's actually provisioned on the gateways.
- **Change requests** — once a device is active, non-admin edits/deletes go through the same approve/reject flow instead of applying immediately, so network-affecting changes always get an admin's sign-off.
- **Live status** — a per-minute background job polls all gateways in parallel for VLANs, RADIUS accounts, users, and client history, and surfaces connection status and errors per gateway.
- **Note discrepancy detection** — if a device's note is edited directly in a gateway's own UI instead of through ModuLab, the module detects the mismatch and offers a one-click resolution.

## Setup

An admin adds each UniFi gateway with its base URL and an API key from that controller. The module only ever talks to the private IP addresses of gateways you've explicitly configured — its network access is re-scoped automatically every time a gateway is added, changed, or removed.

## Details

- **Tier:** 2 (sandboxed Deno handler, own database schema)
- **Scope:** per-location
- **Category:** Network
- **Storage:** database (gateway credentials stored AES-256-GCM encrypted)
- **External calls:** only to the private IP addresses of gateways configured by an admin; TLS certificate verification is relaxed for exactly those hosts (UniFi controllers on private IPs typically use self-signed certificates)
- **Permissions:** gateway management is Super-Admin/Org-Admin only; any authenticated user can submit a device for onboarding

## License

AGPL-3.0, part of the [ModuLab](https://github.com/modulab-project/modulab-modules) official module collection.
