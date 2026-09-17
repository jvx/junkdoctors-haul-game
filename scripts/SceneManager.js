/**
 * SceneManager - Handles 3D scene, lighting, and camera
 */
class SceneManager {
    constructor(engine, canvas) {
        this.engine = engine;
        this.canvas = canvas;
        this.scene = null;
        this.camera = null;
        this.shadowGenerator = null;
        this.followTarget = null; // Target to follow (truck)
        this.cameraAngleOffset = 0; // Smoothed manual look, independent of truck heading
        this.keyAngleOffset = 0; // Arrow key horizontal offset
        this.mouseAngleOffset = 0; // Mouse drag horizontal offset
        this.touchAngleOffset = 0; // Touch joystick horizontal offset
        this.cameraBetaOffset = 0;  // Manual vertical camera offset from arrow keys
        this.touchBetaOffset = 0; // Touch joystick vertical offset
        this.cameraKeys = { left: false, right: false, up: false, down: false };
        this.isMouseLooking = false; // Track if user is dragging with mouse
        this.isTouchLooking = false; // Track if user is using touch joystick
        this.isTitleView = true; // Start in title view
        this.cameraFollowEnabled = false; // Don't follow until game starts
        this.itemManager = null; // Reference to check if item is being held
        this.pendingHouseTiles = [];
        this.pendingHouseTileSet = new Set();
        this.visualsByTile = {};
        this._houseWorkScheduled = false;
        this.houseStreamingEnabled = true;
        this.farGroundEnabled = true;
        this.debugDestinationTiles = false;
        this._houseStreamingLogTime = 0;
        this.destinationTileKey = null;
        this.pickupTileKey = null;
        this._neededTiles = new Set();
        this._houseNeededTiles = new Set();
        this.initCameraControls();
    }

    logDestinationDebug(...args) {
        if (!this.debugDestinationTiles) return;
        const serialize = (value) => {
            try {
                return JSON.stringify(value);
            } catch (err) {
                return String(value);
            }
        };
        const parts = args.map(arg => (typeof arg === 'object' ? serialize(arg) : String(arg)));
        console.log('[DEST TILE]', parts.join(' '));
    }
    
    initCameraControls() {
        // Arrow keys to look around
        window.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') this.cameraKeys.left = true;
            if (e.key === 'ArrowRight') this.cameraKeys.right = true;
            if (e.key === 'ArrowUp') this.cameraKeys.up = true;
            if (e.key === 'ArrowDown') this.cameraKeys.down = true;
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === 'ArrowLeft') this.cameraKeys.left = false;
            if (e.key === 'ArrowRight') this.cameraKeys.right = false;
            if (e.key === 'ArrowUp') this.cameraKeys.up = false;
            if (e.key === 'ArrowDown') this.cameraKeys.down = false;
        });
        
        // Manual mouse drag for camera look-around (desktop only - mobile uses joysticks)
        this.mouseDragStart = null;
        this.mouseDragButton = -1;
        this.isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        
        this.canvas.addEventListener('pointerdown', (e) => {
            // Skip touch events on mobile - use joysticks instead
            if (this.isMobile && e.pointerType === 'touch') return;
            
            // Track any button press for potential drag
            this.mouseDragStart = { x: e.clientX, y: e.clientY };
            this.mouseDragButton = e.button;
            this.mouseDragMoved = false;
        });
        
        window.addEventListener('pointermove', (e) => {
            // Skip touch events on mobile
            if (this.isMobile && e.pointerType === 'touch') return;
            
            // Skip camera drag if an item is being held (to allow item placement)
            if (this.itemManager && this.itemManager.previewMesh) {
                return;
            }
            
            if (this.mouseDragStart && this.mouseDragButton !== -1) {
                const dx = e.clientX - this.mouseDragStart.x;
                const dy = e.clientY - this.mouseDragStart.y;
                
                // Only consider it a drag if moved more than 5px
                if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                    this.mouseDragMoved = true;
                    this.isMouseLooking = true;
                    
                    // Apply rotation based on drag delta
                    const sensitivity = 0.005;
                    this.mouseAngleOffset -= dx * sensitivity;
                    this.cameraBetaOffset -= dy * sensitivity * 0.5;
                    
                    // Clamp offsets
                    const maxAlphaOffset = Math.PI * 0.8;
                    const maxBetaOffset = 0.5;
                    this.mouseAngleOffset = Math.max(-maxAlphaOffset, Math.min(maxAlphaOffset, this.mouseAngleOffset));
                    this.cameraBetaOffset = Math.max(-maxBetaOffset, Math.min(maxBetaOffset, this.cameraBetaOffset));
                    
                    // Update start position for continuous drag
                    this.mouseDragStart = { x: e.clientX, y: e.clientY };
                }
            }
        });
        
        window.addEventListener('pointerup', (e) => {
            // Skip touch events on mobile
            if (this.isMobile && e.pointerType === 'touch') return;
            
            if (e.button === this.mouseDragButton) {
                this.mouseDragStart = null;
                this.mouseDragButton = -1;
                this.isMouseLooking = false;
            }
        });
    }
    
    updateCameraLook(deltaTime = 1 / 60) {
        const rotateSpeed = 1.8 * deltaTime;
        const returnSpeed = 1 - Math.pow(0.95, deltaTime * 60);
        const maxAlphaOffset = Math.PI * 0.8; // Max ~145 degrees look around horizontally
        const maxBetaOffset = 0.5; // Max vertical offset
        
        // Apply horizontal rotation while arrow keys held
        if (this.cameraKeys.left) {
            this.keyAngleOffset += rotateSpeed;
        }
        if (this.cameraKeys.right) {
            this.keyAngleOffset -= rotateSpeed;
        }
        
        // Apply vertical rotation while arrow keys held
        if (this.cameraKeys.up) {
            this.cameraBetaOffset += rotateSpeed; // Up arrow = look up (higher beta)
        }
        if (this.cameraKeys.down) {
            this.cameraBetaOffset -= rotateSpeed; // Down arrow = look down (lower beta)
        }
        
        // Clamp the offsets
        this.keyAngleOffset = Math.max(-maxAlphaOffset, Math.min(maxAlphaOffset, this.keyAngleOffset));
        this.cameraBetaOffset = Math.max(-maxBetaOffset, Math.min(maxBetaOffset, this.cameraBetaOffset));
        
        // Smoothly return to center when no keys pressed AND not mouse/touch dragging
        const noHorizontalKeys = !this.cameraKeys.left && !this.cameraKeys.right;
        const noVerticalKeys = !this.cameraKeys.up && !this.cameraKeys.down;
        const notLooking = !this.isMouseLooking && !this.isTouchLooking;
        
        if (noHorizontalKeys && notLooking) {
            this.keyAngleOffset *= (1 - returnSpeed);
            if (Math.abs(this.keyAngleOffset) < 0.01) {
                this.keyAngleOffset = 0;
            }
        }

        if (!this.isMouseLooking) {
            this.mouseAngleOffset *= (1 - returnSpeed);
            if (Math.abs(this.mouseAngleOffset) < 0.01) {
                this.mouseAngleOffset = 0;
            }
        }
        
        // Touch offset returns to center when not touching
        if (!this.isTouchLooking) {
            this.touchAngleOffset *= (1 - returnSpeed);
            this.touchBetaOffset *= (1 - returnSpeed);
            if (Math.abs(this.touchAngleOffset) < 0.01) this.touchAngleOffset = 0;
            if (Math.abs(this.touchBetaOffset) < 0.01) this.touchBetaOffset = 0;
        }
        
        if (noVerticalKeys && notLooking) {
            this.cameraBetaOffset *= (1 - returnSpeed);
            if (Math.abs(this.cameraBetaOffset) < 0.01) {
                this.cameraBetaOffset = 0;
            }
        }
    }
    
    async createScene() {
        this.scene = new BABYLON.Scene(this.engine);
        // Brighter sky-blue base to avoid stormy look
        this.scene.clearColor = new BABYLON.Color4(0.6, 0.78, 0.95, 1);
        // Distance fog so far ground fades into sky
        this.scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
        this.scene.fogColor = new BABYLON.Color3(0.6, 0.78, 0.95);
        this.scene.fogStart = 600;
        this.scene.fogEnd = 2500;
        
        // Scene optimizations for consistent frame rendering
        this.scene.skipPointerMovePicking = true; // Don't pick on pointer move
        this.scene.autoClear = true;
        this.scene.autoClearDepthAndStencil = true;
        
        // Enable Havok physics (better performance and collision detection)
        const havokInstance = await HavokPhysics();
        const havokPlugin = new BABYLON.HavokPlugin(true, havokInstance);
        this.scene.enablePhysics(
            new BABYLON.Vector3(0, -9.81, 0),
            havokPlugin
        );
        this.havokPlugin = havokPlugin;
        
        // Use a high-precision fixed timestep for Havok cargo physics.
        // Smaller steps reduce contact jitter and false launch impulses when
        // items meet the moving truck bed or walls.
        if (havokPlugin.setTimeStep) {
            havokPlugin.setTimeStep(1 / 120);
        }
        
        // Babylon stores sub timestep in milliseconds, then passes seconds to
        // the plugin. Match the 120 Hz fixed step without creating excess work.
        if (this.scene.getPhysicsEngine()) {
            const physicsEngine = this.scene.getPhysicsEngine();
            if (physicsEngine.setSubTimeStep) {
                physicsEngine.setSubTimeStep(1000 / 120);
            }
        }
        
        this.createCamera();
        this.createLighting();
        this.createEnvironment();
        this.createGround();
        this.setupPostProcessing();
        
        return this.scene;
    }
    
    createCamera() {
        // Title view: side/rear angle of truck
        this.titleCameraSettings = {
            alpha: Math.PI * 0.75,  // Side-rear view (135 degrees)
            beta: Math.PI / 2.8,    // Slightly above horizontal
            radius: 14,
            target: new BABYLON.Vector3(0, 1.2, 0)
        };
        
        // Gameplay view: behind truck, looking further ahead
        this.gameplayCameraSettings = {
            alpha: Math.PI / 2,     // Behind truck
            beta: Math.PI / 2.45,    // More horizontal to see further down the road
            radius: 15,
            target: new BABYLON.Vector3(0, 1.5, 0)
        };
        
        // Start with title view
        this.camera = new BABYLON.ArcRotateCamera(
            'mainCamera',
            this.titleCameraSettings.alpha,
            this.titleCameraSettings.beta,
            this.titleCameraSettings.radius,
            this.titleCameraSettings.target.clone(),
            this.scene
        );
        
        this.camera.lowerRadiusLimit = 15;
        this.camera.upperRadiusLimit = 15;  // Lock zoom completely
        this.camera.lowerBetaLimit = 0.3;
        this.camera.upperBetaLimit = Math.PI / 2.1;
        this.camera.inertia = 0.9;
        this.camera.maxZ = 50000; // Far clip plane for far ground
        this.camera.attachControl(this.canvas, true);
        this.camera.panningSensibility = 0;  // Disable panning
        
        // Completely disable built-in pointer rotation - we handle it manually
        this.camera.inputs.removeByType('ArcRotateCameraPointersInput');
        
        // Completely disable built-in keyboard controls - we handle arrow keys manually
        this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
        
        // Completely disable wheel zoom
        this.camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
    }
    
    // Animate camera from title view to gameplay view
    animateToGameplay(duration = 1500) {
        this.isTitleView = false;
        this.cameraAngleOffset = 0;
        
        const fps = 60;
        const frames = duration / 1000 * fps;
        
        // Get the truck's current position for target
        const truck = this.followTarget;
        const endTargetY = truck ? truck.cargoFloorHeight + 0.5 : 1.5;
        
        // Calculate end alpha based on truck rotation (so no jump when follow kicks in)
        const endAlpha = truck ? (-truck.rotation + Math.PI / 2) : this.gameplayCameraSettings.alpha;
        
        // Alpha animation
        const alphaAnim = new BABYLON.Animation('cameraAlpha', 'alpha', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        alphaAnim.setKeys([
            { frame: 0, value: this.camera.alpha },
            { frame: frames, value: endAlpha }
        ]);
        
        // Beta animation
        const betaAnim = new BABYLON.Animation('cameraBeta', 'beta', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        betaAnim.setKeys([
            { frame: 0, value: this.camera.beta },
            { frame: frames, value: this.gameplayCameraSettings.beta }
        ]);
        
        // Radius animation
        const radiusAnim = new BABYLON.Animation('cameraRadius', 'radius', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        radiusAnim.setKeys([
            { frame: 0, value: this.camera.radius },
            { frame: frames, value: this.gameplayCameraSettings.radius }
        ]);
        
        // Track animation progress for blending
        const animStartTime = performance.now();
        
        // Keep camera locked to truck during pan (instant - no friction)
        let targetObserver = null;
        if (truck) {
            // Calculate initial offset from "behind truck" angle
            const behindTruckAlpha = -truck.rotation + Math.PI / 2;
            let startOffset = this.camera.alpha - behindTruckAlpha;
            // Normalize to [-PI, PI]
            while (startOffset > Math.PI) startOffset -= Math.PI * 2;
            while (startOffset < -Math.PI) startOffset += Math.PI * 2;
            
            targetObserver = this.scene.onBeforeRenderObservable.add(() => {
                // Instant lock to truck position - no smoothing/friction
                this.camera.target.x = truck.position.x;
                this.camera.target.y = endTargetY;
                this.camera.target.z = truck.position.z;
                
                // Smoothly reduce offset from "behind truck" angle to 0
                const animProgress = Math.min(1, (performance.now() - animStartTime) / duration);
                const currentOffset = startOffset * (1 - this.easeInOut(animProgress));
                
                // Apply: behind truck angle + remaining offset
                const truckAlpha = -truck.rotation + Math.PI / 2;
                this.camera.alpha = truckAlpha + currentOffset;
            });
        }
        
        // Easing for beta and radius only (alpha handled above to track truck rotation)
        const easingFunction = new BABYLON.CubicEase();
        easingFunction.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
        betaAnim.setEasingFunction(easingFunction);
        radiusAnim.setEasingFunction(easingFunction);
        
        // Only animate beta and radius - alpha is handled manually
        this.camera.animations = [betaAnim, radiusAnim];
        
        this.scene.beginAnimation(this.camera, 0, frames, false, 1, () => {
            // Animation complete - enable camera following
            this.cameraFollowEnabled = true;
            if (targetObserver) {
                this.scene.onBeforeRenderObservable.remove(targetObserver);
            }
        });
    }
    
    // Easing helper
    easeInOut(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }
    
    // Reset to title view (instant)
    resetToTitleView() {
        this.isTitleView = true;
        this.cameraFollowEnabled = false;
        this.camera.alpha = this.titleCameraSettings.alpha;
        this.camera.beta = this.titleCameraSettings.beta;
        this.camera.radius = this.titleCameraSettings.radius;
        this.camera.target = this.titleCameraSettings.target.clone();
    }
    
    // Animate camera back to title view
    animateToTitle(duration = 1000) {
        this.isTitleView = true;
        this.cameraFollowEnabled = false;
        
        const fps = 60;
        const frames = duration / 1000 * fps;
        
        // Alpha animation
        const alphaAnim = new BABYLON.Animation('cameraAlpha', 'alpha', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        alphaAnim.setKeys([
            { frame: 0, value: this.camera.alpha },
            { frame: frames, value: this.titleCameraSettings.alpha }
        ]);
        
        // Beta animation
        const betaAnim = new BABYLON.Animation('cameraBeta', 'beta', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        betaAnim.setKeys([
            { frame: 0, value: this.camera.beta },
            { frame: frames, value: this.titleCameraSettings.beta }
        ]);
        
        // Radius animation
        const radiusAnim = new BABYLON.Animation('cameraRadius', 'radius', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        radiusAnim.setKeys([
            { frame: 0, value: this.camera.radius },
            { frame: frames, value: this.titleCameraSettings.radius }
        ]);
        
        // Target animations
        const targetXAnim = new BABYLON.Animation('cameraTargetX', 'target.x', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        targetXAnim.setKeys([
            { frame: 0, value: this.camera.target.x },
            { frame: frames, value: this.titleCameraSettings.target.x }
        ]);
        
        const targetYAnim = new BABYLON.Animation('cameraTargetY', 'target.y', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        targetYAnim.setKeys([
            { frame: 0, value: this.camera.target.y },
            { frame: frames, value: this.titleCameraSettings.target.y }
        ]);
        
        const targetZAnim = new BABYLON.Animation('cameraTargetZ', 'target.z', fps,
            BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        targetZAnim.setKeys([
            { frame: 0, value: this.camera.target.z },
            { frame: frames, value: this.titleCameraSettings.target.z }
        ]);
        
        // Add easing for smooth animation
        const easingFunction = new BABYLON.CubicEase();
        easingFunction.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
        alphaAnim.setEasingFunction(easingFunction);
        betaAnim.setEasingFunction(easingFunction);
        radiusAnim.setEasingFunction(easingFunction);
        targetXAnim.setEasingFunction(easingFunction);
        targetYAnim.setEasingFunction(easingFunction);
        targetZAnim.setEasingFunction(easingFunction);
        
        this.camera.animations = [alphaAnim, betaAnim, radiusAnim, targetXAnim, targetYAnim, targetZAnim];
        this.scene.beginAnimation(this.camera, 0, frames, false);
    }
    
    // Create or update destination marker in 3D world
    // x, z = destination position (will be snapped to a grass quadrant)
    setDestination(x, z) {
        // Dispose old markers if they exist
        this.removeDestination();
        
        // Snap to exact tile center
        const tileX = Math.round(x / this.groundTileSize) * this.groundTileSize;
        const tileZ = Math.round(z / this.groundTileSize) * this.groundTileSize;
        this.destinationTileKey = `${Math.round(tileX / this.groundTileSize)}_${Math.round(tileZ / this.groundTileSize)}`;
        
        // Position the beacon in a GRASS QUADRANT (not at intersection)
        // Grass quadrant center is 15.625m from tile center
        const quadrantOffset = 15.625;
        // Pick the quadrant based on which direction the raw position was from tile center
        const quadrantX = x >= tileX ? quadrantOffset : -quadrantOffset;
        const quadrantZ = z >= tileZ ? quadrantOffset : -quadrantOffset;
        const beaconX = tileX + quadrantX;
        const beaconZ = tileZ + quadrantZ;
        
        // Store destination position (beacon position - where player drives to)
        this.destinationPos = { x: beaconX, z: beaconZ, tileX, tileZ };
        
        // For a 37.5m pad to span across adjacent grass areas,
        // center it at the tile corner (25m from tile center)
        // This puts the pad over the grass corners of 4 adjacent tiles
        const quadrantCenter = 25;
        const exactBeaconX = tileX + (x >= tileX ? quadrantCenter : -quadrantCenter);
        const exactBeaconZ = tileZ + (z >= tileZ ? quadrantCenter : -quadrantCenter);
        
        
        
        // Update stored position to exact values
        this.destinationPos.x = exactBeaconX;
        this.destinationPos.z = exactBeaconZ;
        
        // Wall enclosure size matches grass quadrant exactly (stays on grass, not street)
        const wallSize = 37.5;
        const halfWall = wallSize / 2;
        
        // Gravel pad matches wall size exactly
        const padSize = wallSize;
        
        // Create a square grass underlay to cover the rounded outer corner of the texture
        // This sits just above the main ground and provides square corners
        this.destinationGrassUnderlay = BABYLON.MeshBuilder.CreateGround('destGrassUnderlay', {
            width: padSize,
            height: padSize
        }, this.scene);
        this.destinationGrassUnderlay.position = new BABYLON.Vector3(exactBeaconX, 0.01, exactBeaconZ);
        this.destinationGrassUnderlay.isPickable = false;
        const grassMat = new BABYLON.StandardMaterial('destGrassMat', this.scene);
        grassMat.diffuseColor = new BABYLON.Color3(0.1, 0.18, 0.1); // Match grass color #1a2e1a
        grassMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
        this.destinationGrassUnderlay.material = grassMat;
        
        // Gravel pad on top
        this.destinationGround = BABYLON.MeshBuilder.CreateGround('destGround', {
            width: padSize,
            height: padSize
        }, this.scene);
        // Gravel pad centered on grass quadrant, slightly above ground to prevent z-fighting
        this.destinationGround.position = new BABYLON.Vector3(exactBeaconX, 0.02, exactBeaconZ);
        this.destinationGround.isPickable = false;
        
        // Create gravel texture
        const gravelTex = this.createGravelTexture();
        const groundMat = new BABYLON.StandardMaterial('destGroundMat', this.scene);
        groundMat.diffuseTexture = gravelTex;
        groundMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
        this.destinationGround.material = groundMat;
        
        // Create walls around the destination (3 sides, 1 entrance)
        const wallHeight = 3;
        const wallThickness = 0.5;
        
        // Wall material - concrete grey
        const wallMat = new BABYLON.StandardMaterial('destWallMat', this.scene);
        wallMat.diffuseColor = new BABYLON.Color3(0.55, 0.55, 0.52);
        wallMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        
        this.destinationWalls = [];
        
        // Determine which side faces the road (toward tile center)
        const signX = x >= tileX ? 1 : -1;
        const signZ = z >= tileZ ? 1 : -1;
        this.destinationTileOverrides = this.buildDestinationTileOverrides(tileX, tileZ, signX, signZ, exactBeaconX, exactBeaconZ);
        
        // Rebuild houses for the 4 tiles around the drop-off corner
        // (createHousesForTile will skip the destination quadrant only)
        const destTileKeys = Object.keys(this.destinationTileOverrides);
        destTileKeys.forEach(tileKey => {
            const [gridX, gridZ] = tileKey.split('_').map(Number);
            this.createHousesForTile(gridX, gridZ);
        });

        // Force regeneration of houses for tiles SURROUNDING the destination
        // (covers any tiles left empty from previous destination removal)
        const destGridX = Math.floor(tileX / this.groundTileSize);
        const destGridZ = Math.floor(tileZ / this.groundTileSize);
        for (let dx = -2; dx <= 3; dx++) {
            for (let dz = -2; dz <= 3; dz++) {
                const surroundKey = `${destGridX + dx}_${destGridZ + dz}`;
                // Skip the 4 destination tiles themselves
                if (this.destinationTileOverrides[surroundKey]) continue;
                // Recreate if missing or empty
                if (!this.hasLiveHouses(surroundKey)) {
                    this.createHousesForTile(destGridX + dx, destGridZ + dz);
                }
            }
        }
        
        this.logDestinationDebug('setDestination', {
            tileX,
            tileZ,
            signX,
            signZ,
            exactBeaconX,
            exactBeaconZ,
            destinationTileKey: this.destinationTileKey,
            overrides: this.destinationTileOverrides
        });
        this.ensureDestinationTileMaterials();
        this.applyDestinationTileMaterials();
        
        // Back wall (far X side) - full length, inside perimeter
        const backWall = BABYLON.MeshBuilder.CreateBox('destWallBack', {
            width: wallSize,
            height: wallHeight,
            depth: wallThickness
        }, this.scene);
        backWall.position = new BABYLON.Vector3(
            exactBeaconX + signX * (halfWall - wallThickness / 2),
            wallHeight / 2,
            exactBeaconZ
        );
        backWall.rotation.y = Math.PI / 2;
        backWall.material = wallMat;
        backWall.isPickable = false;
        this.destinationWalls.push(backWall);
        
        // Front wall (near X side) - full length, inside perimeter
        const frontWall = BABYLON.MeshBuilder.CreateBox('destWallFront', {
            width: wallSize,
            height: wallHeight,
            depth: wallThickness
        }, this.scene);
        frontWall.position = new BABYLON.Vector3(
            exactBeaconX - signX * (halfWall - wallThickness / 2),
            wallHeight / 2,
            exactBeaconZ
        );
        frontWall.rotation.y = Math.PI / 2;
        frontWall.material = wallMat;
        frontWall.isPickable = false;
        this.destinationWalls.push(frontWall);
        
        // Side wall 1 (far Z side) - inside perimeter
        const sideWall1 = BABYLON.MeshBuilder.CreateBox('destWallSide1', {
            width: wallSize,
            height: wallHeight,
            depth: wallThickness
        }, this.scene);
        sideWall1.position = new BABYLON.Vector3(
            exactBeaconX,
            wallHeight / 2,
            exactBeaconZ + signZ * (halfWall - wallThickness / 2)
        );
        sideWall1.material = wallMat;
        sideWall1.isPickable = false;
        this.destinationWalls.push(sideWall1);
        
        // Side wall 2 (near Z side with entrance) - two segments with gap, inside perimeter
        const entranceWidth = 10; // 10m wide entrance
        const sideWallLength = (wallSize - entranceWidth) / 2;
        
        // Left part of entrance wall (toward back wall)
        const sideWall2L = BABYLON.MeshBuilder.CreateBox('destWallSide2L', {
            width: sideWallLength,
            height: wallHeight,
            depth: wallThickness
        }, this.scene);
        sideWall2L.position = new BABYLON.Vector3(
            exactBeaconX + signX * (halfWall - sideWallLength / 2),
            wallHeight / 2,
            exactBeaconZ - signZ * (halfWall - wallThickness / 2)
        );
        sideWall2L.material = wallMat;
        sideWall2L.isPickable = false;
        this.destinationWalls.push(sideWall2L);
        
        // Right part of entrance wall (toward front wall)
        const sideWall2R = BABYLON.MeshBuilder.CreateBox('destWallSide2R', {
            width: sideWallLength,
            height: wallHeight,
            depth: wallThickness
        }, this.scene);
        sideWall2R.position = new BABYLON.Vector3(
            exactBeaconX - signX * (halfWall - sideWallLength / 2),
            wallHeight / 2,
            exactBeaconZ - signZ * (halfWall - wallThickness / 2)
        );
        sideWall2R.material = wallMat;
        sideWall2R.isPickable = false;
        this.destinationWalls.push(sideWall2R);
        
        // Store wall bounds for truck collision detection
        // Calculate bounds based on actual wall center positions (matching visual walls)
        // Back wall center: exactBeaconX + signX * (halfWall - wallThickness / 2), rotated 90°
        const backWallCenterX = exactBeaconX + signX * (halfWall - wallThickness / 2);
        // Front wall center: exactBeaconX - signX * (halfWall - wallThickness / 2), rotated 90°
        const frontWallCenterX = exactBeaconX - signX * (halfWall - wallThickness / 2);
        // Side wall 1 center Z: exactBeaconZ + signZ * (halfWall - wallThickness / 2)
        const sideWall1CenterZ = exactBeaconZ + signZ * (halfWall - wallThickness / 2);
        // Side wall 2 (entrance) center Z: exactBeaconZ - signZ * (halfWall - wallThickness / 2)
        const sideWall2CenterZ = exactBeaconZ - signZ * (halfWall - wallThickness / 2);
        // Side wall 2L center X
        const sideWall2LCenterX = exactBeaconX + signX * (halfWall - sideWallLength / 2);
        // Side wall 2R center X
        const sideWall2RCenterX = exactBeaconX - signX * (halfWall - sideWallLength / 2);
        
        this.destinationWallBounds = [
            // Back wall (far X side) - rotated 90°, so X extent = wallThickness, Z extent = wallSize
            { 
                minX: backWallCenterX - wallThickness / 2,
                maxX: backWallCenterX + wallThickness / 2,
                minZ: exactBeaconZ - halfWall,
                maxZ: exactBeaconZ + halfWall
            },
            // Front wall (near X side) - rotated 90°, so X extent = wallThickness, Z extent = wallSize
            { 
                minX: frontWallCenterX - wallThickness / 2,
                maxX: frontWallCenterX + wallThickness / 2,
                minZ: exactBeaconZ - halfWall,
                maxZ: exactBeaconZ + halfWall
            },
            // Side wall 1 (far Z side) - not rotated, X extent = wallSize, Z extent = wallThickness
            { 
                minX: exactBeaconX - halfWall,
                maxX: exactBeaconX + halfWall,
                minZ: sideWall1CenterZ - wallThickness / 2,
                maxZ: sideWall1CenterZ + wallThickness / 2
            },
            // Side wall 2L (entrance left) - not rotated, X extent = sideWallLength, Z extent = wallThickness
            { 
                minX: Math.min(sideWall2LCenterX - sideWallLength / 2, sideWall2LCenterX + sideWallLength / 2),
                maxX: Math.max(sideWall2LCenterX - sideWallLength / 2, sideWall2LCenterX + sideWallLength / 2),
                minZ: sideWall2CenterZ - wallThickness / 2,
                maxZ: sideWall2CenterZ + wallThickness / 2
            },
            // Side wall 2R (entrance right) - not rotated, X extent = sideWallLength, Z extent = wallThickness
            { 
                minX: Math.min(sideWall2RCenterX - sideWallLength / 2, sideWall2RCenterX + sideWallLength / 2),
                maxX: Math.max(sideWall2RCenterX - sideWallLength / 2, sideWall2RCenterX + sideWallLength / 2),
                minZ: sideWall2CenterZ - wallThickness / 2,
                maxZ: sideWall2CenterZ + wallThickness / 2
            },
        ];
        
        // Create glowing pillar/beacon at exact grass quadrant center
        const beamHeight = 50;
        this.destinationBeam = BABYLON.MeshBuilder.CreateCylinder('destBeam', {
            height: beamHeight,
            diameterTop: 0.5,
            diameterBottom: 3,
            tessellation: 16
        }, this.scene);
        this.destinationBeam.position = new BABYLON.Vector3(exactBeaconX, beamHeight / 2, exactBeaconZ);
        this.destinationBeam.isPickable = false;
        
        const beamMat = new BABYLON.StandardMaterial('destBeamMat', this.scene);
        beamMat.emissiveColor = new BABYLON.Color3(0.13, 0.77, 0.37); // Green glow
        beamMat.alpha = 0.4;
        beamMat.disableLighting = true;
        this.destinationBeam.material = beamMat;
        
        // Create target circle at exact grass quadrant center
        this.destinationCircle = BABYLON.MeshBuilder.CreateDisc('destCircle', {
            radius: 6,
            tessellation: 32
        }, this.scene);
        this.destinationCircle.rotation.x = Math.PI / 2;
        this.destinationCircle.position = new BABYLON.Vector3(exactBeaconX, 0.08, exactBeaconZ);
        this.destinationCircle.isPickable = false;
        
        const circleMat = new BABYLON.StandardMaterial('destCircleMat', this.scene);
        circleMat.emissiveColor = new BABYLON.Color3(0.13, 0.77, 0.37);
        circleMat.alpha = 0.5;
        circleMat.disableLighting = true;
        this.destinationCircle.material = circleMat;
        
        // Create floating marker at exact grass quadrant center
        this.destinationMarker = BABYLON.MeshBuilder.CreateTorus('destMarker', {
            diameter: 8,
            thickness: 1,
            tessellation: 24
        }, this.scene);
        this.destinationMarker.position = new BABYLON.Vector3(exactBeaconX, 6, exactBeaconZ);
        this.destinationMarker.isPickable = false;
        
        const markerMat = new BABYLON.StandardMaterial('destMarkerMat', this.scene);
        markerMat.emissiveColor = new BABYLON.Color3(0.13, 0.77, 0.37);
        markerMat.disableLighting = true;
        this.destinationMarker.material = markerMat;
        
        // Animate the marker (bobbing and rotating)
        this.scene.registerBeforeRender(() => {
            if (this.destinationMarker && !this.destinationMarker.isDisposed()) {
                this.destinationMarker.rotation.y += 0.02;
                this.destinationMarker.position.y = 6 + Math.sin(Date.now() / 500) * 1.5;
            }
            if (this.destinationBeam && !this.destinationBeam.isDisposed()) {
                // Pulse the beam alpha
                this.destinationBeam.material.alpha = 0.3 + Math.sin(Date.now() / 300) * 0.15;
            }
        });
    }
    
    removeDestination() {
        const prevDestinationTiles = this.destinationTileOverrides
            ? Object.keys(this.destinationTileOverrides)
            : [];
        if (this.destinationMarker) {
            this.destinationMarker.dispose();
            this.destinationMarker = null;
        }
        if (this.destinationBeam) {
            this.destinationBeam.dispose();
            this.destinationBeam = null;
        }
        if (this.destinationCircle) {
            this.destinationCircle.dispose();
            this.destinationCircle = null;
        }
        if (this.destinationGround) {
            this.destinationGround.dispose();
            this.destinationGround = null;
        }
        if (this.destinationGrassUnderlay) {
            this.destinationGrassUnderlay.dispose();
            this.destinationGrassUnderlay = null;
        }
        if (this.destinationWalls) {
            this.destinationWalls.forEach(wall => wall.dispose());
            this.destinationWalls = null;
        }
        if (this.destinationTileMaterials) {
            // Reset any tiles using destination materials
            this.destinationTileOverrides = null;
            this.applyDestinationTileMaterials();
            for (const key in this.destinationTileMaterials) {
                this.destinationTileMaterials[key].dispose();
            }
            this.destinationTileMaterials = null;
        }
        if (this.destinationTileTextures) {
            for (const key in this.destinationTileTextures) {
                this.destinationTileTextures[key].dispose();
            }
            this.destinationTileTextures = null;
        }
        this.destinationTileOverrides = null;
        this.destinationWallBounds = null;
        if (this.debugQuadrant) {
            this.debugQuadrant.dispose();
            this.debugQuadrant = null;
        }
        this.destinationPos = null;
        this.destinationTileKey = null;

        // Regenerate houses on tiles that used to be part of the destination block
        if (prevDestinationTiles.length > 0) {
            prevDestinationTiles.forEach(tileKey => {
                const [gridX, gridZ] = tileKey.split('_').map(Number);
                this.createHousesForTile(gridX, gridZ);
            });
        }
    }
    
    // Create pickup location at a house with items beside driveway
    setPickup(x, z) {
        this.removePickup();
        
        // Calculate tile - use Math.floor to match house generation tile keys
        const gridX = Math.floor(x / this.groundTileSize);
        const gridZ = Math.floor(z / this.groundTileSize);
        const tileX = gridX * this.groundTileSize;
        const tileZ = gridZ * this.groundTileSize;
        this.pickupTileKey = `${gridX}_${gridZ}`;
        const roadHalf = this.groundTileSize * 0.125; // 6.25m from center
        
        // House parameters
        const houseWidth = 12;
        const houseDepth = 14;
        const houseHeight = 6;
        
        // Position house in the quadrant, offset from center
        const localX = x - tileX;
        const localZ = z - tileZ;
        const houseX = x;
        const houseZ = z;
        
        // Determine driveway direction based on which road is closest
        let drivewayDir, drivewayX, drivewayZ, itemSpawnX, itemSpawnZ;
        
        if (Math.abs(localX) > Math.abs(localZ)) {
            // Vertical road is closer
            if (localX > 0) {
                // House is in +X quadrant, driveway goes -X toward road
                drivewayDir = 'toVerticalFromRight';
                drivewayX = houseX - houseWidth / 2 - 4;
                drivewayZ = houseZ;
            } else {
                // House is in -X quadrant, driveway goes +X toward road
                drivewayDir = 'toVerticalFromLeft';
                drivewayX = houseX + houseWidth / 2 + 4;
                drivewayZ = houseZ;
            }
        } else {
            // Horizontal road is closer
            if (localZ > 0) {
                // House is in +Z quadrant, driveway goes -Z toward road
                drivewayDir = 'toHorizontalFromTop';
                drivewayX = houseX;
                drivewayZ = houseZ - houseDepth / 2 - 4;
            } else {
                // House is in -Z quadrant, driveway goes +Z toward road
                drivewayDir = 'toHorizontalFromBottom';
                drivewayX = houseX;
                drivewayZ = houseZ + houseDepth / 2 + 4;
            }
        }

        // Spawn items near the driveway, pushed toward the road and away from the house bounds
        const spawnOffset = 2.5;
        itemSpawnX = drivewayX;
        itemSpawnZ = drivewayZ;
        if (drivewayDir === 'toVerticalFromRight') itemSpawnX -= spawnOffset;
        if (drivewayDir === 'toVerticalFromLeft') itemSpawnX += spawnOffset;
        if (drivewayDir === 'toHorizontalFromTop') itemSpawnZ -= spawnOffset;
        if (drivewayDir === 'toHorizontalFromBottom') itemSpawnZ += spawnOffset;
        
        const houseMinX = houseX - houseWidth / 2 - 0.5;
        const houseMaxX = houseX + houseWidth / 2 + 0.5;
        const houseMinZ = houseZ - houseDepth / 2 - 0.5;
        const houseMaxZ = houseZ + houseDepth / 2 + 0.5;
        const insideHouse = itemSpawnX >= houseMinX && itemSpawnX <= houseMaxX &&
            itemSpawnZ >= houseMinZ && itemSpawnZ <= houseMaxZ;
        if (insideHouse) {
            if (drivewayDir === 'toVerticalFromRight') itemSpawnX = houseMinX - 1.5;
            if (drivewayDir === 'toVerticalFromLeft') itemSpawnX = houseMaxX + 1.5;
            if (drivewayDir === 'toHorizontalFromTop') itemSpawnZ = houseMinZ - 1.5;
            if (drivewayDir === 'toHorizontalFromBottom') itemSpawnZ = houseMaxZ + 1.5;
        }
        
        this.pickupPos = { x: houseX, z: houseZ };
        this.pickupItemSpawn = { x: itemSpawnX, z: itemSpawnZ };
        
        // Only exclude the pickup tile itself from auto-generation
        this.pickupExcludedTiles = new Set();
        this.pickupExcludedTiles.add(this.pickupTileKey);
        
        // Remove houses from the pickup tile
        this.removeHousesInTileKey(this.pickupTileKey);
        
        // Create the pickup house
        const matIndex = Math.floor(Math.random() * this.houseMaterials.length);
        const mats = this.houseMaterials[matIndex];
        
        this.pickupHouse = BABYLON.MeshBuilder.CreateBox('pickupHouse', {
            width: houseWidth,
            height: houseHeight,
            depth: houseDepth
        }, this.scene);
        this.pickupHouse.position = new BABYLON.Vector3(houseX, houseHeight / 2, houseZ);
        this.pickupHouse.material = mats.wall;
        this.pickupHouse.isPickable = false;
        
        // Store dimensions for collision
        this.pickupHouse.houseWidth = houseWidth;
        this.pickupHouse.houseDepth = houseDepth;
        this.pickupHouse.houseRotation = 0;
        this.pickupHouse.collisionRadiusXZ = Math.hypot(houseWidth * 0.5, houseDepth * 0.5);
        
        // Add windows to pickup house
        const windowHeight = 1.0;
        const windowWidth = 0.8;
        const windowY = houseHeight * 0.55;
        
        this.pickupHouseWindows = [];
        for (let wi = 0; wi < 3; wi++) {
            const wx = -houseWidth * 0.3 + wi * houseWidth * 0.3;
            const win = BABYLON.MeshBuilder.CreatePlane(`pickupWin_f${wi}`, {
                width: windowWidth, height: windowHeight
            }, this.scene);
            win.position = new BABYLON.Vector3(wx, windowY - houseHeight / 2, houseDepth / 2 + 0.01);
            win.material = this.windowMaterial;
            win.parent = this.pickupHouse;
            this.pickupHouseWindows.push(win);
        }
        
        // Create driveway
        const isXDir = drivewayDir.includes('Vertical');
        const dwLength = isXDir ? Math.abs(drivewayX - (tileX + (localX > 0 ? roadHalf : -roadHalf))) : Math.abs(drivewayZ - (tileZ + (localZ > 0 ? roadHalf : -roadHalf)));
        
        this.pickupDriveway = BABYLON.MeshBuilder.CreateGround('pickupDriveway', {
            width: isXDir ? dwLength : 5,
            height: isXDir ? 5 : dwLength
        }, this.scene);
        
        const dwCenterX = isXDir ? (drivewayX + (tileX + (localX > 0 ? roadHalf : -roadHalf))) / 2 : drivewayX;
        const dwCenterZ = isXDir ? drivewayZ : (drivewayZ + (tileZ + (localZ > 0 ? roadHalf : -roadHalf))) / 2;
        this.pickupDriveway.position = new BABYLON.Vector3(dwCenterX, 0.03, dwCenterZ);
        this.pickupDriveway.material = this.drivewayMaterial;
        this.pickupDriveway.isPickable = false;
        
        // Add door on driveway side
        const doorWidth = 1.2;
        const doorHeight = 2.2;
        const doorDepth = 0.1;
        const doorY = -houseHeight / 2 + doorHeight / 2 + 0.02;
        
        this.pickupDoor = BABYLON.MeshBuilder.CreateBox('pickupDoor', {
            width: isXDir ? doorDepth : doorWidth,
            height: doorHeight,
            depth: isXDir ? doorWidth : doorDepth
        }, this.scene);
        this.pickupDoor.material = this.doorMaterial;
        this.pickupDoor.parent = this.pickupHouse;
        
        // Position door on the driveway side
        if (drivewayDir === 'toVerticalFromRight') {
            this.pickupDoor.position = new BABYLON.Vector3(-houseWidth / 2 - 0.02, doorY, 0);
        } else if (drivewayDir === 'toVerticalFromLeft') {
            this.pickupDoor.position = new BABYLON.Vector3(houseWidth / 2 + 0.02, doorY, 0);
        } else if (drivewayDir === 'toHorizontalFromTop') {
            this.pickupDoor.position = new BABYLON.Vector3(0, doorY, -houseDepth / 2 - 0.02);
        } else {
            this.pickupDoor.position = new BABYLON.Vector3(0, doorY, houseDepth / 2 + 0.02);
        }
        
        // Create glowing beacon at the driveway/item spawn area - ORANGE color
        const beamHeight = 50;
        this.pickupBeam = BABYLON.MeshBuilder.CreateCylinder('pickupBeam', {
            height: beamHeight,
            diameterTop: 0.5,
            diameterBottom: 3,
            tessellation: 16
        }, this.scene);
        this.pickupBeam.position = new BABYLON.Vector3(itemSpawnX, beamHeight / 2, itemSpawnZ);
        this.pickupBeam.isPickable = false;
        
        const beamMat = new BABYLON.StandardMaterial('pickupBeamMat', this.scene);
        beamMat.emissiveColor = new BABYLON.Color3(1.0, 0.6, 0.1);
        beamMat.alpha = 0.4;
        beamMat.disableLighting = true;
        this.pickupBeam.material = beamMat;
        
        // Create floating marker - ORANGE
        this.pickupMarker = BABYLON.MeshBuilder.CreateTorus('pickupMarker', {
            diameter: 6,
            thickness: 0.8,
            tessellation: 24
        }, this.scene);
        this.pickupMarker.position = new BABYLON.Vector3(itemSpawnX, 6, itemSpawnZ);
        this.pickupMarker.isPickable = false;
        
        const markerMat = new BABYLON.StandardMaterial('pickupMarkerMat', this.scene);
        markerMat.emissiveColor = new BABYLON.Color3(1.0, 0.6, 0.1);
        markerMat.disableLighting = true;
        this.pickupMarker.material = markerMat;
        
        // Animate the pickup marker
        this.scene.registerBeforeRender(() => {
            if (this.pickupMarker && !this.pickupMarker.isDisposed()) {
                this.pickupMarker.rotation.y += 0.02;
                this.pickupMarker.position.y = 6 + Math.sin(Date.now() / 500) * 1.5;
            }
            if (this.pickupBeam && !this.pickupBeam.isDisposed()) {
                this.pickupBeam.material.alpha = 0.3 + Math.sin(Date.now() / 300) * 0.15;
            }
        });
    }
    
    removePickup() {
        const prevPickupTileKey = this.pickupTileKey;
        if (this.pickupMarker) {
            this.pickupMarker.dispose();
            this.pickupMarker = null;
        }
        if (this.pickupBeam) {
            this.pickupBeam.dispose();
            this.pickupBeam = null;
        }
        if (this.pickupHouse) {
            this.pickupHouse.dispose();
            this.pickupHouse = null;
        }
        if (this.pickupHouseWindows) {
            this.pickupHouseWindows.forEach(w => w.dispose());
            this.pickupHouseWindows = null;
        }
        if (this.pickupDriveway) {
            this.pickupDriveway.dispose();
            this.pickupDriveway = null;
        }
        if (this.pickupDoor) {
            this.pickupDoor.dispose();
            this.pickupDoor = null;
        }
        this.pickupPos = null;
        this.pickupItemSpawn = null;
        this.pickupTileKey = null;
        this.pickupExcludedTiles = null;

        // Regenerate houses on the old pickup tile now that it's no longer excluded
        if (prevPickupTileKey) {
            const [gridX, gridZ] = prevPickupTileKey.split('_').map(Number);
            this.createHousesForTile(gridX, gridZ);
        }
    }
    
    removeHousesInTileKey(tileKey) {
        if (!tileKey) return;
        if (this.pendingHouseTiles) {
            this.pendingHouseTiles = this.pendingHouseTiles.filter(key => key !== tileKey);
        }
        if (this.pendingHouseTileSet) {
            this.pendingHouseTileSet.delete(tileKey);
        }
        if (this.housesByTile && this.housesByTile[tileKey]) {
            this.housesByTile[tileKey].forEach(h => {
                if (h && !h.isDisposed()) h.dispose();
            });
            delete this.housesByTile[tileKey];
        }
        if (this.visualsByTile && this.visualsByTile[tileKey]) {
            this.visualsByTile[tileKey].forEach(m => {
                if (m && !m.isDisposed()) m.dispose();
            });
            delete this.visualsByTile[tileKey];
        }
        if (this.drivewaysByTile && this.drivewaysByTile[tileKey]) {
            this.drivewaysByTile[tileKey].forEach(d => {
                if (d && !d.isDisposed()) d.dispose();
            });
            delete this.drivewaysByTile[tileKey];
        }
    }

    hasLiveHouses(tileKey) {
        if (!this.housesByTile) return false;
        const houses = this.housesByTile[tileKey];
        if (!houses || houses.length === 0) return false;
        for (let i = 0; i < houses.length; i++) {
            const house = houses[i];
            if (house && !house.isDisposed()) return true;
        }
        return false;
    }

    // Remove any houses that are too close to the destination
    // Only removes individual collision boxes that are within radius - doesn't clear entire tiles
    removeHousesNearDestination(destX, destZ, radius) {
        if (!this.housesByTile) return;
        
        // Check all house collision boxes and remove those within radius
        for (const tileKey in this.housesByTile) {
            const houses = this.housesByTile[tileKey];
            if (!houses) continue;
            
            // Filter out houses that are too close
            this.housesByTile[tileKey] = houses.filter(house => {
                if (!house || house.isDisposed()) return false;
                
                const dist = Math.sqrt(
                    Math.pow(house.position.x - destX, 2) +
                    Math.pow(house.position.z - destZ, 2)
                );
                
                if (dist < radius) {
                    house.dispose();
                    return false;
                }
                return true;
            });
        }
    }
    
    createLighting() {
        // Ambient - brighter for better visibility on all sides
        const ambient = new BABYLON.HemisphericLight('ambient', new BABYLON.Vector3(0, 1, 0), this.scene);
        ambient.intensity = 0.9;
        ambient.groundColor = new BABYLON.Color3(0.45, 0.45, 0.5);
        
        // Sun
        const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.5, -1, 0.5), this.scene);
        sun.intensity = 1.15;
        sun.diffuse = new BABYLON.Color3(1.0, 0.98, 0.95);
        
        // Shadows disabled - was causing black artifact in sky
        // TODO: Re-enable with proper frustum settings if needed
        this.shadowGenerator = null;
        
        // Fill light from opposite side to brighten shadows
        const fill = new BABYLON.PointLight('fill', new BABYLON.Vector3(5, 4, -5), this.scene);
        fill.intensity = 0.5;
        
        // Additional fill from the shadow side
        const fill2 = new BABYLON.PointLight('fill2', new BABYLON.Vector3(-5, 3, 3), this.scene);
        fill2.intensity = 0.4;
    }
    
    createEnvironment() {
        this.scene.environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(
            'https://playground.babylonjs.com/textures/environment.dds',
            this.scene
        );
        this.scene.environmentIntensity = 1.0;
        // Ensure skybox renders behind everything
        this.scene.clearColor = new BABYLON.Color4(0.6, 0.78, 0.95, 1);
        
        // Skybox (match Babylon.js BackgroundMaterial example)
        const skybox = BABYLON.MeshBuilder.CreateBox(
            'skyBox',
            { size: 5000, sideOrientation: BABYLON.Mesh.BACKSIDE },
            this.scene
        );
        const skyTexture = new BABYLON.CubeTexture(
            'https://playground.babylonjs.com/textures/TropicalSunnyDay',
            this.scene
        );
        let skyMat;
        if (BABYLON.BackgroundMaterial) {
            skyMat = new BABYLON.BackgroundMaterial('skyMat', this.scene);
            skyMat.reflectionTexture = skyTexture;
            skyMat.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
        } else {
            // Fallback if materials library failed to load
            skyMat = new BABYLON.StandardMaterial('skyMat', this.scene);
            skyMat.reflectionTexture = skyTexture;
            skyMat.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
            skyMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
            skyMat.specularColor = new BABYLON.Color3(0, 0, 0);
            skyMat.disableLighting = true;
        }
        skyMat.backFaceCulling = false;
        skyMat.disableDepthWrite = true;
        skyMat.disableDepthTest = true;
        skybox.renderingGroupId = 0;
        skybox.material = skyMat;
        skybox.infiniteDistance = true;
        skybox.isPickable = false;
        skybox.applyFog = false;
        skyMat.freeze();
        skybox.freezeWorldMatrix();
        skybox.infiniteDistance = true;
        // Lower the skybox slightly so the horizon sits lower
        skybox.position.y = -8;
        skybox.isPickable = false;
    }
    
    createGround() {
        // Infinite ground system with road and grass
        this.groundTileSize = 50; // Larger tiles
        this.groundTilesPerSide = 30; // 23x23 grid for farther road visibility (~1150m)
        this.groundTiles = [];
        this.lastTileUpdatePos = { x: 0, z: 0 };
        this.housesByTile = {}; // Track houses by tile key for cleanup
        this.drivewaysByTile = {}; // Track driveways by tile key for cleanup
        
        // Create shared ground material with road and grass texture
        this.groundMaterial = new BABYLON.PBRMaterial('groundMat', this.scene);
        this.groundMaterial.albedoTexture = this.createGroundTexture();
        this.groundMaterial.metallic = 0.0;
        this.groundMaterial.roughness = 0.95;
        this.groundMaterial.backFaceCulling = true;
        this.groundMaterial.freeze();

        // Far ground to remove visible edge (reuse the same ground texture pattern)
        const farGround = BABYLON.MeshBuilder.CreateGround('farGround', { width: 50000, height: 50000 }, this.scene);
        farGround.position.y = -0.2;
        farGround.isPickable = false;
        farGround.receiveShadows = false;
        const farMat = new BABYLON.PBRMaterial('farGroundMat', this.scene);
        const baseTex = this.groundMaterial.albedoTexture;
        const farTex = baseTex && baseTex.clone ? baseTex.clone() : baseTex;
        farMat.albedoTexture = farTex;
        farMat.metallic = 0.0;
        farMat.roughness = 0.95;
        if (farTex) {
            farTex.uScale = 800;
            farTex.vScale = 800;
        }
        farMat.freeze();
        farGround.material = farMat;
        this.farGround = farGround;
        this.farGroundTexture = farTex;
        farGround.setEnabled(this.farGroundEnabled);
        
        // Create house materials (various colors)
        this.houseMaterials = this.createHouseMaterials();
        
        // Create grid of ground tiles
        const halfGrid = Math.floor(this.groundTilesPerSide / 2);
        for (let x = -halfGrid; x <= halfGrid; x++) {
            for (let z = -halfGrid; z <= halfGrid; z++) {
                const tile = this.createGroundTile(x, z);
                this.groundTiles.push(tile);
                // Add houses to this tile's grass areas
                this.createHousesForTile(x, z);
            }
        }

        // Prewarm distant houses on load so they render ahead immediately
        const prewarmCenterX = 0;
        const prewarmCenterZ = 0;
        const forwardTiles = Math.ceil(250 / this.groundTileSize);
        const houseHalfGrid = halfGrid + 3;
        const maxAhead = houseHalfGrid + forwardTiles;
        const forwardX = 0;
        const forwardZ = -1;
        const forwardThreshold = 0.2;
        const prewarmTiles = [];
        for (let x = -houseHalfGrid; x <= houseHalfGrid; x++) {
            for (let z = -houseHalfGrid; z <= maxAhead; z++) {
                const dx = x;
                const dz = z;
                const dist = Math.sqrt(dx * dx + dz * dz) || 1;
                const dirX = dx / dist;
                const dirZ = dz / dist;
                const forwardDot = dirX * forwardX + dirZ * forwardZ;
                const inNearRing = dist <= halfGrid + 1;
                const inFront = forwardDot > forwardThreshold;
                const inForwardRange = forwardDot > 0 && dist <= maxAhead;
                if (inNearRing || (inFront && inForwardRange)) {
                    prewarmTiles.push(`${prewarmCenterX + x}_${prewarmCenterZ + z}`);
                }
            }
        }
        const prewarmStart = performance.now();
        const prewarmBudgetMs = 200;
        while (prewarmTiles.length > 0 && performance.now() - prewarmStart < prewarmBudgetMs) {
            const tileKey = prewarmTiles.shift();
            if (this.hasLiveHouses(tileKey)) continue;
            const [gridX, gridZ] = tileKey.split('_').map(Number);
            this.createHousesForTile(gridX, gridZ);
        }
        
        // Main physics ground - completely hidden from rendering
        // Make it very large so it doesn't need to move
        const physicsGround = BABYLON.MeshBuilder.CreateBox('physicsGround', { width: 5000, height: 0.2, depth: 5000 }, this.scene);
        physicsGround.position.y = -0.1;
        physicsGround.isVisible = false; // Hide from rendering completely
        physicsGround.isPickable = false;
        // Use PhysicsAggregate for Havok
        const groundAggregate = new BABYLON.PhysicsAggregate(physicsGround, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, this.scene);
        this.physicsGround = physicsGround;
        this.physicsGroundAggregate = groundAggregate;
    }
    
    createGroundTexture() {
        const texSize = 2048; // Higher resolution for sharper ground
        const tex = new BABYLON.DynamicTexture('groundTex', texSize, this.scene);
        const ctx = tex.getContext();
        
        // Road dimensions
        const roadWidth = texSize * 0.25;  // Smaller roads
        const roadColor = '#2a2a2c';
        const grassColor = '#1a2e1a';
        
        // Fill with road color first
        ctx.fillStyle = roadColor;
        ctx.fillRect(0, 0, texSize, texSize);
        
        // Draw grass rectangles in each corner quadrant - only outer corner is rounded
        const grassSize = (texSize - roadWidth) / 2;
        
        // Helper to draw rectangle with only ONE corner rounded (the outer corner)
        // cornerPos: 'tl' = top-left, 'tr' = top-right, 'bl' = bottom-left, 'br' = bottom-right
        const drawGrassQuadrant = (x, y, w, h, r, cornerPos) => {
            ctx.beginPath();
            if (cornerPos === 'tl') {
                // Round only top-left corner (at x, y)
                ctx.moveTo(x, y + r);
                ctx.arcTo(x, y, x + r, y, r);
                ctx.lineTo(x + w, y);
                ctx.lineTo(x + w, y + h);
                ctx.lineTo(x, y + h);
                ctx.closePath();
            } else if (cornerPos === 'tr') {
                // Round only top-right corner (at x+w, y)
                ctx.moveTo(x, y);
                ctx.lineTo(x + w - r, y);
                ctx.arcTo(x + w, y, x + w, y + r, r);
                ctx.lineTo(x + w, y + h);
                ctx.lineTo(x, y + h);
                ctx.closePath();
            } else if (cornerPos === 'bl') {
                // Round only bottom-left corner (at x, y+h)
                ctx.moveTo(x, y);
                ctx.lineTo(x + w, y);
                ctx.lineTo(x + w, y + h);
                ctx.lineTo(x + r, y + h);
                ctx.arcTo(x, y + h, x, y + h - r, r);
                ctx.closePath();
            } else if (cornerPos === 'br') {
                // Round only bottom-right corner (at x+w, y+h)
                ctx.moveTo(x, y);
                ctx.lineTo(x + w, y);
                ctx.lineTo(x + w, y + h - r);
                ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
                ctx.lineTo(x, y + h);
                ctx.closePath();
            }
        };
        
        // Each quadrant with its outer corner position (at tile edges, away from intersection)
        const quadrants = [
            { x: 0, y: 0, corner: 'br' },                              // Top-left quadrant, round BR corner (outer after UV flip)
            { x: texSize - grassSize, y: 0, corner: 'bl' },            // Top-right quadrant, round BL corner (outer after UV flip)
            { x: 0, y: texSize - grassSize, corner: 'tr' },            // Bottom-left quadrant, round TR corner (outer after UV flip)
            { x: texSize - grassSize, y: texSize - grassSize, corner: 'tl' } // Bottom-right quadrant, round TL corner (outer after UV flip)
        ];


        
        // Calculate intersection bounds (where roads cross - no lines here)
        const intersectMin = (texSize - roadWidth) / 2;
        const intersectMax = (texSize + roadWidth) / 2;
        const cornerRadius = texSize * 0.05;
        const r = cornerRadius; // Use same radius as grass corners


        
        // Draw each grass quadrant with only outer corner rounded
        quadrants.forEach(q => {
            ctx.fillStyle = grassColor;
            drawGrassQuadrant(q.x, q.y, grassSize, grassSize, cornerRadius, q.corner);
            ctx.fill();
            
            // Add grass variation patches within this quadrant
            for (let i = 0; i < 12; i++) {
                const px = q.x + Math.random() * grassSize;
                const py = q.y + Math.random() * grassSize;
                const size = 20 + Math.random() * 60;
                const green = Math.floor(35 + Math.random() * 25);
                ctx.fillStyle = `rgb(${Math.floor(green * 0.6)}, ${green}, ${Math.floor(green * 0.5)})`;
                ctx.beginPath();
                ctx.ellipse(px, py, size, size * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
                ctx.fill();
            }
        });
        
        // Road edge lines - subtle muted color to avoid flickering (accessibility)
        const lineWidth = 8; // Slightly thinner
        ctx.strokeStyle = '#505055'; // Subtle gray, low contrast with road
        ctx.lineWidth = lineWidth;
        ctx.setLineDash([]); // Solid lines
        
        // Draw road edges with rounded corners matching grass blocks (after UV flip)
        // Top-left grass block - curved corner at intersection
        ctx.beginPath();
        ctx.moveTo(0, intersectMin);
        ctx.lineTo(intersectMin - r, intersectMin);
        ctx.arcTo(intersectMin, intersectMin, intersectMin, intersectMin - r, r);
        ctx.lineTo(intersectMin, 0);
        ctx.stroke();
        
        // Top-right grass block - curved corner at intersection
        ctx.beginPath();
        ctx.moveTo(texSize, intersectMin);
        ctx.lineTo(intersectMax + r, intersectMin);
        ctx.arcTo(intersectMax, intersectMin, intersectMax, intersectMin - r, r);
        ctx.lineTo(intersectMax, 0);
        ctx.stroke();
        
        // Bottom-left grass block - curved corner at intersection
        ctx.beginPath();
        ctx.moveTo(0, intersectMax);
        ctx.lineTo(intersectMin - r, intersectMax);
        ctx.arcTo(intersectMin, intersectMax, intersectMin, intersectMax + r, r);
        ctx.lineTo(intersectMin, texSize);
        ctx.stroke();
        
        // Bottom-right grass block - curved corner at intersection
        ctx.beginPath();
        ctx.moveTo(texSize, intersectMax);
        ctx.lineTo(intersectMax + r, intersectMax);
        ctx.arcTo(intersectMax, intersectMax, intersectMax, intersectMax + r, r);
        ctx.lineTo(intersectMax, texSize);
        ctx.stroke();
        
        // Center dashed lines - subtle color to avoid flickering (accessibility)
        // 4 stripes per road segment with equal gaps, starting and ending with half-gaps
        const numStripesPerSegment = 4;
        const stripeWidth = lineWidth;
        ctx.fillStyle = '#606065'; // Subtle gray, very low contrast
        
        // Helper to draw 4 stripes with gaps at edges (so tiles don't have touching stripes)
        // Pattern: half-gap, S, gap, S, gap, S, gap, S, half-gap
        // Total = 4*stripe + 4*gap = 8 equal segments
        const drawStripes = (startX, startY, endX, endY, isHorizontal) => {
            const totalLen = isHorizontal ? (endX - startX) : (endY - startY);
            const segmentLen = totalLen / 8; // 8 equal parts
            
            for (let i = 0; i < numStripesPerSegment; i++) {
                // Start at 0.5 (half-gap offset), then every 2 segments
                const pos = (0.5 + i * 2) * segmentLen;
                if (isHorizontal) {
                    ctx.fillRect(startX + pos, startY - stripeWidth/2, segmentLen, stripeWidth);
                } else {
                    ctx.fillRect(startX - stripeWidth/2, startY + pos, stripeWidth, segmentLen);
                }
            }
        };
        
        // Horizontal center stripes (skip intersection)
        drawStripes(0, texSize/2, intersectMin, texSize/2, true);
        drawStripes(intersectMax, texSize/2, texSize, texSize/2, true);
        
        // Vertical center stripes (skip intersection)
        drawStripes(texSize/2, 0, texSize/2, intersectMin, false);
        drawStripes(texSize/2, intersectMax, texSize/2, texSize, false);
        
        tex.update();
        return tex;
    }

    getDestinationCornerKey(signX, signZ) {
        // Use centralized Coords utility for consistent corner mapping
        // signX: +1 = beacon is EAST of tile center, -1 = beacon is WEST
        // signZ: +1 = beacon is NORTH of tile center, -1 = beacon is SOUTH
        return Coords.cornerFromSigns(signX, signZ, true); // true = use legacy names
    }

    getTextureCornerKey(cornerKey) {
        // Canvas corners map directly to world corners - no transformation needed.
        // This is because:
        //   - Canvas (0,0) = top-left = World NW = 'tl'
        //   - Canvas (max,max) = bottom-right = World SE = 'br'
        // See Coords.php for the full coordinate system documentation.
        return cornerKey;
    }

    buildDestinationTileOverrides(tileX, tileZ, signX, signZ, exactBeaconX, exactBeaconZ) {
        // The beacon is at the corner where 4 tiles meet.
        // For each tile, determine which corner faces the beacon using Coords utility.
        // See Coords.php for coordinate system documentation.
        
        const size = this.groundTileSize;
        const adjX = tileX + signX * size;
        const adjZ = tileZ + signZ * size;

        const tileCenters = [
            { x: tileX, z: tileZ },
            { x: adjX, z: tileZ },
            { x: tileX, z: adjZ },
            { x: adjX, z: adjZ }
        ];

        const overrides = {};
        for (let i = 0; i < tileCenters.length; i++) {
            const center = tileCenters[i];
            // Use Math.floor to match house generation tile key format
            const gridX = Math.floor(center.x / size);
            const gridZ = Math.floor(center.z / size);
            const key = `${gridX}_${gridZ}`;
            // Use Coords utility to determine which corner faces the beacon
            const cornerKey = Coords.cornerFromSigns(
                exactBeaconX >= center.x ? 1 : -1,
                exactBeaconZ >= center.z ? 1 : -1,
                true  // Use legacy corner names ('tl', 'tr', 'bl', 'br')
            );
            overrides[key] = cornerKey;
        }
        return overrides;
    }

    createDestinationGroundTexture(cornerKey) {
        const baseTex = this.groundMaterial?.albedoTexture;
        if (!baseTex || !baseTex.getContext) return this.createGroundTexture();

        const texSize = baseTex.getSize().width;
        const tex = new BABYLON.DynamicTexture('destGroundTex', texSize, this.scene);
        const ctx = tex.getContext();

        // Clone base texture
        const baseCanvas = baseTex.getContext().canvas;
        ctx.drawImage(baseCanvas, 0, 0);

        // Texture layout values (must match createGroundTexture)
        const roadWidth = texSize * 0.25;
        const grassSize = (texSize - roadWidth) / 2;
        const intersectMin = (texSize - roadWidth) / 2;
        const intersectMax = (texSize + roadWidth) / 2;
        const cornerRadius = texSize * 0.05;
        const lineWidth = 8;

        const textureCornerKey = this.getTextureCornerKey(cornerKey);

        // Square grass corner (remove rounded corner)
        let grassX = 0;
        let grassY = 0;
        if (textureCornerKey === 'tr') grassX = texSize - grassSize;
        if (textureCornerKey === 'bl') grassY = texSize - grassSize;
        if (textureCornerKey === 'br') {
            grassX = texSize - grassSize;
            grassY = texSize - grassSize;
        }
        ctx.fillStyle = '#1a2e1a';
        ctx.fillRect(grassX, grassY, grassSize, grassSize);

        // Clear curved road line area at the external corner (road side only)
        const roadColor = '#2a2a2c';
        const clearPad = lineWidth * 2; // extra padding to ensure full coverage
        const clearSize = cornerRadius + (clearPad * 3); // much larger clear area
        ctx.fillStyle = roadColor;
        let clearRect = { x: 0, y: 0, w: clearSize, h: clearSize };
        if (textureCornerKey === 'tl') {
            clearRect.x = intersectMin - cornerRadius - clearPad;
            clearRect.y = intersectMin - cornerRadius - clearPad;
        } else if (textureCornerKey === 'tr') {
            clearRect.x = intersectMax - clearPad;
            clearRect.y = intersectMin - cornerRadius - clearPad;
        } else if (textureCornerKey === 'bl') {
            clearRect.x = intersectMin - cornerRadius - clearPad;
            clearRect.y = intersectMax - clearPad;
        } else {
            clearRect.x = intersectMax - clearPad;
            clearRect.y = intersectMax - clearPad;
        }
        ctx.fillRect(clearRect.x, clearRect.y, clearRect.w, clearRect.h);

        this.logDestinationDebug('createDestinationGroundTexture', {
            cornerKey,
            textureCornerKey,
            texSize,
            roadWidth,
            grassSize,
            intersectMin,
            intersectMax,
            cornerRadius,
            lineWidth,
            clearSize,
            clearRect
        });

        // Straight road edge lines for this corner
        ctx.strokeStyle = '#505055';
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.setLineDash([]);
        ctx.beginPath();
        if (textureCornerKey === 'tl') {
            ctx.moveTo(0, intersectMin);
            ctx.lineTo(intersectMin, intersectMin);
            ctx.lineTo(intersectMin, 0);
        } else if (textureCornerKey === 'tr') {
            ctx.moveTo(texSize, intersectMin);
            ctx.lineTo(intersectMax, intersectMin);
            ctx.lineTo(intersectMax, 0);
        } else if (textureCornerKey === 'bl') {
            ctx.moveTo(0, intersectMax);
            ctx.lineTo(intersectMin, intersectMax);
            ctx.lineTo(intersectMin, texSize);
        } else {
            ctx.moveTo(texSize, intersectMax);
            ctx.lineTo(intersectMax, intersectMax);
            ctx.lineTo(intersectMax, texSize);
        }
        ctx.stroke();

        tex.update();
        return tex;
    }

    ensureDestinationTileMaterials() {
        if (!this.destinationTileOverrides || !this.groundMaterial) return;
        if (!this.destinationTileMaterials) {
            this.destinationTileMaterials = {};
            this.destinationTileTextures = {};
        }

        const neededCorners = new Set(Object.values(this.destinationTileOverrides));
        neededCorners.forEach(cornerKey => {
            if (this.destinationTileMaterials[cornerKey]) return;
            const tex = this.createDestinationGroundTexture(cornerKey);
            const mat = new BABYLON.PBRMaterial(`destGroundTileMat_${cornerKey}`, this.scene);
            mat.albedoTexture = tex;
            mat.metallic = 0.0;
            mat.roughness = 0.95;
            mat.backFaceCulling = true;
            mat.freeze();
            this.destinationTileTextures[cornerKey] = tex;
            this.destinationTileMaterials[cornerKey] = mat;
        });

        this.logDestinationDebug('ensureDestinationTileMaterials', {
            neededCorners: Array.from(neededCorners)
        });
    }

    applyDestinationTileMaterials() {
        if (!this.destinationTileMaterials) return;
        const overrides = this.destinationTileOverrides || {};
        const applied = new Set();
        const missing = new Set(Object.keys(overrides));
        for (let i = 0; i < this.groundTiles.length; i++) {
            const tile = this.groundTiles[i];
            const tileKey = `${tile.gridX}_${tile.gridZ}`;
            const cornerKey = overrides[tileKey];
            if (cornerKey && this.destinationTileMaterials[cornerKey]) {
                tile.material = this.destinationTileMaterials[cornerKey];
                applied.add(tileKey);
                missing.delete(tileKey);
            } else if (this.destinationTileMaterials) {
                // Reset tiles that previously used destination materials
                for (const key in this.destinationTileMaterials) {
                    if (tile.material === this.destinationTileMaterials[key]) {
                        tile.material = this.groundMaterial;
                        break;
                    }
                }
            }
        }

        this.logDestinationDebug('applyDestinationTileMaterials', {
            overrides,
            applied: Array.from(applied),
            missing: Array.from(missing)
        });
    }
    
    createGravelTexture() {
        const texSize = 256;
        const tex = new BABYLON.DynamicTexture('gravelTex', texSize, this.scene);
        const ctx = tex.getContext();
        
        // Clean asphalt base - medium grey
        ctx.fillStyle = '#484848';
        ctx.fillRect(0, 0, texSize, texSize);
        
        // Subtle noise variation for asphalt texture (very low contrast)
        for (let i = 0; i < 200; i++) {
            const x = Math.random() * texSize;
            const y = Math.random() * texSize;
            const size = 10 + Math.random() * 25;
            
            // Very subtle variation
            const v = 68 + Math.floor(Math.random() * 10);
            ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
            ctx.globalAlpha = 0.12;
            ctx.beginPath();
            ctx.ellipse(x, y, size, size * 0.8, Math.random() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.globalAlpha = 1.0;
        
        // Very faint aggregate specs (barely visible)
        for (let i = 0; i < 80; i++) {
            const x = Math.random() * texSize;
            const y = Math.random() * texSize;
            const size = 0.5 + Math.random() * 1;
            const v = 75 + Math.floor(Math.random() * 12);
            ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
            ctx.globalAlpha = 0.25;
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.globalAlpha = 1.0;
        tex.update();
        return tex;
    }
    
    createGroundTile(gridX, gridZ) {
        const tile = BABYLON.MeshBuilder.CreateGround(`tile_${gridX}_${gridZ}`, {
            width: this.groundTileSize,
            height: this.groundTileSize
        }, this.scene);
        
        // Use shared material
        tile.material = this.groundMaterial;
        
        tile.position.x = gridX * this.groundTileSize;
        tile.position.z = gridZ * this.groundTileSize;
        tile.position.y = -0.01; // Slightly below to avoid z-fighting
        
        tile.receiveShadows = true;
        tile.isPickable = false;
        
        tile.gridX = gridX;
        tile.gridZ = gridZ;
        
        return tile;
    }
    
    createHouseMaterials() {
        // Realistic suburban house colors
        const colors = [
            // Light neutrals (no whites)
            { wall: '#e1d7c6', roof: '#3d3d3d' },  // Light beige/dark gray
            { wall: '#d9d0c2', roof: '#4a4a4a' },  // Warm stone/charcoal
            { wall: '#d4c7b5', roof: '#5c4033' },  // Sand/brown
            { wall: '#cfc5b6', roof: '#2f2f2f' },  // Oat/black
            
            // Beiges & Tans (very common)
            { wall: '#d4c4a8', roof: '#4a3728' },  // Classic beige/brown
            { wall: '#c9b896', roof: '#3d2b1f' },  // Warm tan/dark brown
            { wall: '#ddd5c7', roof: '#5a4a3a' },  // Light taupe/brown
            { wall: '#d8cec0', roof: '#6b5344' },  // Light taupe/mocha
            
            // Grays (popular modern choice)
            { wall: '#a8a8a8', roof: '#2c2c2c' },  // Medium gray/dark
            { wall: '#c4c4c4', roof: '#3a3a3a' },  // Light gray/charcoal
            { wall: '#8f8f8f', roof: '#1a1a1a' },  // Darker gray/black
            { wall: '#b8b8b8', roof: '#4f4f4f' },  // Warm gray/slate
            
            // Blues (classic choice)
            { wall: '#b4c7d9', roof: '#3d4f5f' },  // Colonial blue/slate
            { wall: '#8faabe', roof: '#2a3a4a' },  // Dusty blue/navy
            { wall: '#a5b9c9', roof: '#4a5a6a' },  // Slate blue/gray
            
            // Greens (sage & olive)
            { wall: '#9caa8c', roof: '#3a4a3a' },  // Sage green/forest
            { wall: '#8a9a7a', roof: '#2a3a2a' },  // Olive/dark green
            { wall: '#a8b8a0', roof: '#4a5a4a' },  // Light sage/green
            
            // Yellows (pale, muted)
            { wall: '#e8dbb4', roof: '#5c4a38' },  // Pale yellow/brown
            { wall: '#ddd4a8', roof: '#4a3a28' },  // Butter/dark brown
            { wall: '#f0e8c8', roof: '#6b5a48' },  // Cream yellow/taupe
            
            // Brick & Red tones
            { wall: '#a65d4c', roof: '#3d2d2d' },  // Brick red/brown
            { wall: '#8b5a4a', roof: '#2a1a1a' },  // Dark brick/black
            { wall: '#b87363', roof: '#4a3a3a' },  // Terracotta/brown
            
            // Earth tones
            { wall: '#a08060', roof: '#3a2a1a' },  // Brown siding/dark
            { wall: '#907050', roof: '#2a1a0a' },  // Dark tan/espresso
        ];
        
        // Create window material (dark blue-gray for glass look)
        this.windowMaterial = new BABYLON.StandardMaterial('windowMat', this.scene);
        this.windowMaterial.diffuseColor = new BABYLON.Color3(0.15, 0.2, 0.25);
        this.windowMaterial.specularColor = new BABYLON.Color3(0.08, 0.08, 0.1);
        this.windowMaterial.specularPower = 16;
        this.windowMaterial.emissiveColor = new BABYLON.Color3(0.02, 0.03, 0.04);
        
        // Window frame material (white trim)
        this.windowFrameMaterial = new BABYLON.StandardMaterial('windowFrameMat', this.scene);
        this.windowFrameMaterial.diffuseColor = new BABYLON.Color3(0.92, 0.92, 0.92);
        this.windowFrameMaterial.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);

        // Door material (wood)
        this.doorMaterial = new BABYLON.StandardMaterial('doorMat', this.scene);
        this.doorMaterial.diffuseColor = new BABYLON.Color3(0.36, 0.24, 0.14);
        this.doorMaterial.specularColor = new BABYLON.Color3(0.03, 0.02, 0.01);
        this.doorMaterial.specularPower = 6;
        
        // Driveway material - dark grey concrete (cool-toned to avoid tan look)
        this.drivewayMaterial = new BABYLON.StandardMaterial('drivewayMat', this.scene);
        this.drivewayMaterial.diffuseColor = new BABYLON.Color3(0.18, 0.19, 0.21);
        this.drivewayMaterial.specularColor = new BABYLON.Color3(0.01, 0.01, 0.01);
        this.drivewayMaterial.specularPower = 2;
        this.drivewayMaterial.emissiveColor = new BABYLON.Color3(0.02, 0.02, 0.03);

        // Freeze static materials for performance
        this.windowMaterial.freeze();
        this.windowFrameMaterial.freeze();
        this.doorMaterial.freeze();
        this.drivewayMaterial.freeze();

        const materials = colors.map((c, i) => {
            const wallMat = new BABYLON.StandardMaterial(`houseMat${i}`, this.scene);
            wallMat.diffuseColor = BABYLON.Color3.FromHexString(c.wall);
            wallMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
            wallMat.specularPower = 8;
            
            const roofMat = new BABYLON.StandardMaterial(`roofMat${i}`, this.scene);
            roofMat.diffuseColor = BABYLON.Color3.FromHexString(c.roof);
            roofMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
            roofMat.specularPower = 8;
            
            return { wall: wallMat, roof: roofMat };
        });

        materials.forEach(mats => {
            mats.wall.freeze();
            mats.roof.freeze();
        });

        return materials;
    }
    
    createHousesForTile(gridX, gridZ) {
        const tileKey = `${gridX}_${gridZ}`;

        // No auto-generated houses on pickup area tiles
        if (this.pickupExcludedTiles && this.pickupExcludedTiles.has(tileKey)) return;
        if (this.pickupTileKey && tileKey === this.pickupTileKey) return;
        
        // For destination tiles, skip only the quadrant that faces the drop-off corner
        const destinationCornerKey = this.destinationTileOverrides
            ? this.destinationTileOverrides[tileKey]
            : null;
        
        // Clean up existing houses for this tile if any
        if (this.housesByTile[tileKey]) {
            this.housesByTile[tileKey].forEach(h => {
                if (h && !h.isDisposed()) h.dispose();
            });
        }
        this.housesByTile[tileKey] = [];
        
        if (this.visualsByTile[tileKey]) {
            this.visualsByTile[tileKey].forEach(m => {
                if (m && !m.isDisposed()) m.dispose();
            });
            delete this.visualsByTile[tileKey];
        }
        
        // Clean up existing driveways for this tile if any
        if (this.drivewaysByTile[tileKey]) {
            this.drivewaysByTile[tileKey].forEach(d => {
                if (d && !d.isDisposed()) d.dispose();
            });
        }
        this.drivewaysByTile[tileKey] = [];
        
        // Seeded random based on grid position for consistent placement
        const seed = (gridX * 73856093) ^ (gridZ * 19349663);
        let randomCounter = 0;
        const seededRandom = () => {
            randomCounter++;
            const x = Math.sin(seed + randomCounter * 123.456) * 43758.5453;
            return x - Math.floor(x);
        };
        
        const tileX = gridX * this.groundTileSize;
        const tileZ = gridZ * this.groundTileSize;
        const halfTile = this.groundTileSize / 2;
        
        // Four grass quadrants per tile (corners, avoiding the cross-shaped road)
        const quadrants = [
            { x: -halfTile * 0.6, z: -halfTile * 0.6, cornerKey: 'bl' }, // SouthWest
            { x: halfTile * 0.6, z: -halfTile * 0.6, cornerKey: 'br' },  // SouthEast
            { x: -halfTile * 0.6, z: halfTile * 0.6, cornerKey: 'tl' },  // NorthWest
            { x: halfTile * 0.6, z: halfTile * 0.6, cornerKey: 'tr' },   // NorthEast
        ];
        
        // Road dimensions (25% of tile = 12.5m wide road through center)
        const roadHalfWidth = this.groundTileSize * 0.125 + 4; // 10.25m from center (larger buffer)
        
        // Track placed house bounds for overlap checking
        const placedHouses = [];
        
        // Visual merge groups (reduce draw calls)
        const wallMeshesByMat = new Map();
        const windowMeshes = [];
        const doorMeshes = [];
        const drivewayMeshes = [];
        
        // Helper to check if two houses overlap
        const housesOverlap = (x1, z1, w1, d1, x2, z2, w2, d2) => {
            const buffer = 2; // 2m gap between houses
            const halfW1 = w1 / 2 + buffer;
            const halfD1 = d1 / 2 + buffer;
            const halfW2 = w2 / 2;
            const halfD2 = d2 / 2;
            return Math.abs(x1 - x2) < (halfW1 + halfW2) && Math.abs(z1 - z2) < (halfD1 + halfD2);
        };
        
        quadrants.forEach((quad, qi) => {
            // Skip the destination quadrant on destination tiles
            if (destinationCornerKey && quad.cornerKey === destinationCornerKey) return;
            // 70% chance of a house in each quadrant
            if (seededRandom() > 0.7) return;
            
            // Random house dimensions (larger, more realistic)
            const width = 8 + seededRandom() * 6;   // 8-14m wide
            const depth = 10 + seededRandom() * 8;  // 10-18m deep
            const height = 4 + seededRandom() * 3;  // 4-7m tall (1-2 stories)
            
            // Position with some random offset within quadrant
            const offsetX = (seededRandom() - 0.5) * 6;
            const offsetZ = (seededRandom() - 0.5) * 6;
            let localX = quad.x + offsetX;
            let localZ = quad.z + offsetZ;
            
            // Ensure house doesn't overlap with road (cross pattern through center)
            // Road runs along x=0 and z=0 with half-width of roadHalfWidth
            // Use max dimension to account for any rotation
            const maxDim = Math.max(width, depth) / 2 + 3;  // Add 3m buffer
            const houseHalfW = maxDim;
            const houseHalfD = maxDim;
            
            // Check if house overlaps vertical road (x near 0)
            if (Math.abs(localX) - houseHalfW < roadHalfWidth) {
                // Push house away from vertical road
                if (localX > 0) {
                    localX = roadHalfWidth + houseHalfW;
                } else {
                    localX = -roadHalfWidth - houseHalfW;
                }
            }
            
            // Check if house overlaps horizontal road (z near 0)
            if (Math.abs(localZ) - houseHalfD < roadHalfWidth) {
                // Push house away from horizontal road
                if (localZ > 0) {
                    localZ = roadHalfWidth + houseHalfD;
                } else {
                    localZ = -roadHalfWidth - houseHalfD;
                }
            }
            
            const posX = tileX + localX;
            const posZ = tileZ + localZ;
            
            // Note: Pickup and destination tiles are excluded entirely at the start of this function
            // No need for distance checks here - that was causing empty surrounding blocks
            
            // Check if this house would overlap with any already placed house
            let overlaps = false;
            for (const placed of placedHouses) {
                if (housesOverlap(posX, posZ, width, depth, placed.x, placed.z, placed.w, placed.d)) {
                    overlaps = true;
                    break;
                }
            }
            
            // Also check houses in adjacent tiles
            const adjacentTiles = [
                `${gridX-1}_${gridZ}`, `${gridX+1}_${gridZ}`,
                `${gridX}_${gridZ-1}`, `${gridX}_${gridZ+1}`,
                `${gridX-1}_${gridZ-1}`, `${gridX+1}_${gridZ-1}`,
                `${gridX-1}_${gridZ+1}`, `${gridX+1}_${gridZ+1}`
            ];
            
            if (!overlaps) {
                for (const adjKey of adjacentTiles) {
                    const adjHouses = this.housesByTile[adjKey];
                    if (!adjHouses) continue;
                    for (const adjHouse of adjHouses) {
                        if (!adjHouse || adjHouse.isDisposed()) continue;
                        if (housesOverlap(posX, posZ, width, depth, 
                            adjHouse.position.x, adjHouse.position.z, 
                            adjHouse.houseWidth, adjHouse.houseDepth)) {
                            overlaps = true;
                            break;
                        }
                    }
                    if (overlaps) break;
                }
            }
            
            // Skip this house if it would overlap
            if (overlaps) return;
            
            // Random rotation (0, 90, 180, or 270 degrees)
            const rotation = Math.floor(seededRandom() * 4) * Math.PI / 2;
            
            // Random material
            const matIndex = Math.floor(seededRandom() * this.houseMaterials.length);
            const mats = this.houseMaterials[matIndex];
            
            // Collision mesh (invisible)
            const houseCollision = BABYLON.MeshBuilder.CreateBox(`houseCol_${gridX}_${gridZ}_${qi}`, {
                width: width,
                height: height,
                depth: depth
            }, this.scene);
            houseCollision.position = new BABYLON.Vector3(posX, height / 2, posZ);
            houseCollision.rotation.y = rotation;
            houseCollision.isVisible = false;
            houseCollision.isPickable = false;
            
            // Visual house body (for rendering, merged later)
            const house = BABYLON.MeshBuilder.CreateBox(`house_${gridX}_${gridZ}_${qi}`, {
                width: width,
                height: height,
                depth: depth
            }, this.scene);
            house.position = new BABYLON.Vector3(posX, height / 2, posZ);
            house.rotation.y = rotation;
            house.material = mats.wall;
            house.isPickable = false;
            
            // Store actual dimensions for accurate collision detection
            houseCollision.houseWidth = width;
            houseCollision.houseDepth = depth;
            houseCollision.houseRotation = rotation;
            houseCollision.collisionRadiusXZ = Math.hypot(width * 0.5, depth * 0.5);
            
            // Add windows (optimized but still looks good)
            const windowHeight = 1.0;
            const windowWidth = 0.8;
            const windowY = height * 0.55;
            
            // Front windows (3 windows)
            for (let wi = 0; wi < 3; wi++) {
                const wx = -width * 0.3 + wi * width * 0.3;
                const win = BABYLON.MeshBuilder.CreatePlane(`win_${gridX}_${gridZ}_${qi}_f${wi}`, {
                    width: windowWidth, height: windowHeight
                }, this.scene);
                win.position = new BABYLON.Vector3(wx, windowY - height / 2, depth / 2 + 0.01);
                win.material = this.windowMaterial;
                win.parent = house;
                windowMeshes.push(win);
            }
            
            // Back windows (3 windows)
            for (let wi = 0; wi < 3; wi++) {
                const wx = -width * 0.3 + wi * width * 0.3;
                const win = BABYLON.MeshBuilder.CreatePlane(`win_${gridX}_${gridZ}_${qi}_b${wi}`, {
                    width: windowWidth, height: windowHeight
                }, this.scene);
                win.position = new BABYLON.Vector3(wx, windowY - height / 2, -depth / 2 - 0.01);
                win.rotation.y = Math.PI;
                win.material = this.windowMaterial;
                win.parent = house;
                windowMeshes.push(win);
            }
            
            // Left side windows (2 windows)
            for (let wi = 0; wi < 2; wi++) {
                const wz = -depth * 0.2 + wi * depth * 0.4;
                const win = BABYLON.MeshBuilder.CreatePlane(`win_${gridX}_${gridZ}_${qi}_l${wi}`, {
                    width: windowWidth, height: windowHeight
                }, this.scene);
                win.position = new BABYLON.Vector3(-width / 2 - 0.01, windowY - height / 2, wz);
                win.rotation.y = Math.PI / 2;
                win.material = this.windowMaterial;
                win.parent = house;
                windowMeshes.push(win);
            }
            
            // Right side windows (2 windows)
            for (let wi = 0; wi < 2; wi++) {
                const wz = -depth * 0.2 + wi * depth * 0.4;
                const win = BABYLON.MeshBuilder.CreatePlane(`win_${gridX}_${gridZ}_${qi}_r${wi}`, {
                    width: windowWidth, height: windowHeight
                }, this.scene);
                win.position = new BABYLON.Vector3(width / 2 + 0.01, windowY - height / 2, wz);
                win.rotation.y = -Math.PI / 2;
                win.material = this.windowMaterial;
                win.parent = house;
                windowMeshes.push(win);
            }
            
            // Add driveway from house to nearest road edge
            const tileWorldX = gridX * this.groundTileSize;
            const tileWorldZ = gridZ * this.groundTileSize;
            const localHouseX = posX - tileWorldX;
            const localHouseZ = posZ - tileWorldZ;
            // Actual road half-width used by the ground texture
            const roadHalf = this.groundTileSize * 0.125; // 6.25m from center
            const roadInset = -0.1; // Slightly shorten so driveway doesn't reach block edge
            
            const drivewayWidth = 5;
            const drivewayOffset = width * 0.15; // Slight off-center
            let drivewayLength, drivewayX, drivewayZ, drivewayRotation;
            
            // Valid directions depend on quadrant - driveway must go TOWARD the road, not away
            // Houses in +X quadrant can go -X (toward vertical road)
            // Houses in -X quadrant can go +X (toward vertical road)
            // Houses in +Z quadrant can go -Z (toward horizontal road)
            // Houses in -Z quadrant can go +Z (toward horizontal road)
            const validDirections = [];
            if (localHouseX > roadHalf) validDirections.push('toVerticalFromRight');   // go -X
            if (localHouseX < -roadHalf) validDirections.push('toVerticalFromLeft');   // go +X
            if (localHouseZ > roadHalf) validDirections.push('toHorizontalFromTop');   // go -Z
            if (localHouseZ < -roadHalf) validDirections.push('toHorizontalFromBottom'); // go +Z
            
            // Pick random valid direction
            if (validDirections.length > 0) {
                const direction = validDirections[Math.floor(seededRandom() * validDirections.length)];
                
                // Calculate house edge based on rotation
                // When rotated 90° or 270°, width and depth are swapped
                const isRotated90 = Math.abs(Math.sin(rotation)) > 0.5;
                const effectiveHalfW = isRotated90 ? depth / 2 : width / 2;
                const effectiveHalfD = isRotated90 ? width / 2 : depth / 2;
                
                let roadEdge, houseEdge;
                
                if (direction === 'toVerticalFromRight') {
                    // House is right of road, driveway goes left (-X) to road edge
                    roadEdge = tileWorldX + roadHalf - roadInset;
                    houseEdge = posX - effectiveHalfW;
                    drivewayLength = houseEdge - roadEdge;
                    drivewayX = roadEdge + drivewayLength / 2;
                    drivewayZ = posZ + drivewayOffset;
                } else if (direction === 'toVerticalFromLeft') {
                    // House is left of road, driveway goes right (+X) to road edge
                    roadEdge = tileWorldX - roadHalf + roadInset;
                    houseEdge = posX + effectiveHalfW;
                    drivewayLength = roadEdge - houseEdge;
                    drivewayX = houseEdge + drivewayLength / 2;
                    drivewayZ = posZ + drivewayOffset;
                } else if (direction === 'toHorizontalFromTop') {
                    // House is above road, driveway goes down (-Z) to road edge
                    roadEdge = tileWorldZ + roadHalf - roadInset;
                    houseEdge = posZ - effectiveHalfD;
                    drivewayLength = houseEdge - roadEdge;
                    drivewayX = posX + drivewayOffset;
                    drivewayZ = roadEdge + drivewayLength / 2;
                } else if (direction === 'toHorizontalFromBottom') {
                    // House is below road, driveway goes up (+Z) to road edge
                    roadEdge = tileWorldZ - roadHalf + roadInset;
                    houseEdge = posZ + effectiveHalfD;
                    drivewayLength = roadEdge - houseEdge;
                    drivewayX = posX + drivewayOffset;
                    drivewayZ = houseEdge + drivewayLength / 2;
                }
                
                
                
                drivewayLength = Math.abs(drivewayLength);
                
                // Only create driveway if it has reasonable length
                if (drivewayLength > 1 && drivewayLength < 60) {
                    const isXDirection = direction.includes('Vertical');
                    const driveway = BABYLON.MeshBuilder.CreateGround(`driveway_${gridX}_${gridZ}_${qi}`, {
                        width: isXDirection ? drivewayLength : drivewayWidth,
                        height: isXDirection ? drivewayWidth : drivewayLength
                    }, this.scene);
                    driveway.position = new BABYLON.Vector3(drivewayX, 0.03, drivewayZ);
                    driveway.material = this.drivewayMaterial;
                    driveway.isPickable = false;
                    drivewayMeshes.push(driveway);
                    this.drivewaysByTile[tileKey].push(driveway);

                    // Add a door on the same side as the driveway
                        // Use the actual driveway position to find the closest face
                    const doorWidth = 1.2;
                    const doorHeight = 2.2;
                    const doorDepth = 0.1;
                    const doorY = -height / 2 + doorHeight / 2 + 0.02;
                    const doorOffset = 0.02;
                    
                    const cosRot = Math.cos(rotation);
                    const sinRot = Math.sin(rotation);
                    
                    // Calculate the world position of each face center
                    // Babylon.js left-handed Y rotation: wx = posX + lx*cos + lz*sin, wz = posZ - lx*sin + lz*cos
                    const faces = [
                        { 
                            wx: posX + (width/2) * cosRot,
                            wz: posZ - (width/2) * sinRot,
                            localX: width/2 + doorOffset, localZ: 0, face: '+X' 
                        },
                        { 
                            wx: posX - (width/2) * cosRot,
                            wz: posZ + (width/2) * sinRot,
                            localX: -(width/2 + doorOffset), localZ: 0, face: '-X' 
                        },
                        { 
                            wx: posX + (depth/2) * sinRot,
                            wz: posZ + (depth/2) * cosRot,
                            localX: 0, localZ: depth/2 + doorOffset, face: '+Z' 
                        },
                        { 
                            wx: posX - (depth/2) * sinRot,
                            wz: posZ - (depth/2) * cosRot,
                            localX: 0, localZ: -(depth/2 + doorOffset), face: '-Z' 
                        }
                    ];
                    
                    // Find face whose CENTER is closest to where the driveway actually connects
                    // Use the actual driveway connection point (includes offset)
                    let targetX, targetZ;
                    if (direction.includes('Vertical')) {
                        // Driveway along X axis - connects at (houseEdge, drivewayZ)
                        targetX = houseEdge;
                        targetZ = drivewayZ;
                    } else {
                        // Driveway along Z axis - connects at (drivewayX, houseEdge)
                        targetX = drivewayX;
                        targetZ = houseEdge;
                    }
                    
                    let bestFace = faces[0];
                    let bestDist = Infinity;
                    for (const face of faces) {
                        const dist = Math.sqrt(
                            Math.pow(face.wx - targetX, 2) + 
                            Math.pow(face.wz - targetZ, 2)
                        );
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestFace = face;
                        }
                    }
                    
                    const onXSide = bestFace.face === '+X' || bestFace.face === '-X';
                    const door = BABYLON.MeshBuilder.CreateBox(`door_${gridX}_${gridZ}_${qi}`, {
                        width: onXSide ? doorDepth : doorWidth,
                        height: doorHeight,
                        depth: onXSide ? doorWidth : doorDepth
                    }, this.scene);
                    door.material = this.doorMaterial;
                    door.parent = house;
                    door.position = new BABYLON.Vector3(bestFace.localX, doorY, bestFace.localZ);
                    doorMeshes.push(door);
                }
            }
            
            // Bake house transform into vertices for merging
            house.computeWorldMatrix(true);
            house.getChildMeshes().forEach(child => {
                child.setParent(null);
                child.bakeCurrentTransformIntoVertices();
                child.position.set(0, 0, 0);
                child.rotation.set(0, 0, 0);
                child.scaling.set(1, 1, 1);
            });
            house.bakeCurrentTransformIntoVertices();
            house.position.set(0, 0, 0);
            house.rotation.set(0, 0, 0);
            house.scaling.set(1, 1, 1);

            if (!wallMeshesByMat.has(mats.wall)) {
                wallMeshesByMat.set(mats.wall, []);
            }
            wallMeshesByMat.get(mats.wall).push(house);

            this.housesByTile[tileKey].push(houseCollision);
            
            // Track for overlap checking within this tile
            placedHouses.push({ x: posX, z: posZ, w: width, d: depth });
        });

        // Merge visual meshes per material to reduce draw calls
        const mergedMeshes = [];
        wallMeshesByMat.forEach((meshes, mat) => {
            if (meshes.length === 0) return;
            const merged = BABYLON.Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
            if (merged) {
                merged.material = mat;
                merged.isPickable = false;
                merged.freezeWorldMatrix();
                mergedMeshes.push(merged);
            }
        });
        if (windowMeshes.length > 0) {
            const mergedWindows = BABYLON.Mesh.MergeMeshes(windowMeshes, true, true, undefined, false, true);
            if (mergedWindows) {
                mergedWindows.material = this.windowMaterial;
                mergedWindows.isPickable = false;
                mergedWindows.freezeWorldMatrix();
                mergedMeshes.push(mergedWindows);
            }
        }
        if (doorMeshes.length > 0) {
            const mergedDoors = BABYLON.Mesh.MergeMeshes(doorMeshes, true, true, undefined, false, true);
            if (mergedDoors) {
                mergedDoors.material = this.doorMaterial;
                mergedDoors.isPickable = false;
                mergedDoors.freezeWorldMatrix();
                mergedMeshes.push(mergedDoors);
            }
        }
        if (drivewayMeshes.length > 0) {
            const mergedDriveways = BABYLON.Mesh.MergeMeshes(drivewayMeshes, true, true, undefined, false, true);
            if (mergedDriveways) {
                mergedDriveways.material = this.drivewayMaterial;
                mergedDriveways.isPickable = false;
                mergedDriveways.freezeWorldMatrix();
                mergedMeshes.push(mergedDriveways);
            }
        }
        this.visualsByTile[tileKey] = mergedMeshes;
    }
    
    removeHousesForTile(gridX, gridZ) {
        const tileKey = `${gridX}_${gridZ}`;
        if (this.pendingHouseTileSet && this.pendingHouseTileSet.has(tileKey)) {
            this.pendingHouseTileSet.delete(tileKey);
            if (this.pendingHouseTiles) {
                this.pendingHouseTiles = this.pendingHouseTiles.filter(key => key !== tileKey);
            }
        }
        if (this.housesByTile[tileKey]) {
            this.housesByTile[tileKey].forEach(h => {
                if (h && !h.isDisposed()) h.dispose();
            });
            delete this.housesByTile[tileKey];
        }
        // Also remove driveways for this tile
        if (this.drivewaysByTile && this.drivewaysByTile[tileKey]) {
            this.drivewaysByTile[tileKey].forEach(d => {
                if (d && !d.isDisposed()) d.dispose();
            });
            delete this.drivewaysByTile[tileKey];
        }
    }
    
    updateInfiniteGround(playerX, playerZ) {
        // Calculate which tile the player is on
        const currentTileX = Math.floor(playerX / this.groundTileSize);
        const currentTileZ = Math.floor(playerZ / this.groundTileSize);
        
        // Only update if player moved to a new tile
        if (currentTileX === this.lastTileUpdatePos.x && currentTileZ === this.lastTileUpdatePos.z) {
            return;
        }
        
        // Track which tile positions we need
        const neededTiles = this._neededTiles;
        neededTiles.clear();
        const halfGrid = Math.floor(this.groundTilesPerSide / 2);
        for (let x = -halfGrid; x <= halfGrid; x++) {
            for (let z = -halfGrid; z <= halfGrid; z++) {
                neededTiles.add(`${currentTileX + x}_${currentTileZ + z}`);
            }
        }

        // House creation range (centered on player, no directional bias)
        const houseNeededTiles = this._houseNeededTiles;
        houseNeededTiles.clear();
        const houseHalfGrid = halfGrid + 3;
        const forwardTiles = Math.ceil(100 / this.groundTileSize); // ~100m further
        const maxRange = houseHalfGrid + forwardTiles;
        for (let x = -maxRange; x <= maxRange; x++) {
            for (let z = -maxRange; z <= maxRange; z++) {
                const dist = Math.sqrt(x * x + z * z) || 1;
                const inNearRing = dist <= halfGrid + 1;
                const inRange = dist <= maxRange;
                if (inNearRing || inRange) {
                    houseNeededTiles.add(`${currentTileX + x}_${currentTileZ + z}`);
                }
            }
        }
        
        // Keep houses persistent (do not remove when leaving tiles)
        
        this.lastTileUpdatePos = { x: currentTileX, z: currentTileZ };
        
        // Reposition tiles around player and create houses for new tiles
        let tileIndex = 0;
        
        for (let x = -halfGrid; x <= halfGrid; x++) {
            for (let z = -halfGrid; z <= halfGrid; z++) {
                const tile = this.groundTiles[tileIndex];
                const newGridX = currentTileX + x;
                const newGridZ = currentTileZ + z;
                const oldKey = `${tile.gridX}_${tile.gridZ}`;
                const newKey = `${newGridX}_${newGridZ}`;
                
                // Only update if tile position changed
                if (oldKey !== newKey) {
                    tile.position.x = newGridX * this.groundTileSize;
                    tile.position.z = newGridZ * this.groundTileSize;
                    tile.gridX = newGridX;
                    tile.gridZ = newGridZ;
                    
                    // Create houses for this new tile position if not already exists
                    // Skip pickup area tiles and all destination tiles (no auto-generated houses)
                    const skipTile = (this.pickupExcludedTiles && this.pickupExcludedTiles.has(newKey));
                    if (!skipTile && !this.hasLiveHouses(newKey) && !this.pendingHouseTileSet.has(newKey)) {
                        this.pendingHouseTiles.push(newKey);
                        this.pendingHouseTileSet.add(newKey);
                    }
                }
                
                // Apply destination tile material if this tile is part of the drop-off block
                if (this.destinationTileOverrides && this.destinationTileMaterials) {
                    const cornerKey = this.destinationTileOverrides[newKey];
                    if (cornerKey && this.destinationTileMaterials[cornerKey]) {
                        tile.material = this.destinationTileMaterials[cornerKey];
                    } else {
                        for (const key in this.destinationTileMaterials) {
                            if (tile.material === this.destinationTileMaterials[key]) {
                                tile.material = this.groundMaterial;
                                break;
                            }
                        }
                    }
                }
                
                tileIndex++;
            }
        }

        if (this.houseStreamingEnabled === false) {
            const nowMs = Date.now();
            if (nowMs - this._houseStreamingLogTime > 5000) {
                console.log('🏠 HOUSE STREAM: disabled (press 1 to toggle on)');
                this._houseStreamingLogTime = nowMs;
            }
            return;
        }

        // If the queue grows too large, reset and rebuild it for the current range
        if (this.pendingHouseTiles.length > 600) {
            this.pendingHouseTiles = [];
            this.pendingHouseTileSet.clear();
        }

        // Enqueue additional house tiles within extended range
        // Skip pickup area tiles and all destination tiles (no auto-generated houses)
        houseNeededTiles.forEach((tileKey) => {
            const skipTile = (this.pickupExcludedTiles && this.pickupExcludedTiles.has(tileKey));
            if (!skipTile && !this.hasLiveHouses(tileKey) && !this.pendingHouseTileSet.has(tileKey)) {
                this.pendingHouseTiles.push(tileKey);
                this.pendingHouseTileSet.add(tileKey);
            }
        });

        // Populate nearby tiles first when idle time is scarce.
        const tileDistance = (key) => {
            const [x, z] = key.split('_').map(Number);
            return (x - currentTileX) ** 2 + (z - currentTileZ) ** 2;
        };
        this.pendingHouseTiles.sort((a, b) => tileDistance(a) - tileDistance(b));

        // Process house creation off the render loop to avoid frame stutter
        this.scheduleHouseWork(houseNeededTiles, currentTileX, currentTileZ);

        // House streaming logs disabled for performance
        
        // Physics ground is large enough to not need moving with Havok
        // Keep far ground centered on player to avoid reaching its edge
        if (this.farGround) {
            this.farGround.position.x = playerX;
            this.farGround.position.z = playerZ;
        }
        // Align far-ground texture to world grid so roads don't pop
        if (this.farGroundTexture) {
            const uScale = this.farGroundTexture.uScale || 1;
            const vScale = this.farGroundTexture.vScale || 1;
            this.farGroundTexture.uOffset = (playerX / this.groundTileSize) - 0.5 * uScale;
            this.farGroundTexture.vOffset = (playerZ / this.groundTileSize) - 0.5 * vScale;
        }

    }

    setHouseStreamingEnabled(enabled) {
        this.houseStreamingEnabled = enabled;
        if (enabled) {
            // Reset queue so houses repopulate around current position
            this.pendingHouseTiles = [];
            this.pendingHouseTileSet.clear();
        }
    }

    setFarGroundEnabled(enabled) {
        this.farGroundEnabled = enabled;
        if (this.farGround) {
            this.farGround.setEnabled(enabled);
        }
    }

    setPostProcessingEnabled(enabled) {
        if (this.postProcessPipeline) {
            this.postProcessPipeline.enabled = enabled;
        }
    }

    scheduleHouseWork(houseNeededTiles, currentTileX, currentTileZ) {
        if (this._houseWorkScheduled || !this.houseStreamingEnabled || !this.pendingHouseTiles.length) return;
        this._houseWorkScheduled = true;

        const runner = (deadline) => {
            this._houseWorkScheduled = false;
            if (!this.houseStreamingEnabled) return;
            const maxMillis = 3; // Budget per idle callback
            const start = performance.now();
            while (this.pendingHouseTiles.length > 0) {
                // A tile cannot be interrupted: reserve time before starting it.
                if (performance.now() - start >= maxMillis) break;
                if (!deadline.didTimeout && deadline.timeRemaining() < maxMillis) break;
                const tileKey = this.pendingHouseTiles.shift();
                this.pendingHouseTileSet.delete(tileKey);
                if (!houseNeededTiles.has(tileKey)) continue;
                if (this.hasLiveHouses(tileKey)) continue;
                const [gridX, gridZ] = tileKey.split('_').map(Number);
                this.createHousesForTile(gridX, gridZ);
                // Busy browsers still make progress, but never force a batch.
                if (deadline.didTimeout) break;
            }

            if (this.pendingHouseTiles.length > 0) {
                this.scheduleHouseWork(houseNeededTiles, currentTileX, currentTileZ);
            }
        };

        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(runner, { timeout: 100 });
        } else {
            setTimeout(() => runner({ didTimeout: true, timeRemaining: () => 0 }), 16);
        }
    }
    
    setupPostProcessing() {
        const pipeline = new BABYLON.DefaultRenderingPipeline('pipeline', true, this.scene, [this.camera]);
        pipeline.imageProcessing.toneMappingEnabled = true;
        pipeline.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
        pipeline.imageProcessing.exposure = 1.0;
        pipeline.imageProcessing.contrast = 1.0;
        pipeline.bloomEnabled = true;
        // Keep bloom but reduce kernel size for faster post-processing
        pipeline.bloomThreshold = 0.9;
        pipeline.bloomWeight = 0.05;
        pipeline.bloomKernel = 32;
        pipeline.bloomScale = 0.5;
        pipeline.fxaaEnabled = true;
        pipeline.imageProcessing.vignetteEnabled = true;
        pipeline.imageProcessing.vignetteWeight = 0.6;
        // Reduce post-process MSAA cost while keeping FXAA
        pipeline.samples = 1;
        this.postProcessPipeline = pipeline;
    }
    
    addShadowCaster(mesh) {
        if (this.shadowGenerator) this.shadowGenerator.addShadowCaster(mesh, true);
    }
    
    setFollowTarget(truck) {
        this.followTarget = truck;
        this.targetCameraAlpha = this.camera.alpha; // Store initial camera alpha
    }
    
    updateCameraFollow(deltaTime = this.engine.getDeltaTime() / 1000) {
        if (!this.followTarget || !this.camera || !this.cameraFollowEnabled) return;
        const dt = Math.max(0, Math.min(deltaTime, 0.1));
        
        // Update manual look-around (arrow keys)
        this.updateCameraLook(dt);
        
        const truck = this.followTarget;
        
        // LOCK camera target directly to truck position (no smoothing = no stutter)
        const target = this.camera.target;
        target.x = truck.position.x;
        target.y = truck.cargoFloorHeight + 0.5;
        target.z = truck.position.z;
        
        // Force radius to stay fixed
        this.camera.radius = 15;
        
        // Base camera angle (behind truck, looking at cab)
        const baseAlpha = -truck.rotation + Math.PI / 2;
        
        // Smoothly apply vertical offset (beta) - keep smooth for manual look
        const baseBeta = this.gameplayCameraSettings.beta;
        const desiredBeta = baseBeta + this.cameraBetaOffset + this.touchBetaOffset;
        const betaSmoothing = 1 - Math.exp(-8 * dt);
        this.camera.beta += (desiredBeta - this.camera.beta) * betaSmoothing;
        
        // Follow heading immediately. Only player look-around gets smoothing.
        const desiredOffset = this.keyAngleOffset + this.mouseAngleOffset + this.touchAngleOffset;
        const rotSmoothing = 1 - Math.exp(-12 * dt);
        let alphaDiff = desiredOffset - this.cameraAngleOffset;
        while (alphaDiff > Math.PI) alphaDiff -= Math.PI * 2;
        while (alphaDiff < -Math.PI) alphaDiff += Math.PI * 2;
        
        this.cameraAngleOffset += alphaDiff * rotSmoothing;
        this.camera.alpha = baseAlpha + this.cameraAngleOffset;
    }
    
    debugMeshes() {}
}
