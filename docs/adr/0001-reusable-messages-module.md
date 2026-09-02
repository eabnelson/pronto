---
status: accepted
---

# Pronto ships a reusable Messages module and an independent product

Pronto publishes one versioned in-process Messages module as the source of truth for provider RPC lifecycle, qualification, normalization, exact routing, scoped history and attachments, watch recovery, and delivery outcomes. The independently installable Pronto agent product and external consumers use that module; consumers keep activation, authorization, identity, and product state outside it. This avoids both a second daemon boundary, which would complicate macOS permissions and deployment, and source vendoring, which previously allowed the implementations to diverge.

## Consequences

The module owns provider-mechanical checkpoints and recovery behind its interface, while a consumer owns its canonical product effects and may correlate operations with opaque values. Consumers pin released versions, and local development may link a sibling checkout. Pronto never imports consumer packages or models consumer domain concepts.

Activation remains consumer policy: the standalone product applies its configured tags and Studio Four applies Channel bindings. Pronto owns capability detection and a shared safe `imsg` floor while allowing consumers to require stricter profiles without downgrade. The first module is specifically for local Apple Messages rather than a speculative provider-neutral framework.

Generic behavior extracted from a private consumer enters Pronto only as reviewed snapshots in clean public commits, with private imports, names, endpoints, identifiers, and assumptions removed and provenance updated. Migration uses transcript and fault-fixture comparison followed by one active live listener; two implementations never watch and deliver concurrently against a real Messages account.

The repository is a small Bun workspace: `packages/messages` publishes `pronto-imessage`, and `packages/cli` builds the `pronto` executable by consuming that package's public interface. The standalone product becomes self-hosting before external consumers adopt the module. Consumers pin exact released versions even though the package follows semantic versioning.
