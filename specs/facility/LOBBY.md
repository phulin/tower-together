# Lobby

Family 24 (Lobby) is passive transfer infrastructure.

## Lobby Height

`lobby_height` is a saved tower parameter with runtime values `1`, `2`, or `3`.

A multi-floor lobby occupies floor 0 plus `lobby_height - 1` additional floors
directly above it (clone logical floors `0` through `lobby_height - 1`).

- 1-floor lobby: floor 0 only
- 2-floor lobby: floors 0–1
- 3-floor lobby: floors 0–2

The premium floor-construction cost for floors inside the lobby simply reflects
the taller lobby — it is not a separate "atrium" mechanic. See `ECONOMY.md §
Floor Construction Premium` for the exact pricing.

Rules:

- creates no runtime actors
- participates in transfer and walkability logic
- can be drag-laid across valid floors
- contributes to transfer-group and reachability rebuilds
