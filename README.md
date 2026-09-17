# JunkDash - Game Architecture

A 3D truck loading puzzle game built with Babylon.js for JunkDoctors.

Play the live game: https://jvx.github.io/junkdoctors-haul-game/

## Testing Shortcuts

Run the game locally as a static site:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

URL params can be combined for faster playtesting:

- `?lvl=2` starts a specific level automatically. Valid levels start at `1`; values above `99` are clamped to `99`. Level-started test sessions skip leaderboard score submission.
- Havok cargo physics is on by default. `?physics=1` explicitly enables it. Accepted on values: `1`, `true`, `on`, `yes`, `havok`. Alias: `phys`.
- `?physics=0` disables cargo physics. Accepted off values: `0`, `false`, `off`, `no`.
- `?pickup=truck` spawns pickup items beside the truck and keeps pickup mode active so you can test loading without driving to the pickup marker. Aliases: `pickupItems` or `items`; accepted on values include `1`, `true`, `on`, `yes`, `truck`, `near`, `nearby`, `near-truck`.

Examples:

- Local level 2 physics-loading test: `http://localhost:8000/?lvl=2&physics=1&pickup=truck`
- Live level 2 physics-loading test: https://jvx.github.io/junkdoctors-haul-game/?lvl=2&physics=1&pickup=truck
- Start screen with physics pre-enabled: `http://localhost:8000/?physics=1`

### Physics Regression Checks

The game has no build step. The optional browser regression suite needs Node.js,
Python 3, and Playwright with Chromium:

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
python3 -m http.server 8000
```

In another terminal, from repo root:

```bash
node --test tests/house-streaming.mjs
node tests/physics-browser.mjs
node tests/cargo-contact-browser.mjs
for f in scripts/*.js; do node --check "$f"; done
git diff --check
```

The suite checks parked and moving placement, acceleration/coasting/braking,
payload effects, steering response through 90 mph, same-frame camera tracking, collisions, tipping, stacking,
pause/restart, physics off, delivery completion, and the actual loading/keyboard/mobile UI. It compares
30/60/144 FPS simulation results and saves metrics/screenshots in `output/physics/`.
Set `GAME_URL` for another local server and `PLAYWRIGHT_MODULE` when using an
existing Playwright installation outside the repository.
The contact suite checks open furniture gaps, tabletop versus foot contact,
equal-mass sliding, airborne exclusion, and partial contact at the bed edge;
it saves metrics and a support screenshot in `output/contact/`.
The dependency-free house-streaming tests check idle budgets, busy-frame deferral,
timeout/fallback progress, and disabled or stale work.

`?test=1` enables manual `window.advanceTime(ms)` stepping for browser tests;
`window.render_game_to_text()` reports the current state. Test URLs should also
include `lvl` to skip the player-profile flow.

## Overview

Players drive a junk removal truck through a procedurally-generated city, picking up items from locations and delivering them to drop-off points. The goal is to load items efficiently while navigating the streets.

## Tech Stack

- **Babylon.js** - 3D rendering engine
- **Havok Physics** - Physics engine for item stacking and collisions
- **HTML/CSS/JS** - Static site (GitHub Pages friendly)
- **Web Audio API** - Procedural audio (engine sounds, horn, gear shifts)

## Directory Structure

```
game/
├── index.html             # Main HTML entry point
├── README.md              # This file
├── api/                   # (empty in static build; leaderboard uses hosted API)
├── assets/
│   ├── audio/             # Sound effects (tire sounds, ambient)
│   ├── images/            # UI images and logos
│   ├── models/            # 3D models (.glb format)
│   ├── radio/             # Radio station music tracks
│   └── textures/          # Texture files
├── scripts/               # Game logic (JavaScript files)
│   ├── main.js            # Entry point - initializes Game
│   ├── Coords.js          # Coordinate system utilities (IMPORTANT)
│   ├── Game.js            # Main game controller
│   ├── SceneManager.js    # 3D scene, camera, lighting, world
│   ├── Truck.js           # Truck entity and driving physics
│   ├── ItemManager.js     # Item spawning and management
│   ├── InputSystem.js     # Keyboard, mouse, touch controls
│   ├── AudioManager.js    # Sound effects and music
│   ├── UIManager.js       # HUD and UI elements
│   ├── PhysicsSystem.js   # Physics simulation
│   ├── LevelManager.js    # Level progression
│   └── HighScoreManager.js # Score tracking
└── styles/
    └── main.css           # CSS styles
```

## Core Systems

### Game.js - Main Controller
The central orchestrator that:
- Initializes all subsystems
- Manages game state (loading, playing, paused)
- Runs the main game loop
- Handles level progression and scoring
- Coordinates pickup/drop-off locations

```javascript
class Game {
    // Key properties
    this.truck           // Truck instance
    this.sceneManager    // 3D world
    this.itemManager     // Item spawning
    this.audioManager    // Sound
    this.inputSystem     // Controls
    this.uiManager       // HUD
}
```

### SceneManager.js - 3D World
Manages the entire 3D environment:

**Key Responsibilities:**
- Scene creation and lighting setup
- Camera system (follow cam with manual look-around)
- Infinite ground system with dynamic tile loading
- House generation and streaming
- Pickup/drop-off location visuals (beacons, walls, gravel pads)
- Post-processing effects (bloom, fog)
- Minimap rendering

**Infinite World System:**
- Ground tiles are 50m × 50m
- Tiles are dynamically loaded/unloaded based on player position
- Houses are streamed in using `requestIdleCallback` for performance
- Custom textures for drop-off locations (square corners vs rounded)

### Truck.js - Vehicle Entity
The player-controlled truck with:

**Driving Physics:**
- Fixed 120 Hz driving updates synchronized with Havok cargo contacts
- Front-wheel bicycle steering around the rear axle, with 50-degree steering lock
  (about a 4 m low-speed rear-axle turning radius) and a 1.5 rad/s arcade turn-rate cap
- Steering reaches 90% input in about 0.1 seconds, including quick centering/reversal
- Camera follows the current physics frame and truck heading without added lag;
  manual look-around remains smoothed and frame-rate independent
- 5-speed automatic transmission
- Gear-dependent acceleration, payload mass, rolling resistance, and air drag
- Responsive truck controls: up to 12 mph/s acceleration and 40 mph/s braking unloaded
- Steering stays responsive while braking; cargo uses physical sliding/tumbling contacts
- Level-footprint building/wall collisions allow backing away after impact;
  suspension lean remains active for the visuals and cargo

**Cargo System:**
- Cargo bed bounds tracking
- Loaded items management
- By default, dynamic Havok bodies handle friction, stacking, sliding,
  tipping, and impacts without pose locks or per-frame velocity clamps
- Contact-gated lateral grip reduces excessive sideways motion from arcade
  steering, including supported stacks, without assisting airborne cargo
- Increased rotational inertia and angular damping give cargo a heavier feel:
  small knocks settle quickly, while hard impacts can still tip unsecured items.
  Payload weights, linear damping, and the truck controls are unchanged.
- Chairs and tables use compound collision shapes around the model's individual
  wooden parts, leaving space between legs and backrest rails open. Other items
  use box shapes matching their visible fallback geometry.
- As a gameplay rule, more floor-contact area means more friction. Grip uses
  downward-facing part surfaces clipped to the bed, not the whole footprint;
  feet and edges grip less than a broad flat face. Grip is capped, not a lock.
- The truck follows a road-plane vehicle model rather than a full
  wheel/suspension rigid-body simulation.

**Key Constants:**
```javascript
maxSpeed: 90          // Governed road speed in MPH
maxReverseSpeed: 12   // Reverse limit in MPH
truckBaseMass: 3500   // Unladen mass in kg
wheelbase: 4.8        // Meters between axles
rearAxleOffset: 1.8   // Pivot point for steering
cargoLength: 4.8m
cargoWidth: 2.4m
cargoHeight: 2.2m
```

### ItemManager.js - Items
Handles all junk items:
- Item definitions (boxes, furniture, appliances)
- Spawning items at pickup locations
- Preview system for placing items
- 3D model loading (.glb files)
- Item colors and variations

### InputSystem.js - Controls
Supports multiple input methods:
- **Keyboard:** WASD for driving, Arrow keys for camera
- **Mouse:** Click to place items, drag to look around
- **Touch:** Virtual joysticks for mobile, tap to place

### AudioManager.js - Sound
Procedural audio using Web Audio API:
- Dynamic engine sound (pitch based on speed/RPM)
- Horn with overtones
- Gear shift clicks
- Ambient outdoor sounds
- Radio station with multiple tracks

### UIManager.js - Interface
Game HUD elements:
- Score display (space efficiency)
- Level indicator
- Speedometer and gear indicator
- Minimap
- Item pickup list
- Pause menu

## Coordinate Systems

The game uses multiple coordinate systems. To prevent "reversal" bugs, all coordinate logic is centralized in **`Coords.js`**.

### The Coords Utility (`scripts/Coords.js`)

This is the **single source of truth** for coordinate conversions:

```javascript
// Get corner from direction signs
Coords.cornerFromSigns(signX, signZ, useLegacy)  // → 'tr', 'tl', 'br', 'bl'

// Convert between naming conventions
Coords.toCompass('tl')  // → 'nw'
Coords.toLegacy('nw')   // → 'tl'

// Get signs from corner
Coords.signsFromCorner('tr')  // → { x: 1, z: 1 }

// World ↔ Canvas coordinate conversion
Coords.worldToCanvas(worldX, worldZ, tileSize, texSize, tileCenterX, tileCenterZ)
Coords.canvasToWorld(canvasX, canvasY, tileSize, texSize, tileCenterX, tileCenterZ)
```

### The Four Coordinate Systems

| System | X Axis | Y/Z Axis | Origin |
|--------|--------|----------|--------|
| **World Space** | East (+X) | North (+Z), Up (+Y) | Map center |
| **Canvas 2D** | Right (+X) | **Down (+Y)** | Top-left |
| **UV Texture** | Right (+U) | **Up (+V)** | Bottom-left |
| **Tile Grid** | East (+gridX) | North (+gridZ) | Integer indices |

### Corner Naming Conventions

**Compass names** (preferred in new code):
- `'nw'` = Northwest = low X, high Z
- `'ne'` = Northeast = high X, high Z
- `'sw'` = Southwest = low X, low Z
- `'se'` = Southeast = high X, low Z

**Legacy names** (used in existing code):
- `'tl'` = top-left = `'nw'`
- `'tr'` = top-right = `'ne'`
- `'bl'` = bottom-left = `'sw'`
- `'br'` = bottom-right = `'se'`

### Key Insight: Canvas = World (No Flip Needed)

Despite the Canvas Y-down vs UV V-up mismatch, **canvas corners map directly to world corners**:
- Canvas `(0, 0)` top-left → World Northwest (`'tl'`/`'nw'`)
- Canvas `(max, max)` bottom-right → World Southeast (`'br'`/`'se'`)

This is because the Canvas→UV flip and UV→World flip cancel out.

## Key Algorithms

### Collision Detection
Uses Babylon.js OBB (Oriented Bounding Box) intersection:
```javascript
// Check if truck would collide at a position/rotation
checkMeshCollision(x, z, rotY) {
    // Broad phase: distance check
    // Narrow phase: mesh.intersectsMesh(other, true)
}
```

### Ground Texture System
Dynamic textures drawn with Canvas 2D:
- Grass blocks with rounded outer corners
- Road grid with dashed center lines
- Solid edge lines that curve at grass corners
- Special textures for drop-off locations (square corners)

### House Streaming
Performance-optimized house loading:
```javascript
updateInfiniteGround() {
    // 1. Calculate needed tiles based on player position
    // 2. Remove tiles outside view distance
    // 3. Queue house creation for idle time
    // 4. Use requestIdleCallback to spread work
}
```

## Configuration

### Debug Toggles (Game.js)
```javascript
debugToggles: {
    houseStreaming: true,   // Enable/disable house loading
    farGround: true,        // Extended ground plane
    postProcessing: true,   // Bloom, fog effects
    itemPhysics: true       // Physics on loaded items
}
```

### Performance Settings
```javascript
enablePerfStats: false      // Console performance logging
groundTilesPerSide: 30      // View distance in tiles
houseRenderDistance: 6      // House streaming radius
```

## Game Flow

1. **Loading Screen** - Assets load, scene initializes
2. **Title Screen** - Player presses Start
3. **Gameplay Loop:**
   - Drive to orange beacon (pickup)
   - Load items into truck
   - Drive to green beacon (drop-off)
   - Receive score based on efficiency
4. **Level Complete** - Progress to next level
5. **Game Over** - View high scores

## Controls

| Input | Action |
|-------|--------|
| W / ↑ | Accelerate |
| S / ↓ | Brake/Reverse |
| A | Turn Left |
| D | Turn Right |
| Space | Handbrake |
| H | Horn |
| Arrow Keys | Look Around |
| Click | Place/Pick Item |
| ESC | Pause |

## Performance Considerations

- **Mesh Merging:** Houses merged by material to reduce draw calls
- **Texture Freezing:** Static textures frozen after creation
- **Idle-time Processing:** House creation spread across frames
- **Broad-phase Culling:** Distance checks before collision tests
- **Object Pooling:** Reused Vector3 and Color3 objects

## Dependencies

External CDN resources:
- `babylon.js` - Core engine
- `babylonjs.materials.min.js` - Materials library
- `babylonjs.loaders.min.js` - Model loaders
- `cannon.js` - Physics engine
- Google Fonts (DM Sans, Instrument Serif)
