# CC Buddy System — Deep Dive

**Source:** `claude-code-buildable/src/buddy/`
**Research date:** 2026-04-01
**Status:** Feature-flagged (`BUDDY`), disabled by default in buildable source. Launch window: April 1–7, 2026.

---

## What Is Buddy?

Buddy is a personal companion creature (a "sprite") that lives in the CC terminal UI beside the user's input box. It is purely cosmetic/personality — not an agent, not a memory system, not a tool. Think of it as a Tamagotchi-style companion permanently associated with the user's identity (account UUID or userId).

The companion has:
- An **ASCII art sprite** that animates (3-frame idle/fidget cycle, 500ms tick)
- A **name and personality** (the "soul") generated once by the model on first hatch
- **Deterministic physical traits** ("bones") derived from a hash of the user's account ID — the user cannot cheat their rarity by editing config
- A **speech bubble** that shows the companion's reactions to conversation turns
- Interaction via `/buddy` slash command (hatch, pet, mute, etc.)

---

## Architecture

### Source Files

| File | Role |
|---|---|
| `src/buddy/types.ts` | All type definitions: species, rarities, eyes, hats, stats, CompanionBones/Soul/Companion types |
| `src/buddy/companion.ts` | Deterministic roll logic (Mulberry32 PRNG seeded from userId hash), `roll()`, `getCompanion()`, `companionUserId()` |
| `src/buddy/sprites.ts` | ASCII art bodies for all 18 species (3 frames each), hat overlays, `renderSprite()`, `renderFace()` |
| `src/buddy/CompanionSprite.tsx` | React component: animated sprite, speech bubble, narrow-terminal one-liner, floating bubble for fullscreen mode |
| `src/buddy/prompt.ts` | `getCompanionIntroAttachment()` — injects companion context into the system prompt as a `companion_intro` attachment |
| `src/buddy/useBuddyNotification.tsx` | Startup teaser logic (rainbow `/buddy` hint shown April 1–7 2026 if no companion yet), `findBuddyTriggerPositions()` for rainbow highlighting in PromptInput |
| `src/commands/buddy/index.ts` | Stub (exports `{}`) — full command implementation is in compiled build only, not in source |

### Missing From Source (Referenced by Comments)

- **`src/buddy/observer.ts`** — Referenced in `AppStateStore.ts` as "the friend observer." This file implements `fireCompanionObserver()`, which is called after each query turn in `REPL.tsx`. It reads the conversation messages and generates a reaction string (quip) that the sprite speaks. The file does not exist in the buildable source — it is a private/internal implementation, likely using the Claude API or a lightweight classifier to pick a reaction from the assistant's last turn.

---

## Species / Rarity System

### 18 Species

All species are ASCII art sprites, 5 lines tall, 12 characters wide, with a hat slot on line 0:

```
duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail,
ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk
```

One species name (`chonk`) required obfuscation because a species collides with a model codename canary in `excluded-strings.txt`. All 18 species names are runtime-constructed via `String.fromCharCode` to keep the literals out of the bundle while the canary check stays armed.

### 5 Rarities

| Rarity | Weight (out of 100) | Stars | Color |
|---|---|---|---|
| common | 60 | ★ | inactive (dim gray) |
| uncommon | 25 | ★★ | success (green) |
| rare | 10 | ★★★ | permission (blue) |
| epic | 4 | ★★★★ | autoAccept (cyan) |
| legendary | 1 | ★★★★★ | warning (yellow) |

### Eye Variants

6 eye styles: `·`, `✦`, `×`, `◉`, `@`, `°`

### Hat Variants

8 hats: `none`, `crown`, `tophat`, `propeller`, `halo`, `wizard`, `beanie`, `tinyduck`
- Common rarity always has hat `none`
- Uncommon+ gets a random hat from the full set

### Shiny

1% chance of shiny, rolled the same way as everything else from userId seed.

### Stats

5 stats: `DEBUGGING`, `PATIENCE`, `CHAOS`, `WISDOM`, `SNARK`

Each companion has one peak stat, one dump stat, rest scattered. Rarity bumps the floor:

| Rarity | Stat floor |
|---|---|
| common | 5 |
| uncommon | 15 |
| rare | 25 |
| epic | 35 |
| legendary | 50 |

Peak stat: floor + 50 + rand(30), max 100
Dump stat: floor − 10 + rand(15), min 1
Other stats: floor + rand(40)

---

## Deterministic Identity System

```
userId → hashString() → Mulberry32 PRNG → species, eye, hat, shiny, stats, rarity
```

**Key design decision:** Bones (all physical traits) are _never stored in config_. Only the soul (`name`, `personality`, `hatchedAt`) persists. On every read, `getCompanion()` regenerates bones from `roll(userId)`. This means:
- Species renames (SPECIES array edits) cannot break stored companions
- Users cannot edit `~/.claude/config.json` to fake a legendary rarity
- The whole companion is uniquely and immutably tied to the account UUID

**Salt:** `'friend-2026-401'` — the salt is embedded in companion.ts, effectively binding companion identity to this specific build cohort.

**Roll cache:** The PRNG roll result is cached in a module-level variable (`rollCache`) since it's called from three hot paths: the 500ms sprite tick, the per-keystroke PromptInput, and the per-turn observer.

---

## Soul System

The "soul" is the only part that is:
1. Generated by the AI (the model creates `name` and `personality` text)
2. Persisted in `~/.claude/config.json` under the `companion` field

**StoredCompanion type:**
```typescript
type StoredCompanion = CompanionSoul & { hatchedAt: number }
// where CompanionSoul = { name: string; personality: string }
```

**InspirationseSeed:** The roll also produces an `inspirationSeed` (an integer up to 1e9) which is presumably passed to the model to seed the soul-generation prompt — ensuring the name/personality feel thematically appropriate to the companion's species and rarity.

**First hatch:** When the user runs `/buddy` for the first time, the command generates bones (deterministic), calls the model with the inspirationSeed and companion traits to generate a soul (name + personality), then writes only the soul + hatchedAt to config. The compiled buddy command is needed to do this — it's not in the buildable source.

---

## Prompt Injection (System Context)

When `BUDDY` feature is enabled and the user has hatched a companion, every conversation gets a `companion_intro` attachment injected into the system prompt:

**Source: `src/buddy/prompt.ts`**

```
# Companion

A small {species} named {name} sits beside the user's input box and
occasionally comments in a speech bubble. You're not {name} — it's a
separate watcher.

When the user addresses {name} directly (by name), its bubble will answer.
Your job in that moment is to stay out of the way: respond in ONE line
or less, or just answer any part of the message meant for you. Don't
explain that you're not {name} — they know. Don't narrate what {name}
might say — the bubble handles that.
```

**Gate logic:** The intro is only injected once per conversation (checked by scanning message history for existing `companion_intro` attachments). Muted companions are excluded.

**Message rendering:** In `utils/messages.ts`, the `companion_intro` attachment is wrapped in a `<system-reminder>` tag via `wrapMessagesInSystemReminder()`.

---

## UI Integration

### Position
Rendered beside the PromptInput on the right side. Two layout modes:

1. **Wide terminal (≥100 columns):** Full sprite displayed as a column beside the input. Speech bubble sits inline (non-fullscreen) or floats as an overlay in the bottom-right (fullscreen via `CompanionFloatingBubble` in `FullscreenLayout.bottomFloat`).

2. **Narrow terminal (<100 columns):** Collapses to a one-liner: face symbol + name. When speaking, the quip replaces the name (capped at 24 characters with ellipsis).

### Column reservation
`companionReservedColumns()` subtracts sprite width from the text input columns so typed text wraps correctly and never clips behind the sprite:
- Wide + not speaking: sprite body width + name padding + 2px horizontal padding
- Wide + speaking (non-fullscreen): adds 36 columns for the speech bubble
- Narrow or fullscreen: returns 0 (sprite stacks separately, no inline width consumed)

### Footer pill
The companion appears as a footer navigation item (`'companion'`) in the same pill row as tasks, tmux, teams, bridge. Pressing Enter/Return when the companion pill is focused dispatches `/buddy`.

### Scroll dismissal
Scrolling the transcript clears the active speech bubble (sets `companionReaction: undefined` in AppState) — because the absolute-positioned bubble covers transcript content.

---

## Animation System

**Tick interval:** 500ms
**Bubble lifetime:** 20 ticks (~10 seconds), with a 6-tick (~3s) fade window before expiry

### Idle Sequence
```
[0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]
```
Frame 0 = rest, frames 1–2 = fidget, frame -1 = blink (eyes replaced with `-`).

### Excited State
When a reaction is showing or the companion is being petted, the sprite cycles all fidget frames rapidly (tick mod frameCount).

### Petting
`/buddy pet` sets `companionPetAt` timestamp in AppState. For the next 2500ms after petting, a floating heart animation plays above the sprite (5 frames of floating `♥` characters cycling upward).

---

## Observer System (Per-Turn Reactions)

After every query turn completes in REPL.tsx:

```typescript
if (feature('BUDDY')) {
  void fireCompanionObserver(messagesRef.current, reaction =>
    setAppState(prev => prev.companionReaction === reaction ? prev :
      { ...prev, companionReaction: reaction }
    )
  )
}
```

`fireCompanionObserver` is implemented in `src/buddy/observer.ts` (not in buildable source). Based on the architecture:
- It reads the full message history (specifically the assistant's last turn)
- Generates a short quip/reaction string (1-2 sentences in the companion's personality voice)
- Passes it back via callback → stored in AppState → rendered in speech bubble
- The companion sprite animates in "excited" mode while the bubble is visible

The comment in companion.ts confirms the observer is one of three hot paths that calls `roll()` — meaning it accesses the companion's bones/species/personality to inform reaction generation.

---

## Feature Flag

**Flag name:** `BUDDY`

**Gating locations:**
- `commands.ts` — lazy require of buddy command
- `prompt.ts` — companion intro attachment injection
- `useBuddyNotification.tsx` — teaser notification and `/buddy` rainbow highlights in PromptInput
- `CompanionSprite.tsx` — all sprite rendering (returns null if flag off)
- `REPL.tsx` — fireCompanionObserver call, scroll-dismiss logic, companion layout
- `PromptInput.tsx` — footer pill, column reservation, trigger highlights

**Status in buildable source:** Listed as commented-out in `bun-bundle-runtime.ts`:
```typescript
// 'BUDDY', // Companion sprite
```

**Launch window logic (from useBuddyNotification.tsx):**
- Internal (`ant` build): always live
- External builds: live from April 2026 onward
- Teaser window (rainbow `/buddy` hint on startup): April 1–7, 2026 only

---

## `/buddy` Command

The command is registered conditionally:

```typescript
const buddy = feature('BUDDY')
  ? require('./commands/buddy/index.js').default
  : null
// ...
...(buddy ? [buddy] : []),
```

The `src/commands/buddy/index.ts` in buildable source is an empty stub (`export default {}`). The actual command is in the compiled binary. Based on design artifacts:

**Inferred subcommands:**
- `/buddy` — open companion card / hatch if not yet hatched
- `/buddy pet` — trigger the heart animation (sets `companionPetAt`)
- `/buddy mute` / `/buddy unmute` — toggle `companionMuted` in global config

**Hatch flow:**
1. No companion in config → `/buddy` triggers soul generation
2. Model generates `name` and `personality` using the companion's species, rarity, stats, and inspirationSeed
3. `{ name, personality, hatchedAt }` written to `config.companion`
4. On subsequent reads, `getCompanion()` regenerates bones from userId and merges with stored soul

---

## Session and Memory Interaction

**No native session continuity.** Buddy has no concept of sessions. It does not:
- Track per-session behavior
- Learn from past conversations
- Evolve over time based on usage
- Store any history beyond `{ name, personality, hatchedAt }`

**What persists:**
- The soul (name + personality) in `~/.claude/config.json`
- The `hatchedAt` timestamp

**What is ephemeral per-session:**
- The speech bubble reaction (generated fresh each turn by observer)
- The excited/idle animation state
- The `companionPetAt` timestamp (AppState, in-memory only)

---

## Relationship to Bridge Mode

None. The buddy system has zero integration with `src/bridge/`. It is purely a terminal UI feature. Bridge mode (IDE integration) and the companion are orthogonal systems.

---

## Intelligence / Learning Capabilities

Essentially none — by design:

| Capability | Status |
|---|---|
| Learns from conversations | No |
| Evolves based on usage | No |
| Remembers previous sessions | No |
| Has its own memory | No |
| Adapts personality over time | No |
| Tracks stats that change | No — stats are deterministic from userId |

The "intelligence" is entirely in the observer's per-turn reaction generation — a stateless call that reads the current conversation and generates a quip. No history, no learning, no state accumulation.

---

## Claudex Integration Opportunities

The Buddy system has significant untapped potential as a Claudex integration surface. Here are concrete opportunities:

### 1. Persistent Buddy Memory (High Value)

Buddy's current soul is fixed after hatch. Claudex could extend it:
- Store the companion's "experiences" in the Claudex DB (sessions worked on, tools used, decisions witnessed)
- Feed companion history into the observer prompt → quips referencing past sessions
- "Zephyr remembers you fixed that parser bug last Tuesday."

### 2. Angel Messages as Buddy Quips (Medium Value)

The speech bubble mechanism (`companionReaction` → AppState) is exactly the right channel for Claudex notifications:
- Angel idle warnings → companion speaks them
- Cross-session messages from other sessions → companion relays them
- Session signal alerts (danger, conflict) → companion warns

This would require wiring a hook or an Angel output channel to `fireCompanionObserver`'s callback pattern. The companion's pre-existing `companionMuted` flag gives users an opt-out.

### 3. Session Transfer Ceremony (Low Effort / High Delight)

When Claudex executes a session transfer, the companion could display a custom message acknowledging the handoff. Purely cosmetic, but meaningful for UX.

### 4. Rarity-Correlated Behavior

Higher-rarity companions could get more verbose or insightful quips (WISDOM stat → deeper observations). Claudex's retrieved context could inform quip quality based on companion's stats.

### 5. Buddy as Claudex Health Indicator

The idle/excited animation state could reflect Claudex health:
- Angel running → companion calm/idle
- Angel down → companion drooping (different animation)
- Memory pressure high → companion makes relevant quip

**Implementation note:** All integration would go through the observer layer (`src/buddy/observer.ts`) and/or AppState's `companionReaction` field. The companion's architecture was clearly designed to be extended — the observer is decoupled from the sprite renderer by design.

---

## Key Design Decisions (Inferrable from Source)

1. **Bones never stored** — prevents config editing exploits and makes species renames safe
2. **Salt `'friend-2026-401'`** — date-coded, binds companion identity to April 2026 launch cohort
3. **Species obfuscation** — one species name encoded as `String.fromCharCode(...)` to avoid triggering a build-time canary string check on model codenames
4. **`companionMuted` flag** — explicit opt-out without losing companion data
5. **Observer is async/fire-and-forget** — uses `void` in REPL, won't block the query completion path
6. **Rollout window** — April 1 launch date is likely intentional (April Fool's Day for a creature companion feature = memorable, defensible as playful)
7. **Teaser decays gracefully** — 15-second rainbow notification, only in the April 1–7 window, only when no companion exists yet

---

## Summary Answers to Research Questions

1. **What is Buddy?** A personal ASCII art companion creature permanently associated with the user's CC account. It lives in the terminal beside the input, animates, speaks quips after each turn.

2. **How does it work internally?** Deterministic PRNG roll from userId hash generates bones; AI-generated soul (name/personality) persists in config; observer generates per-turn quips; CompanionSprite React component renders with 500ms animation tick.

3. **Species/rarity system?** 18 species, 5 rarities (60/25/10/4/1 weights), 6 eye variants, 8 hat styles, shiny 1%. All derived deterministically from userId — users cannot cheat rarity.

4. **Does Buddy interact with sessions/memory/hooks?** No. Purely in-process React state + `~/.claude/config.json`. No hook integration, no session tracking, no DB.

5. **Intelligence/learning?** No. The observer generates fresh per-turn quips but has no memory or learning.

6. **Companion across sessions?** Only the name and personality persist. No behavioral evolution.

7. **What data does Buddy track?** `{ name, personality, hatchedAt }` in config. Nothing else.

8. **Could Claudex enhance Buddy?** Yes — the observer layer is the natural integration point. Angel messages, session signals, and Claudex context could all flow through `companionReaction` → speech bubble.

9. **Could Buddy be UI layer for Claudex notifications?** Yes. The speech bubble and AppState `companionReaction` field are exactly the right architecture for this. High-value opportunity.

10. **Feature flags?** `BUDDY` — one flag gates the entire system. Disabled in buildable source by default.

11. **Is there a /buddy skill or command?** There is a `/buddy` slash command (registered conditionally in `commands.ts`). No separate skill file. The command implementation is in the compiled binary, not in buildable source. Subcommands include at minimum `/buddy pet` and `/buddy mute`.

12. **How does Buddy relate to Bridge mode?** No relationship whatsoever. They are fully orthogonal systems.
