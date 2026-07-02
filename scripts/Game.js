/**
 * Game - Main game controller
 */
class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.engine = null;
        this.scene = null;
        
        this.isRunning = false;
        this.isPaused = false;
        this.currentLevel = 1;
        this.urlLevelOverride = this.getUrlLevelOverride();
        this.urlPhysicsEnabled = this.getUrlPhysicsEnabled();
        this.isUrlLevelOverrideActive = false;
        
        this.score = {
            spaceEfficiency: 0,
            stability: 100
        };
        
        // Destination for current level
        this.destination = { x: 0, z: 0 };
        this.destinationRadius = 15; // How close to get to complete delivery
        this.hasArrivedAtDestination = false;
        
        // Pickup location for loading items
        this.pickup = { x: 0, z: 0 };
        this.pickupRadius = 40; // Allow pickup without entering the block
        this.isAtPickup = true; // Start at pickup location
        
        // Physics mode: when true, items use Havok physics; when false, items are parented to truck
        this.physicsEnabled = this.urlPhysicsEnabled;

        // Systems
        this.audioManager = new AudioManager();
        this.sceneManager = null;
        this.truck = null;
        this.itemManager = null;
        this.inputSystem = null;
        this.uiManager = null;
        this.levelManager = new LevelManager();
        this.physicsSystem = null;
        this.highScoreManager = new HighScoreManager();
        this.enablePerfStats = true;
        this.debugToggles = {
            houseStreaming: true,
            farGround: true,
            postProcessing: true,
            itemPhysics: true
        };
        this.perfOverlay = null;
        this._physicsPerf = { start: 0, frameMs: 0, accumMs: 0 };
    }
    
    async init() {
        try {
            // Create engine
            this.engine = new BABYLON.Engine(this.canvas, true, {
                preserveDrawingBuffer: true,
                stencil: true,
                antialias: true
            });
            
            window.addEventListener('resize', () => this.handleResize());
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', () => this.handleResize());
            }
            
            // Init UI Manager first
            this.uiManager = new UIManager(this);
            this.uiManager.init();
            this.initPerfOverlay();
            
            // Sync initial canvas size
            this.handleResize(true);
            this.applyHardwareScaling();
            
            // Create scene
            this.uiManager.updateLoadingProgress(20, 'Creating scene...');
            this.sceneManager = new SceneManager(this.engine, this.canvas);
            this.scene = await this.sceneManager.createScene();
            this.initPhysicsPerfObservers();
            
            // Init audio
            this.audioManager.init();
            
            // Create truck
            this.uiManager.updateLoadingProgress(50, 'Loading truck...');
            this.truck = new Truck(this.scene, this.sceneManager, this.audioManager);
            this.truck.create();
            this.truck.initDriving();
            this.truck.enablePerfStats = this.enablePerfStats;
            this.sceneManager.setFollowTarget(this.truck);
            this.applyDebugToggles();
            
            // Create item manager
            this.uiManager.updateLoadingProgress(70, 'Preparing items...');
            this.itemManager = new ItemManager(this.scene, this.sceneManager, this.truck, this.audioManager, this);
            this.sceneManager.itemManager = this.itemManager; // Allow SceneManager to check if item is held
            await this.itemManager.preloadModels();
            
            // Create physics system with fall-out callback (if method exists)
            this.physicsSystem = new PhysicsSystem(this.scene);
            if (this.physicsSystem.setFallOutCallback) {
                this.physicsSystem.setFallOutCallback((item) => this.onItemFellOut(item));
            }
            
            // Create input system
            this.uiManager.updateLoadingProgress(85, 'Setting up controls...');
            this.inputSystem = new InputSystem(this);
            this.inputSystem.init();

            // Debug toggles (1-4)
            window.addEventListener('keydown', (e) => {
                if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
                if (e.key === '1') {
                    this.debugToggles.houseStreaming = !this.debugToggles.houseStreaming;
                    this.applyDebugToggles();
                    console.log(`🧪 Toggle house streaming: ${this.debugToggles.houseStreaming}`);
                } else if (e.key === '2') {
                    this.debugToggles.farGround = !this.debugToggles.farGround;
                    this.applyDebugToggles();
                    console.log(`🧪 Toggle far ground: ${this.debugToggles.farGround}`);
                } else if (e.key === '3') {
                    this.debugToggles.postProcessing = !this.debugToggles.postProcessing;
                    this.applyDebugToggles();
                    console.log(`🧪 Toggle post-processing: ${this.debugToggles.postProcessing}`);
                } else if (e.key === '4') {
                    this.debugToggles.itemPhysics = !this.debugToggles.itemPhysics;
                    this.applyDebugToggles();
                    console.log(`🧪 Toggle item physics: ${this.debugToggles.itemPhysics}`);
                } else if (e.key === '5') {
                    this.enablePerfStats = !this.enablePerfStats;
                    if (this.truck) this.truck.enablePerfStats = this.enablePerfStats;
                    if (this.perfOverlay) {
                        this.perfOverlay.style.display = this.enablePerfStats ? 'block' : 'none';
                    }
                    console.log(`🧪 Toggle perf stats: ${this.enablePerfStats}`);
                } else if (e.key === '8') {
                    // Toggle placement area debug visualization
                    console.log('🔍 Key 8 pressed, itemManager:', !!this.itemManager);
                    if (this.itemManager) {
                        console.log('🔍 debugEnabled before toggle:', this.itemManager.debugEnabled);
                        if (this.itemManager.debugEnabled) {
                            this.itemManager.disableDebugVisualization();
                        } else {
                            this.itemManager.enableDebugVisualization();
                        }
                        console.log('🔍 debugEnabled after toggle:', this.itemManager.debugEnabled);
                    }
                } else if (e.key === '9') {
                    // Toggle physics walls visibility for debugging
                    if (this.truck && this.truck.togglePhysicsWallsDebug) {
                        this.truck.togglePhysicsWallsDebug();
                    }
                }
            });
            
            // Start render loop
            let lastTime = performance.now();
            this.engine.runRenderLoop(() => {
                const now = performance.now();
                const deltaTime = (now - lastTime) / 1000;
                lastTime = now;
                
                const perfEnabled = this.enablePerfStats === true;
                let perfNowMs = 0;
                if (perfEnabled) {
                    // Perf logging (once per second)
                    perfNowMs = Date.now();
                    if (!this._perfStats) {
                        this._perfStats = { frames: 0, totalMs: 0, driveMs: 0, cameraMs: 0, groundMs: 0, updateMs: 0, renderMs: 0, physicsMs: 0 };
                        this._perfLastLog = perfNowMs;
                    }
                }
                
                if (this.scene) {
                    // Update truck driving (always, even when paused for fun)
                    if (this.isRunning) {
                        const inputEnabled = !this.uiManager.modalBlocking;
                        if (!this._loggedRunning) {
                            this._loggedRunning = true;
                        }
                        const driveStart = perfEnabled ? performance.now() : 0;
                        this.truck.updateDriving(Math.min(deltaTime, 0.1), { inputEnabled });
                        if (perfEnabled) this._perfStats.driveMs += performance.now() - driveStart;

                        // Update view once per frame
                        const cameraStart = perfEnabled ? performance.now() : 0;
                        this.sceneManager.updateCameraFollow();
                        if (perfEnabled) this._perfStats.cameraMs += performance.now() - cameraStart;

                        const groundStart = perfEnabled ? performance.now() : 0;
                        this.sceneManager.updateInfiniteGround(this.truck.position.x, this.truck.position.z);
                        if (perfEnabled) this._perfStats.groundMs += performance.now() - groundStart;
                    }
                    
                    if (!this.isPaused) {
                        const updateStart = perfEnabled ? performance.now() : 0;
                        this.update();
                        if (perfEnabled) this._perfStats.updateMs += performance.now() - updateStart;
                    }
                    // Apply interpolated transform before render (visuals only)
                    const renderStart = perfEnabled ? performance.now() : 0;
                    this.scene.render();
                    if (perfEnabled) this._perfStats.renderMs += performance.now() - renderStart;
                }

                if (perfEnabled) {
                    const frameEnd = performance.now();
                    this._perfStats.frames += 1;
                    this._perfStats.totalMs += (frameEnd - now);
                    if (perfNowMs - this._perfLastLog >= 1000) {
                        this.updatePerfOverlay();
                        this._perfStats.frames = 0;
                        this._perfStats.totalMs = 0;
                        this._perfStats.driveMs = 0;
                        this._perfStats.cameraMs = 0;
                        this._perfStats.groundMs = 0;
                        this._perfStats.updateMs = 0;
                        this._perfStats.renderMs = 0;
                        this._perfStats.physicsMs = 0;
                        this._perfLastLog = perfNowMs;
                    }
                }
            });
            
            // Complete loading
            this.uiManager.updateLoadingProgress(100, 'Ready!');
            
            setTimeout(() => {
                this.uiManager.hideLoadingScreen();
                if (this.urlPhysicsEnabled) {
                    console.log('🔧 URL physics override: ENABLED (Havok)');
                }
                if (this.urlLevelOverride) {
                    this.isUrlLevelOverrideActive = true;
                    console.log(`🧪 URL level override: starting level ${this.urlLevelOverride}`);
                    this.startAtLevel(this.urlLevelOverride);
                } else {
                    this.uiManager.showStartScreen();
                }
            }, 500);
            
        } catch (error) {
            console.error('Game init error:', error);
            this.uiManager.updateLoadingProgress(0, 'Error loading. Please refresh.');
        }
    }
    
    start() {
        this.startAtLevel(1);
    }

    getUrlLevelOverride() {
        const params = new URLSearchParams(window.location.search);
        const rawLevel = params.get('lvl');
        if (!rawLevel || !/^\d+$/.test(rawLevel)) return null;

        const level = Number(rawLevel);
        if (!Number.isSafeInteger(level) || level < 1) return null;

        return Math.min(level, 99);
    }

    getUrlPhysicsEnabled() {
        const params = new URLSearchParams(window.location.search);
        const hasPhysicsParam = params.has('physics') || params.has('phys');
        if (!hasPhysicsParam) return false;

        const rawValue = params.has('physics') ? params.get('physics') : params.get('phys');
        const normalized = (rawValue || '1').trim().toLowerCase();

        if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
        return ['1', 'true', 'on', 'yes', 'havok'].includes(normalized);
    }

    initPerfOverlay() {
        if (!this.enablePerfStats || this.perfOverlay) return;
        const overlay = document.createElement('div');
        overlay.id = 'perf-overlay';
        overlay.style.position = 'fixed';
        overlay.style.top = '8px';
        overlay.style.right = '8px';
        overlay.style.zIndex = '9999';
        overlay.style.padding = '8px 10px';
        overlay.style.background = 'rgba(0, 0, 0, 0.6)';
        overlay.style.color = '#e9f2ff';
        overlay.style.fontFamily = 'monospace';
        overlay.style.fontSize = '12px';
        overlay.style.lineHeight = '1.35';
        overlay.style.whiteSpace = 'pre';
        overlay.style.pointerEvents = 'none';
        overlay.textContent = 'perf stats…';
        document.body.appendChild(overlay);
        this.perfOverlay = overlay;
    }

    updatePerfOverlay() {
        if (!this.perfOverlay || !this._perfStats) return;
        const stats = this._perfStats;
        const fps = this.engine ? this.engine.getFps() : 0;
        const frames = Math.max(1, stats.frames);
        const avgFrame = stats.totalMs / frames;
        const avgDrive = stats.driveMs / frames;
        const avgCamera = stats.cameraMs / frames;
        const avgGround = stats.groundMs / frames;
        const avgUpdate = stats.updateMs / frames;
        const avgRender = stats.renderMs / frames;
        const avgPhysics = stats.physicsMs / frames;
        let truckLine = '';
        if (this.truck && this.truck._perfStats && this.truck._perfStats.frames > 0) {
            const t = this.truck._perfStats;
            const tFrames = Math.max(1, t.frames);
            const tCollision = t.collisionMs / tFrames;
            const tItems = t.itemsMs / tFrames;
            truckLine = `\ntruck:  col ${tCollision.toFixed(2)}  items ${tItems.toFixed(2)}`;
        }
        this.perfOverlay.textContent =
            `fps:    ${fps.toFixed(1)}\n` +
            `frame:  ${avgFrame.toFixed(2)} ms\n` +
            `drive:  ${avgDrive.toFixed(2)}  cam ${avgCamera.toFixed(2)}\n` +
            `ground: ${avgGround.toFixed(2)}  upd ${avgUpdate.toFixed(2)}\n` +
            `render: ${avgRender.toFixed(2)}  phys ${avgPhysics.toFixed(2)}` +
            truckLine;
    }

    initPhysicsPerfObservers() {
        if (!this.scene || this._physicsPerfObserversInitialized) return;
        this._physicsPerfObserversInitialized = true;
        this.scene.onBeforePhysicsObservable.add(() => {
            if (!this.enablePerfStats) return;
            this._physicsPerf.start = performance.now();
        });
        this.scene.onAfterPhysicsObservable.add(() => {
            // Enforce bounds AFTER physics to catch any escapes
            if (this.truck) this.truck.enforceItemBounds();
            
            if (!this.enablePerfStats) return;
            const elapsed = performance.now() - this._physicsPerf.start;
            this._physicsPerf.frameMs = elapsed;
            if (this._perfStats) {
                this._perfStats.physicsMs += elapsed;
            }
        });
    }
    
    startAtLevel(level) {
        this.currentLevel = level;
        
        // Reset game state
        this.hasArrivedAtDestination = false;
        this.fallOutTriggered = false;
        this.isAtPickup = true;
        this.score = { spaceEfficiency: 0, stability: 100 };
        
        // Reset truck position
        this.truck.position.x = 0;
        this.truck.position.z = 0;
        this.truck.rotation = 0;
        this.truck.speed = 0;
        this.truck.loadedItems = [];
        this.truck.applyTransform();
        
        // Clear any existing items
        this.itemManager.clearAll();
        
        this.uiManager.hideStartScreen();
        this.focusGameCanvas();
        this.uiManager.updateLevel(this.currentLevel);
        this.uiManager.reset();
        
        // Generate pickup and destination FIRST (so they're not at 0,0)
        this.generatePickup();
        this.generateDestination();
        
        // Load items (so areAllItemsPlaced won't return true for empty)
        this.levelManager.loadLevel(this.currentLevel, this);
        this.spawnGroundItems();
        
        // NOW enable the game loop - destination and items are ready
        this.isRunning = true;
        
        // Animate camera from title view to gameplay view
        this.sceneManager.animateToGameplay(1500);
        
        // Start the engine sound
        this.audioManager.startEngine();
        
        // Debug collision boxes now toggle with '9' key
    }

    focusGameCanvas() {
        if (!this.canvas) return;

        if (!this.canvas.hasAttribute('tabindex')) {
            this.canvas.setAttribute('tabindex', '0');
        }

        this.canvas.focus({ preventScroll: true });
    }
    
    update() {
        if (!this.isRunning || this.isPaused) return;
        
        // Update speedometer (convert m/s to MPH: 1 m/s = 2.237 mph)
        this.updateSpeedometer();
        
        // Check if at pickup location
        this.checkPickupProximity();
        
        // Check if arrived at destination
        this.checkDestinationArrival();
        
        // Check for fallen items using truck-local coordinates (not AABB bounds)
        const floorY = this.truck.getFloorTopY();
        const truckX = this.truck.position.x;
        const truckZ = this.truck.position.z;
        const truckRot = this.truck.rotation;
        // IMPORTANT: Negate rotation for Babylon.js convention
        const cos = Math.cos(-truckRot);
        const sin = Math.sin(-truckRot);
        const halfW = this.truck.cargoWidth / 2;
        const halfL = this.truck.cargoLength / 2;

        // Check each placed item for falling out
        let newlyFallen = 0;
        this.itemManager.placedItems.forEach(item => {
            if (!item.isFallen && item.mesh) {
                const itemHalfHeight = item.size ? item.size.y / 2 : 0.3;

                // Get local coordinates - depends on whether item is parented
                let localX, localZ, localY;
                if (item.isParented && item.mesh.parent === this.truck.root) {
                    // Item is parented - position IS local coordinates
                    localX = item.mesh.position.x;
                    localZ = item.mesh.position.z;
                    localY = item.mesh.position.y;
                } else {
                    // Item is NOT parented - transform world to local
                    const pos = item.mesh.position;
                    const dx = pos.x - truckX;
                    const dz = pos.z - truckZ;
                    localX = dx * cos + dz * sin;
                    localZ = -dx * sin + dz * cos;
                    localY = pos.y;
                }

                // Item bottom is below truck floor by more than 0.3m = fallen
                const itemBottomY = localY - itemHalfHeight;
                const fellBelowFloor = itemBottomY < floorY - 0.3;

                // Check if outside truck cargo area in local coordinates (with margin)
                const outsideX = Math.abs(localX) > halfW + 0.5;
                const outsideFront = localZ < -halfL - 0.5;
                const outsideBack = localZ > halfL + 1.0; // More margin at open back
                const outsideBounds = outsideX || outsideFront || outsideBack;

                // Mark as fallen if below floor OR outside bounds
                if (fellBelowFloor || outsideBounds) {
                    item.isFallen = true;
                    newlyFallen++;
                    console.log(`❌ Item ${item.id} marked fallen: localX=${localX.toFixed(2)}, localZ=${localZ.toFixed(2)}, localY=${localY.toFixed(2)}, floorY=${floorY.toFixed(2)}, halfW=${halfW}, halfL=${halfL}, fellBelowFloor=${fellBelowFloor}, outsideBounds=${outsideBounds}`);
                }
            }
        });
        
        // Trigger loss if item fell out
        if (newlyFallen > 0) {
            this.onItemFellOut(null);
        }
        
        // Update score
        this.updateScore();
        
        // Update UI
        this.uiManager.update();
    }
    
    updateSpeedometer() {
        // Speed units = MPH (1:1 mapping)
        // Speed is negative when going forward, so use absolute value
        const speedMph = Math.round(Math.abs(this.truck.speed));
        
        // Update speed DOM (cache element reference for performance)
        if (!this._speedEl) {
            this._speedEl = document.getElementById('speed-value');
        }
        if (this._speedEl && this._lastSpeedMph !== speedMph) {
            this._speedEl.textContent = speedMph;
            this._lastSpeedMph = speedMph;
        }
        
        // Update gear display
        if (!this._gearEl) {
            this._gearEl = document.getElementById('gear-value');
        }
        const gearDisplay = this.truck.getGearDisplay();
        if (this._gearEl && this._lastGear !== gearDisplay) {
            this._gearEl.textContent = gearDisplay;
            this._lastGear = gearDisplay;
        }
        
        // Play gear shift sound
        if (this.truck.gearJustChanged) {
            this.audioManager.playSound('gearshift');
            this.truck.gearJustChanged = false;
        }
    }

    applyDebugToggles() {
        if (this.sceneManager) {
            this.sceneManager.setHouseStreamingEnabled(this.debugToggles.houseStreaming);
            this.sceneManager.setFarGroundEnabled(this.debugToggles.farGround);
            this.sceneManager.setPostProcessingEnabled(this.debugToggles.postProcessing);
        }
        if (this.truck) {
            this.truck.enableItemPhysics = this.debugToggles.itemPhysics;
        }
    }

    handleResize(force = false) {
        if (!this.engine || !this.canvas) return;
        if (this._resizeTimer) {
            clearTimeout(this._resizeTimer);
        }
        // Debounce to avoid rapid resizes causing black flashes
        this._resizeTimer = setTimeout(() => {
            const width = this.canvas.clientWidth;
            const height = this.canvas.clientHeight;
            if (!force) {
                if (this._lastCanvasSize &&
                    Math.abs(this._lastCanvasSize.w - width) < 2 &&
                    Math.abs(this._lastCanvasSize.h - height) < 2) {
                    return;
                }
            }
            this._lastCanvasSize = { w: width, h: height };
            this.engine.resize();
            this.applyHardwareScaling();
        }, 120);
    }

    applyHardwareScaling() {
        if (!this.engine) return;
        // Lock to native resolution for sharp rendering (no dynamic scaling)
        const scale = 1.0;
        if (this._hardwareScale !== scale) {
            this._hardwareScale = scale;
            this.engine.setHardwareScalingLevel(this._hardwareScale);
            
        }
    }
    
    onItemFellOut(item) {
        // Item fell out of truck - this is a loss!
        // Only trigger once (prevent multiple calls)
        if (this.fallOutTriggered) return;
        this.fallOutTriggered = true;
        
        
        this.audioManager.playSound('error');
        
        // Short delay then show loss screen
        setTimeout(() => {
            if (!this.isPaused) {
                this.itemFellOutLoss();
            }
        }, 800);
    }
    
    itemFellOutLoss() {
        this.pause();
        
        // Show game over screen with high score submission
        this.highScoreManager.showGameOver(this.currentLevel, 'Item fell out of the truck!');
        
        // Setup play again button - restart current level, not back to level 1
        const btnPlayAgain = document.getElementById('btn-play-again');
        if (btnPlayAgain) {
            btnPlayAgain.onclick = () => {
                this.highScoreManager.hideGameOver();
                this.restartLevel();
                this.resume();
            };
        }
    }
    
    updateScore() {
        const usedVolume = this.truck.getUsedVolume(this.itemManager.placedItems);
        // Truck capacity is fixed at 25 cubic yards
        const cubicYardToCubicMeter = 0.764555;
        const targetCapacityYd = 25;
        // Scale so two green test boxes (2.1 x 1.6 x 2.8 each) equal 25 yd³
        const volumeScale = 1.016;
        // Buffer for real-world inefficiency (voids, odd shapes)
        const bufferFactor = 1.0;
        const usedYd = (usedVolume / cubicYardToCubicMeter) * volumeScale * bufferFactor;

        this.score.spaceEfficiency = Math.round((usedYd / targetCapacityYd) * 100);
        this.score.usedCubicYards = usedYd;
        
        // Stability no longer shown, but kept for internal tracking
        const totalItems = this.itemManager.placedItems.length;
        const stableItems = this.itemManager.getStableItemCount();
        this.score.stability = totalItems > 0 ? Math.round((stableItems / totalItems) * 100) : 100;
    }
    
    checkDestinationArrival() {
        if (this.hasArrivedAtDestination) return;
        
        const dx = this.destination.x - this.truck.position.x;
        const dz = this.destination.z - this.truck.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        
        if (distance <= this.destinationRadius) {
            // Check if all items are loaded first
            const allPlaced = this.itemManager.areAllItemsPlaced();
            if (!allPlaced) {
                // Show a hint that they need to load items first
                return;
            }
            
            
            this.hasArrivedAtDestination = true;
            
            // Auto-brake instead of instantly stopping
            this.truck.applyAutoBrake(0.7);
            
            // Show arrival success after a moment
            setTimeout(() => {
                this.completeLevel();
            }, 500);
        }
    }
    
    generatePickup() {
        // Pickup is a bit away from start - at a nearby grass quadrant
        // Use 100m base distance in a random direction
        const angle = Math.random() * Math.PI * 2;
        const baseDistance = 100;
        
        const rawX = Math.cos(angle) * baseDistance;
        const rawZ = Math.sin(angle) * baseDistance;
        
        // Snap to tile center
        const tileX = Math.round(rawX / 50) * 50;
        const tileZ = Math.round(rawZ / 50) * 50;
        const quadrantCenter = 25;
        
        // Pick the quadrant closest to the raw position
        const quadrantX = rawX >= tileX ? quadrantCenter : -quadrantCenter;
        const quadrantZ = rawZ >= tileZ ? quadrantCenter : -quadrantCenter;
        
        this.pickup.x = tileX + quadrantX;
        this.pickup.z = tileZ + quadrantZ;
        
        // Tell SceneManager to create pickup marker
        this.sceneManager.setPickup(this.pickup.x, this.pickup.z);
        
        
    }
    
    // Spawn items on the ground at pickup location (call after loadLevel)
    spawnGroundItems() {
        // Use the driveway spawn position if available, otherwise use pickup center
        const spawnPos = this.sceneManager.pickupItemSpawn || this.pickup;
        this.itemManager.spawnItemsAtPickup(spawnPos.x, spawnPos.z);
    }
    
    checkPickupProximity() {
        const dx = this.pickup.x - this.truck.position.x;
        const dz = this.pickup.z - this.truck.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        
        const wasAtPickup = this.isAtPickup;
        this.isAtPickup = distance <= this.pickupRadius;
        
        // Update UI if state changed
        if (wasAtPickup !== this.isAtPickup) {
            this.uiManager.setPickupMode(this.isAtPickup, this.itemManager.areAllItemsPlaced());
        }
    }
    
    generateDestination() {
        // Generate destination based on level (further away for higher levels)
        const baseDistance = 200 + (this.currentLevel * 150);
        const angle = Math.random() * Math.PI * 2;
        
        // Calculate raw position
        const rawX = Math.cos(angle) * baseDistance;
        const rawZ = Math.sin(angle) * baseDistance;
        
        // Find the nearest tile center (multiples of 50)
        const tileX = Math.round(rawX / 50) * 50;
        const tileZ = Math.round(rawZ / 50) * 50;
        
        // Position at the tile corner (25m from center)
        // This spans the grass corners of adjacent tiles
        const exactQuadrantCenter = 25;
        const quadrantX = rawX >= tileX ? exactQuadrantCenter : -exactQuadrantCenter;
        const quadrantZ = rawZ >= tileZ ? exactQuadrantCenter : -exactQuadrantCenter;
        
        // Destination is the EXACT grass quadrant center
        this.destination.x = tileX + quadrantX;
        this.destination.z = tileZ + quadrantZ;
        
        // Tell SceneManager to create gravel at exact same position
        this.sceneManager.setDestination(rawX, rawZ);
        
        
    }
    
    pause() {
        this.isPaused = true;
        this.audioManager.pauseAll();
    }
    
    resume() {
        this.isPaused = false;
        this.audioManager.resumeAll();
    }
    
    completeLevel() {
        if (!this.isUrlLevelOverrideActive) {
            // Save high score - they've reached the NEXT level by completing this one
            const reachedLevel = this.currentLevel + 1;
            this.highScoreManager.submitScore(reachedLevel, this.score.spaceEfficiency);
        }
        
        this.uiManager.showResults(this.score, true);
        this.audioManager.playSound('complete');
    }
    
    nextLevel() {
        this.currentLevel++;
        this.resetLevel();
        this.generatePickup();
        this.generateDestination();
        this.levelManager.loadLevel(this.currentLevel, this);
        this.spawnGroundItems();
        this.resume();
    }
    
    restartLevel() {
        this.resetLevel();
        this.generatePickup();
        this.generateDestination();
        this.levelManager.loadLevel(this.currentLevel, this);
        this.spawnGroundItems();
        this.resume();
    }
    
    restartGame() {
        // Reset to level 1 and start fresh
        this.currentLevel = 1;
        this.resetLevel();
        this.generatePickup();
        this.generateDestination();
        this.levelManager.loadLevel(this.currentLevel, this);
        this.spawnGroundItems();
        this.uiManager.updateLevel(this.currentLevel);
        this.resume();
    }

    togglePhysics() {
        this.physicsEnabled = !this.physicsEnabled;
        console.log(`🔧 Physics mode: ${this.physicsEnabled ? 'ENABLED (Havok)' : 'DISABLED (Parented)'}`);
        return this.physicsEnabled;
    }

    resetLevel() {
        this.itemManager.clearAll();
        this.truck.loadedItems = []; // Clear items from truck
        this.truck.position.x = 0; // Reset truck position
        this.truck.position.z = 0;
        this.truck.rotation = 0;
        this.truck.speed = 0;
        this.truck.applyTransform();
        this.score = { spaceEfficiency: 0, stability: 100 };
        this.fallOutTriggered = false; // Reset the fall-out flag
        this.hasArrivedAtDestination = false; // Reset arrival flag
        this.isAtPickup = true; // Reset to at pickup
        this.uiManager.reset();
    }
    
    quit() {
        this.resetLevel();
        this.isRunning = false;
        
        // Stop the engine sound
        this.audioManager.stopEngine();
        
        // Remove pickup and destination markers
        this.sceneManager.removePickup();
        this.sceneManager.removeDestination();
        
        // Animate camera back to title view (smooth transition)
        this.sceneManager.animateToTitle(1000);
        
        this.uiManager.showStartScreen();
    }
}
