// ── Egress-hosts query job ─────────────────────────────────────────────────
//
// Dispatched by Core as the reserved job "__compute_egress_hosts__"
// (backend/internal/modules/jobs.go: egressHostsJobName) whenever a manifest
// sets both `dynamic_egress: true` and `egress_hosts_handler` — see
// Manifest.EgressHostsHandler's doc comment in installer.go for the full
// motivation.
//
// Why this exists as a separate job instead of just calling
// computeEgressHosts() from Core directly: Core has no business knowing
// this module's encryption scheme or DB schema (gateways.base_url_enc) —
// only the module itself can decrypt its own rows. This job is the module
// answering Core's question "what hosts do you currently need?" using its
// own DB state, so the answer is always correct even right after a Core
// process restart, when there is no previously-running worker Core could
// otherwise ask (that case — a module *update* while a worker is already
// running — is handled differently, via WorkerPool.CurrentModuleEgressHosts
// in deno.go, which this job does NOT replace).
//
// Unlike the scheduled `poll_gateways` job, this one returns a value (a
// string[] of hostnames) rather than void — see deno.go's bootstrap script
// comment on job handlers optionally returning a response body.
import type { JobContext } from "../handlers/types.ts";
import { computeEgressHosts } from "../handlers/index.ts";

export default async function ({ db, crypto }: JobContext): Promise<string[]> {
  return computeEgressHosts(db, crypto.key);
}
