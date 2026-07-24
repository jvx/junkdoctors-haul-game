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
- `?physics=1` starts with Havok physics mode on. Accepted on values: `1`, `true`, `on`, `yes`, `havok`. Alias: `phys`.
- `?physics=0` explicitly keeps physics mode off. Accepted off values: `0`, `false`, `off`, `no`.
- `?pickup=truck` spawns pickup items beside the truck and keeps pickup mode active so you can test loading without driving to the pickup marker. Aliases: `pickupItems` or `items`; accepted on values include `1`, `true`, `on`, `yes`, `truck`, `near`, `nearby`, `near-truck`.

Examples:

- Local level 2 physics-loading test: `http://localhost:8000/?lvl=2&physics=1&pickup=truck`
- Live level 2 physics-loading test: https://jayremedy.github.io/junkdoctors-haul-game/?lvl=2&physics=1&pickup=truck
- Start screen with physics pre-enabled: `http://localhost:8000/?physics=1`

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
- Front-wheel steering (pivots around rear axle)
- Speed-dependent turning (slower turns at low speed)
- 5-speed automatic transmission
- Realistic acceleration curves per gear
- Collision detection with buildings/walls

**Cargo System:**
- Cargo bed bounds tracking
- Loaded items management
- Physics-based item settling

**Key Constants:**
```javascript
maxSpeed: 110         // Top speed in MPH
turnSpeed: 1.9        // Turn rate
rearAxleOffset: 2.5   // Pivot point for steering
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
