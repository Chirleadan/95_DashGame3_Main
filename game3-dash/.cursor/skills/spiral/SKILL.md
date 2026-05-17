---
name: spiral
description: >-
  Guides work on the Spiral run artifact (drawn arc dash, click teleport, preview
  ribbon, enemy speed penalty). Player copy uses WARNING: FUN BUT BUGGY. Use when the user
  mentions Spiral, artifactSpiral, spiral dash, spiral path, or edits spiral-related
  code in Game.ts, Player.ts, or CONFIG spiral keys.
disable-model-invocation: true
---

# Spiral artifact

**WARNING: FUN BUT BUGGY** (player-facing; see `ARTIFACT_SPIRAL_DESCRIPTION` in `RunUpgradeLibrary.ts`)

Rare run upgrade `artifactSpiral` ("Artifact: Spiral"). Treat all spiral behavior as unstable until manually verified in-game.

## When to use this skill

- Changing spiral input, path building, dash movement, preview, camera catch-up, or balance
- Debugging spiral dashes, teleports, or enemy speed after pickup
- Updating library text or UI for Spiral

## Player-facing behavior

- **Unlock**: Level-up pick `artifactSpiral` sets `runSpiralDashUnlocked` in `Game.ts`.
- **Draw dash**: Hold pointer and drag; release to dash along a smoothed ground path (Catmull–Rom in `Game.buildSpiralGroundPathFromScreen` / `smoothSpiralGroundPath`).
- **Click teleport**: Short drag (&lt; `SPIRAL_DRAG_CLICK_MAX_PX` screen px) teleports to ground under release (`SpiralDashInput` mode `click`).
- **Preview**: Cyan ribbon mesh while dragging (`syncSpiralDashPreview`, `syncSpiralPreviewRibbon`).
- **Keyboard dash**: Disabled while spiral is active (`consumeDashTrigger(!spiralDashEnabled)`).
- **Trade-off**: Enemies move faster for the rest of the run (`CONFIG.spiralEnemySpeedMult`, default `2`).
- **No dash enemy-freeze**: `spiralArtifactActive` skips `dashEnemyFreezeLeft` on dash start.

## Code map

| Area | File | Notes |
|------|------|--------|
| Input → path/click | `Game.ts` | `consumeSpiralDashInput`, `buildSpiralGroundPathFromScreen`, preview ribbon |
| Movement | `Player.ts` | `startSpiralDashPath`, `startSpiralClickTeleport`, `advanceAlongSpiralDash`, `SpiralDashInput` |
| Tuning | `config.ts` | `spiralCameraCatchUpSec`, `spiralGroundSampleMinDist`, `spiralPathMaxLengthWorld`, dash time clamps, `spiralEnemySpeedMult` |
| Library | `RunUpgradeLibrary.ts` | `id: 'artifactSpiral'` |
| Icon | `RunUpgradeArt.ts` | `spiral.png` |

## CONFIG defaults (see `config.ts`)

- `spiralPathMaxLengthWorld`: 28
- `spiralMinDashSec` / `spiralMaxDashSec`: 0.08 / 2.75
- `spiralDrawTimeToDashTimeMult`: 0.9 (extra dash time from draw duration)
- `spiralCameraCatchUpSec`: 0.6 after teleport (`cameraController.beginTeleportCatchUp`)
- `spiralGroundSampleMinDist`: 0.12

## Implementation notes

1. **Path cap**: `Player.startSpiralDashPath` truncates polyline to `spiralPathMaxLengthWorld`.
2. **Dash duration**: `pathLen / getEffectiveDashSpeed() + drawDurationSec * spiralDrawTimeToDashTimeMult`, clamped.
3. **Movement**: While `spiralDashPath` is set, position advances segment-by-segment (`advanceAlongSpiralDash`), not straight `dash.dir`.
4. **Teleport flag**: `consumeSpiralTeleportStarted()` drives camera catch-up in `Game` update loop.

## Agent rules

**WARNING: FUN BUT BUGGY** (player-facing; see `ARTIFACT_SPIRAL_DESCRIPTION` in `RunUpgradeLibrary.ts`)

- Prefer minimal, targeted fixes; avoid refactors that touch non-spiral dash logic.
- After any change, note what was **not** play-tested (path edge cases, tank clip during spiral dash, overlap with Phase Dash / Lightning, click vs draw threshold).
- Do not assume spiral matches normal dash collision, kill sweep, or cooldown semantics—they diverge in several branches.
- When adding features, document new CONFIG keys and keep `RunUpgradeLibrary` description in English; include **WARNING: FUN BUT BUGGY** (player-facing; see `ARTIFACT_SPIRAL_DESCRIPTION` in `RunUpgradeLibrary.ts`) if describing player-visible behavior.

## Known risk areas (investigate before “done”)

- Interaction with tank clip / vault slide (`tankClipSlideActive`, `clipDashPastTank`)
- `dash.tryStart` + spiral overrides when `cooldownLeft > 0` (path vs click branches)
- Ground ray miss (`screenPointToGroundXZ` returns null)
- Preview vs executed path mismatch (preview uses live drag; dash uses release snapshot)
- Enemy speed multiplier stacking with other slow/speed effects
