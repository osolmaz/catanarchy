# Colonist compatibility profile

## Scope

This document records the public Colonist rules that affect Catanarchy. It keeps Colonist platform behavior separate from the authoritative CATAN base-game rules in the [implementation plan](PLAN.md).

The initial compatibility target is Colonist's public four-player base game. The public page is concise and does not specify every rule or room option. This snapshot was checked on September 9, 2026.

## Official Colonist sources

Colonist publishes these rule pages:

- [Four-player base game](https://colonist.io/catan-rules)
- [Five-player and six-player games](https://colonist.io/catan-rules/5-6-player)
- [Cities & Knights](https://colonist.io/catan-rules/cities-and-knights)
- [Seafarers](https://colonist.io/catan-rules/seafarers)
- [Colonist Rush](https://colonist.io/catan-rules/colonist-rush)

Only the four-player base game is in the first compatibility target. The other pages are saved here for later profiles. Their rules must not enter the base engine by accident.

Colonist also published these useful articles:

- [Settling the Rules of Catan](https://blog.colonist.io/settling-the-rules-of-catan/), April 16, 2021
- [Colonist 101: How to Play](https://blog.colonist.io/colonist-101-how-to-play/), 2022
- [Better Timers & Longer Initial Build Phase](https://blog.colonist.io/updated-timers/), July 1, 2020

Blog articles are dated evidence. They can become stale. Current public rules and repeatable observations of the current application take priority when behavior differs.

## Published four-player base rules

### Objective and awards

The first player to reach 10 points wins. A settlement gives 1 point. Upgrading it to a city adds 1 point. A victory-point development card gives 1 point. Longest Road and Largest Army give 2 points each.

Longest Road requires at least five consecutive roads. Largest Army requires at least three played Knight cards. The current holder keeps either award when another player ties the holder. The award moves only when another player has a larger qualifying value.

### Initial placement

Each player places two settlements and two roads. One road comes from each settlement. A player collects one resource from each producing tile around their second settlement. Settlements must satisfy the distance rule.

The public page does not state the forward and reverse placement order. The native engine therefore follows the official CATAN base-game rule for that order unless a Colonist conformance test establishes a platform difference.

### Dice and production

A player rolls at the start of each turn. A settlement beside a matching tile receives one resource. A city receives two. The resource types are lumber, brick, wool, grain, and ore. The bank starts with 19 cards of each resource type.

Colonist shows the remaining count of each resource in the bank. This is public information in a Colonist observation.

### Robber and discards

When a player rolls a seven, each player with eight or more resource cards discards half, rounded down. The active player moves the robber, blocks production on its new tile, then steals one random resource from an eligible player beside that tile.

### Costs and piece limits

| Purchase         | Cost                                   |
| ---------------- | -------------------------------------- |
| Road             | 1 lumber and 1 brick                   |
| Settlement       | 1 lumber, 1 brick, 1 wool, and 1 grain |
| City upgrade     | 2 grain and 3 ore                      |
| Development card | 1 wool, 1 grain, and 1 ore             |

Each player can have at most 15 roads, 5 settlements, and 4 cities in play.

### Development cards

The deck contains 25 cards:

- 14 Knight cards
- 2 Road Building cards
- 2 Year of Plenty cards
- 2 Monopoly cards
- 5 victory-point cards

A Knight moves the robber and steals one random resource from an eligible player. Road Building places two free roads. Year of Plenty takes two available resources from the bank. Monopoly takes every card of one selected resource type from the other players.

A player can play at most one non-victory development card per turn. A player cannot play a development card on the turn in which it was bought. Colonist's clarification article says the eligible card can be played at any time during the turn, including before the dice roll. Multiple victory-point cards can be revealed together when they produce a win.

### Trading and negotiation

The public rules page says that players can trade with other players or with the bank. It does not give the bank rates or a complete domestic-trade procedure.

Colonist's clarification article adds these constraints:

- A domestic trade must exchange at least one resource in each direction. A gift is not a legal trade.
- Players can discuss a future trade, but the game does not enforce the promise.
- Players can state what is in their hands, but they cannot reveal card faces through the game.
- Players must reveal the number of resource cards they hold when required, but not their types.

Catanarchy must preserve this distinction. Chat can contain promises, arguments, and proposed future cooperation. A Colonist-compatible trade transfers resources immediately and cannot enforce a later promise. A future commitment can be binding only in a separate native-engine rules profile.

### Bank shortages

The clarification article gives these outcomes:

- If the bank has none of the required resource, nobody receives that resource.
- If one player is owed two cards and only one remains, that player receives the available card.
- If multiple players are owed cards and the bank cannot give each of them the full amount, none of those players receives that resource.

These cases need explicit conformance tests because the main public rules page does not include them.

## Platform behavior

Colonist prevents players from selecting illegal game actions through its interface. A Catanarchy adapter must still validate every translated action. The interface is not part of the authoritative engine.

A 2022 Colonist guide says that a room host can select options such as player count and game speed. It also describes a play-against-bots mode on a random map. The article does not define a complete room-settings schema or current defaults.

## Historical timers

Colonist published these timer values in July 2020:

| Speed     | Initial placement | Robber, victim, or discard |     Dice roll |
| --------- | ----------------: | -------------------------: | ------------: |
| Very Fast |        60 seconds |                 10 seconds |    10 seconds |
| Fast      |       120 seconds |                 20 seconds |    10 seconds |
| Normal    |       180 seconds |                 40 seconds |    20 seconds |
| Slow      |       360 seconds |                 80 seconds |    60 seconds |
| Very Slow |    18,000 seconds |              3,000 seconds | 3,000 seconds |

These values are historical evidence, not a current contract. The adapter must not hardcode them. It must read a current room setting when possible or report that the timer is unknown.

## Rules not yet established

The public sources do not fully establish these current behaviors:

- Every available room setting and its default value
- Current timers and timeout actions
- Reconnection and abandoned-player behavior
- Exact trade-offer state transitions and cancellation rules
- Current chat limits, moderation behavior, and message visibility
- Random-dice and balanced-dice availability by game mode
- All three-player and custom-map differences
- The application revision that changes any of these behaviors

Do not guess these values. Record them through repeatable adapter observations or an additional current Colonist source.

## Adapter conformance policy

The Colonist adapter will declare a capability profile for each observed room. Rules evidence will use this order:

1. The current Colonist rules page
2. A repeatable observation from the current application
3. A dated Colonist article
4. The official CATAN base-game rule as a fallback

Each conformance fixture must record the observation date, room options, player count, and relevant application revision when it is visible. A conflict must remain visible in the fixture and this document.

Timers, chat availability, and interface limits belong to adapter capabilities. Resource movement, legal placement, awards, and victory belong to the game-rule profile. This boundary lets the native engine stay authoritative while the adapter reproduces Colonist behavior accurately.
