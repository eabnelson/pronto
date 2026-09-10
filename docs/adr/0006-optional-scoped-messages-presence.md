---
status: accepted
---

# Expose optional scoped Messages presence

Pronto consumers may explicitly enable standard reactions and typing through a running injected Messages helper. These operations require a current observed conversation, exact target membership for reactions, live bridge capability checks, and conservative outcomes. They use a separate RPC process so optional presence cannot block normal replies; consumers own acknowledgment and execution policy. Basic messaging remains independent of injection, and the module never changes OS protections or automatically launches the helper.
