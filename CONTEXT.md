# Pronto

Pronto is an independent public macOS messaging project that lets local agents participate in conversations and supplies reusable provider capabilities to other products.

## Language

**Pronto**:
The public software project, including its independently installable agent product and reusable messaging modules.
_Avoid_: s4imsg, Studio Four bridge

**Pronto Messages Module**:
The released module that owns local Apple Messages mechanics and exposes normalized provider facts and commands without consumer policy.
_Avoid_: Studio Four adapter, vendored transport, Pronto daemon

**Pronto Consumer**:
A product that uses a released Pronto module while retaining authority over its own users, policy, and durable product state.
_Avoid_: Pronto fork, downstream copy
