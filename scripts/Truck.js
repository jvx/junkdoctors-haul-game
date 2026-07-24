/**
 * Truck - The box truck entity with cargo area
 * IMPORTANT: Meshes with physics impostors should NOT be parented
 */
class Truck {
    constructor(scene, sceneManager, audioManager = null) {
        this.scene = scene;
        this.sceneManager = sceneManager;
        this.audioManager = audioManager;
        this.meshes = {};
        this.physicsMeshes = []; // Store unparented physics meshes
        
        // Truck dimensions (meters)
        this.cargoLength = 4.8;
        this.cargoWidth = 2.4;
        this.cargoHeight = 2.2;
        this.cargoFloorHeight = 1.0;
        this.floorTopY = 1.25; // Top surface of floor for item placement (floor center + half thickness)
        
        this.cargoBounds = null;
        
        // Driving properties
        this.position = new BABYLON.Vector3(0, 0, 0);
        this.rotation = 0; // Y-axis rotation (heading)
        this.speed = 0;
        this.prevSpeed = 0;
        this.maxSpeed = 110; // Top speed 110 mph
        this.baseAcceleration = 15; // Base acceleration (modified by gear)
        this.deceleration = 18; // Coasting deceleration
        this.brakeDeceleration = 60; // Stronger braking
        this.autoBrakeDeceleration = this.brakeDeceleration; // Use full brakes on drop-off
        this.turnSpeed = 1.9;   // Sharper turns
        this.rearAxleOffset = 2.5; // Distance from center to rear axle (pivot point for steering)
        this.currentAcceleration = 0; // For physics effects on items
        this.turnRate = 0; // Current turn rate for physics effects
        this.autoBrakeTimer = 0; // Seconds remaining for automatic braking
        
        // Automatic transmission (dump truck = very slow acceleration)
        this.currentGear = 0; // 0 = Neutral, 1-5 = Forward gears, -1 = Reverse
        this.gearSpeeds = [0, 25, 50, 75, 95, 110]; // Speed thresholds for upshifting
        this.gearDownSpeeds = [0, 20, 45, 70, 90, 105]; // Slightly lower for downshifting (hysteresis)
        this.gearAcceleration = [12, 12, 8, 5, 3, 1.5]; // Heavy dump truck = very sluggish

        // Payload physics: cargo weight reduces acceleration and lengthens braking (F = ma)
        this.truckBaseMass = 800; // Effective unladen mass in item-weight units (tuned for feel)
        this.payloadWeight = 0;   // Sum of loaded (non-fallen) item weights
        this.loadAccelFactor = 1; // truckBaseMass / (truckBaseMass + payload), clamped

        // Suspension weight transfer: spring-damped body lean (radians).
        // Applied to root.rotation.x/z and to the animated cargo bed physics
        // bodies, so cargo physically feels the bed tilt under braking/turning.
        this.suspensionPitch = 0;    // rotation.x: negative = nose (-Z) dips, e.g. braking from forward
        this.suspensionRoll = 0;     // rotation.z: body rolls away from the turn center
        this.suspensionPitchVel = 0;
        this.suspensionRollVel = 0;
        this.suspensionStiffness = 60;     // Spring rate (1/s^2), ~0.9 damping ratio with damping below
        this.suspensionDamping = 14;       // Damper rate (1/s)
        this.suspensionPitchGain = 0.0022; // rad per m/s^2 of longitudinal acceleration
        this.suspensionRollGain = 0.0016;  // rad per m/s^2 of lateral acceleration
        this.suspensionMaxPitch = 0.025;   // ~1.4 deg cap
        this.suspensionMaxRoll = 0.03;     // ~1.7 deg cap
        
        // Input state
        this.keys = { w: false, a: false, s: false, d: false, space: false };
        
        // Items on truck
        this.loadedItems = [];
        this.enablePerfStats = false;
        this.enableItemPhysics = true;
    }
    
    create() {
        const scene = this.scene;
        
        // Root node for non-physics meshes only
        this.root = new BABYLON.TransformNode('truck', scene);
        
        // Materials - JunkDoctors blue rgb(0,87,184)
        // Using StandardMaterial for accurate color (PBR can wash out colors with lighting)
        const truckBlue = new BABYLON.Color3(0, 87/255, 184/255);
        
        const cabMat = new BABYLON.StandardMaterial('cabMat', scene);
        cabMat.diffuseColor = new BABYLON.Color3(0.95, 0.95, 0.95); // White cab
        cabMat.specularColor = new BABYLON.Color3(0.3, 0.3, 0.3);
        cabMat.specularPower = 32;
        
        const cargoMat = new BABYLON.StandardMaterial('cargoMat', scene);
        cargoMat.diffuseColor = truckBlue;
        cargoMat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
        cargoMat.specularPower = 32;
        
        // Cab (visual only, no physics, can be parented)
        const cab = BABYLON.MeshBuilder.CreateBox('cab', { width: 2.2, height: 1.7, depth: 1.8 }, scene);
        cab.position = new BABYLON.Vector3(0, this.cargoFloorHeight + 0.85, -this.cargoLength / 2 - 1.0);
        cab.material = cabMat;
        cab.parent = this.root;
        cab.isPickable = false; // Don't block raycasts for item placement
        this.sceneManager.addShadowCaster(cab);
        this.meshes.cab = cab;
        
        // Window material with rounded corners
        const createRoundedGlassMaterial = (name, texW, texH, radius) => {
            const tex = new BABYLON.DynamicTexture(`${name}Tex`, { width: texW, height: texH }, scene, true);
            const ctx = tex.getContext();
            ctx.clearRect(0, 0, texW, texH);
            ctx.fillStyle = 'rgba(255, 255, 255, 1)';
            ctx.beginPath();
            const r = Math.min(radius, texW / 2, texH / 2);
            ctx.moveTo(r, 0);
            ctx.lineTo(texW - r, 0);
            ctx.quadraticCurveTo(texW, 0, texW, r);
            ctx.lineTo(texW, texH - r);
            ctx.quadraticCurveTo(texW, texH, texW - r, texH);
            ctx.lineTo(r, texH);
            ctx.quadraticCurveTo(0, texH, 0, texH - r);
            ctx.lineTo(0, r);
            ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath();
            ctx.fill();
            tex.hasAlpha = true;
            tex.update();

            const mat = new BABYLON.StandardMaterial(name, scene);
            mat.diffuseColor = new BABYLON.Color3(0.1, 0.15, 0.2);
            mat.specularColor = new BABYLON.Color3(0.2, 0.3, 0.4);
            mat.alpha = 0.6;
            mat.opacityTexture = tex;
            mat.backFaceCulling = false;
            return mat;
        };

        // Windshield (rounded)
        const windshieldMat = createRoundedGlassMaterial('windshieldMat', 256, 128, 18);
        const windshield = BABYLON.MeshBuilder.CreatePlane('windshield', { width: 1.9, height: 0.75 }, scene);
        // Push slightly in front of the cab face so it isn't occluded
        windshield.position = new BABYLON.Vector3(0, this.cargoFloorHeight + 1.15, -this.cargoLength / 2 - 1.95);
        windshield.rotation.y = Math.PI; // Face forward
        windshield.material = windshieldMat;
        windshield.parent = this.root;
        windshield.isPickable = false; // Don't block raycasts

        // Side windows (cab doors) with rounded corners
        const sideWindowSize = { width: 0.02, height: 0.75, depth: 1.2 };
        const cabCenterZ = -this.cargoLength / 2 - 1.0;
        const sideWindowY = this.cargoFloorHeight + 1.15;
        const sideWindowOffsetX = 1.13;
        const sideWindowMat = createRoundedGlassMaterial('sideWindowMat', 256, 128, 16);

        const leftWindow = BABYLON.MeshBuilder.CreatePlane('cabWindowLeft', { width: sideWindowSize.depth, height: sideWindowSize.height }, scene);
        leftWindow.position = new BABYLON.Vector3(-sideWindowOffsetX, sideWindowY, cabCenterZ);
        leftWindow.rotation.y = -Math.PI / 2;
        leftWindow.material = sideWindowMat;
        leftWindow.parent = this.root;
        leftWindow.isPickable = false;

        const rightWindow = BABYLON.MeshBuilder.CreatePlane('cabWindowRight', { width: sideWindowSize.depth, height: sideWindowSize.height }, scene);
        rightWindow.position = new BABYLON.Vector3(sideWindowOffsetX, sideWindowY, cabCenterZ);
        rightWindow.rotation.y = Math.PI / 2;
        rightWindow.material = sideWindowMat;
        rightWindow.parent = this.root;
        rightWindow.isPickable = false;
        
        // === PHYSICS MESHES - NO PARENT ===
        
        // Cargo floor - thicker for better physics collision with large items
        const floorThickness = 0.5;
        const floor = BABYLON.MeshBuilder.CreateBox('truckBed', { 
            width: this.cargoWidth, 
            height: floorThickness, 
            depth: this.cargoLength 
        }, scene);
        floor.position = new BABYLON.Vector3(0, this.cargoFloorHeight, 0);
        floor.material = cargoMat;
        floor.receiveShadows = true;
        floor.isPickable = true;
        floor.parent = this.root; // Parent for driving
        this.sceneManager.addShadowCaster(floor);
        this.meshes.floor = floor;
        this.physicsMeshes.push(floor);

        const wallThickness = 0.1;

        // Load guide lines on side walls (green)
        // Each line represents 6.75 cubic yards of the 25 yd³ capacity
        const lineMat = new BABYLON.StandardMaterial('loadLineMat', scene);
        lineMat.diffuseColor = new BABYLON.Color3(0.1, 0.6, 0.2);
        lineMat.emissiveColor = new BABYLON.Color3(0.05, 0.2, 0.08);
        lineMat.specularColor = new BABYLON.Color3(0, 0, 0);

        const lineThickness = 0.01;
        const lineHeight = 0.04;
        const lineLength = this.cargoLength * 0.96;
        const wallInset = 0.001;
        const lineFractions = [6.75 / 25, (6.75 * 2) / 25, (6.75 * 3) / 25];

        lineFractions.forEach((frac, idx) => {
            const y = this.cargoFloorHeight + this.cargoHeight * frac;
            const leftLine = BABYLON.MeshBuilder.CreateBox(`loadLineLeft${idx + 1}`, {
                width: lineThickness,
                height: lineHeight,
                depth: lineLength
            }, scene);
            leftLine.position = new BABYLON.Vector3(
                -this.cargoWidth / 2 - wallThickness / 2 + lineThickness / 2 + wallInset,
                y,
                0
            );
            leftLine.material = lineMat;
            leftLine.parent = this.root;
            leftLine.isPickable = false;

            const rightLine = BABYLON.MeshBuilder.CreateBox(`loadLineRight${idx + 1}`, {
                width: lineThickness,
                height: lineHeight,
                depth: lineLength
            }, scene);
            rightLine.position = new BABYLON.Vector3(
                this.cargoWidth / 2 + wallThickness / 2 - lineThickness / 2 - wallInset,
                y,
                0
            );
            rightLine.material = lineMat;
            rightLine.parent = this.root;
            rightLine.isPickable = false;
        });
        
        // Left wall (physics-enabled)
        const leftWall = BABYLON.MeshBuilder.CreateBox('leftWall', { 
            width: wallThickness, height: this.cargoHeight, depth: this.cargoLength 
        }, scene);
        leftWall.position = new BABYLON.Vector3(
            -this.cargoWidth / 2 - wallThickness / 2, 
            this.cargoFloorHeight + this.cargoHeight / 2, 
            0
        );
        leftWall.material = cargoMat;
        leftWall.parent = this.root; // Parent for driving
        leftWall.isPickable = false; // Don't block raycasts for item placement
        this.sceneManager.addShadowCaster(leftWall);
        this.meshes.leftWall = leftWall;
        this.physicsMeshes.push(leftWall);
        
        // Right wall (physics-enabled)
        const rightWall = BABYLON.MeshBuilder.CreateBox('rightWall', { 
            width: wallThickness, height: this.cargoHeight, depth: this.cargoLength 
        }, scene);
        rightWall.position = new BABYLON.Vector3(
            this.cargoWidth / 2 + wallThickness / 2, 
            this.cargoFloorHeight + this.cargoHeight / 2, 
            0
        );
        rightWall.material = cargoMat;
        rightWall.parent = this.root; // Parent for driving
        rightWall.isPickable = false; // Don't block raycasts for item placement
        this.sceneManager.addShadowCaster(rightWall);
        this.meshes.rightWall = rightWall;
        this.physicsMeshes.push(rightWall);
        
        // Front wall (physics-enabled)
        const frontWall = BABYLON.MeshBuilder.CreateBox('frontWall', { 
            width: this.cargoWidth, height: this.cargoHeight, depth: wallThickness 
        }, scene);
        frontWall.position = new BABYLON.Vector3(
            0, 
            this.cargoFloorHeight + this.cargoHeight / 2, 
            -this.cargoLength / 2 - wallThickness / 2
        );
        frontWall.material = cargoMat;
        frontWall.parent = this.root; // Parent for driving
        frontWall.isPickable = false; // Don't block raycasts for item placement
        this.sceneManager.addShadowCaster(frontWall);
        this.meshes.frontWall = frontWall;
        this.physicsMeshes.push(frontWall);
        
        // Collision proxies (simplified meshes for faster collision checks)
        const cargoCollision = BABYLON.MeshBuilder.CreateBox('truckCollisionCargo', {
            width: this.cargoWidth + wallThickness * 2,
            height: this.cargoHeight,
            depth: this.cargoLength
        }, scene);
        cargoCollision.position = new BABYLON.Vector3(
            0,
            this.cargoFloorHeight + this.cargoHeight / 2,
            0
        );
        cargoCollision.isVisible = false;
        cargoCollision.isPickable = false;
        cargoCollision.parent = this.root;
        this.collisionProxyCargo = cargoCollision;

        const cabCollision = BABYLON.MeshBuilder.CreateBox('truckCollisionCab', {
            width: 2.2,
            height: 1.7,
            depth: 1.8
        }, scene);
        cabCollision.position = cab.position.clone();
        cabCollision.isVisible = false;
        cabCollision.isPickable = false;
        cabCollision.parent = this.root;
        this.collisionProxyCab = cabCollision;

        // Cache collision meshes to avoid per-frame allocations
        this.collisionMeshes = [this.collisionProxyCargo, this.collisionProxyCab];
        // Approximate radius in XZ for fast broadphase culling
        const truckHalfWidth = 1.3;
        const truckHalfLength = 4.3;
        this.collisionRadiusXZ = Math.hypot(truckHalfWidth, truckHalfLength);
        
        // Store initial local positions for physics recreation
        this.storeInitialPositions();
        
        // Create initial physics (static bodies for truck floor/walls)
        this.initPhysics();
        
        // === END PHYSICS MESHES ===
        
        // No roof - open top truck for gameplay
        
        // Wheels (visual only, can be parented)
        const wheelMat = new BABYLON.PBRMaterial('wheelMat', scene);
        wheelMat.albedoColor = new BABYLON.Color3(0.05, 0.05, 0.05);
        wheelMat.metallic = 0.05;
        wheelMat.roughness = 0.95;

        const rimOuterMat = new BABYLON.StandardMaterial('rimOuterMat', scene);
        rimOuterMat.diffuseColor = new BABYLON.Color3(0.95, 0.95, 0.95);
        rimOuterMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);

        const rimInnerMat = new BABYLON.StandardMaterial('rimInnerMat', scene);
        rimInnerMat.diffuseColor = new BABYLON.Color3(0.15, 0.15, 0.15);
        rimInnerMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
        
        const wheelPositions = [
            { x: -1.1, z: -this.cargoLength / 2 - 1.2, isFront: true },  // Front left
            { x: 1.1, z: -this.cargoLength / 2 - 1.2, isFront: true },   // Front right
            { x: -1.2, z: this.cargoLength / 2 - 1.2, isFront: false },  // Rear left
            { x: 1.2, z: this.cargoLength / 2 - 1.2, isFront: false },   // Rear right
        ];
        
        this.frontWheelNodes = []; // Store front wheel parent nodes for steering
        
        wheelPositions.forEach((pos, i) => {
            // For front wheels, create a parent node that we can rotate for steering
            let wheelParent = this.root;
            if (pos.isFront) {
                const steerNode = new BABYLON.TransformNode(`wheelSteer${i}`, scene);
                steerNode.position = new BABYLON.Vector3(pos.x, 0.4, pos.z);
                steerNode.parent = this.root;
                this.frontWheelNodes.push(steerNode);
                wheelParent = steerNode;
            }
            
            const wheel = BABYLON.MeshBuilder.CreateCylinder(`wheel${i}`, { diameter: 0.8, height: 0.3 }, scene);
            wheel.rotation.z = Math.PI / 2;
            // If front wheel, position is relative to steer node (which is already positioned)
            wheel.position = pos.isFront ? BABYLON.Vector3.Zero() : new BABYLON.Vector3(pos.x, 0.4, pos.z);
            wheel.material = wheelMat;
            wheel.parent = wheelParent;
            wheel.isPickable = false;
            this.sceneManager.addShadowCaster(wheel);

            const rimOffset = 0.16;
            const rimDiameter = 0.45;
            const rimThickness = 0.02;

            const rimLeft = BABYLON.MeshBuilder.CreateCylinder(`rim${i}L`, { diameter: rimDiameter, height: rimThickness }, scene);
            rimLeft.rotation.z = Math.PI / 2;
            rimLeft.position = pos.isFront 
                ? new BABYLON.Vector3(-rimOffset, 0, 0) 
                : new BABYLON.Vector3(pos.x - rimOffset, 0.4, pos.z);
            rimLeft.material = pos.x < 0 ? rimOuterMat : rimInnerMat;
            rimLeft.parent = wheelParent;
            rimLeft.isPickable = false;

            const rimRight = BABYLON.MeshBuilder.CreateCylinder(`rim${i}R`, { diameter: rimDiameter, height: rimThickness }, scene);
            rimRight.rotation.z = Math.PI / 2;
            rimRight.position = pos.isFront 
                ? new BABYLON.Vector3(rimOffset, 0, 0) 
                : new BABYLON.Vector3(pos.x + rimOffset, 0.4, pos.z);
            rimRight.material = pos.x > 0 ? rimOuterMat : rimInnerMat;
            rimRight.parent = wheelParent;
            rimRight.isPickable = false;
        });
        
        // Back lights
        const tailMat = new BABYLON.StandardMaterial('tailMat', scene);
        tailMat.emissiveColor = new BABYLON.Color3(0.3, 0.02, 0.02); // dark maroon idle
        tailMat.diffuseColor = new BABYLON.Color3(0.4, 0.04, 0.04);
        tailMat.disableLighting = true;
        this.tailLightMat = tailMat;
        
        const tailLightL = BABYLON.MeshBuilder.CreateCylinder('tailLightL', { diameter: 0.15, height: 0.05 }, scene);
        tailLightL.position = new BABYLON.Vector3(-this.cargoWidth / 2 + 0.2, this.cargoFloorHeight + 0.0, this.cargoLength / 2 + 0.05);
        tailLightL.rotation.x = Math.PI / 2; // Face backward
        tailLightL.material = tailMat;
        tailLightL.parent = this.root;
        tailLightL.isPickable = false;
        
        const tailLightR = BABYLON.MeshBuilder.CreateCylinder('tailLightR', { diameter: 0.15, height: 0.05 }, scene);
        tailLightR.position = new BABYLON.Vector3(this.cargoWidth / 2 - 0.2, this.cargoFloorHeight + 0.0, this.cargoLength / 2 + 0.05);
        tailLightR.rotation.x = Math.PI / 2; // Face backward
        tailLightR.material = tailMat;
        tailLightR.parent = this.root;
        tailLightR.isPickable = false;
        this.tailLights = [tailLightL, tailLightR];
        
        // Branding
        this.createBranding(scene, cargoMat);
        
        // Calculate cargo bounds for valid placement area
        this.cargoBounds = {
            minX: -this.cargoWidth / 2 + 0.15,
            maxX: this.cargoWidth / 2 - 0.15,
            minY: this.floorTopY,
            maxY: this.cargoFloorHeight + this.cargoHeight - 0.1,
            minZ: -this.cargoLength / 2 + 0.15,
            maxZ: this.cargoLength / 2 - 0.15
        };
        
        
    }
    
    createBranding(scene, cargoMat) {
        const self = this;
        const texWidth = 512;
        const texHeight = 256;
        
        // Load SVG and create textures
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
            const imgAspect = img.width / img.height;
            
            // Right side texture - transparent background, white logo
            const logoTex = new BABYLON.DynamicTexture('logoTex', { width: texWidth, height: texHeight }, scene, true);
            logoTex.hasAlpha = true;
            const ctx = logoTex.getContext();
            
            // Clear to transparent
            ctx.clearRect(0, 0, texWidth, texHeight);
            
            // Draw logo - slightly bigger
            let drawWidth = texWidth * 0.65;
            let drawHeight = drawWidth / imgAspect;
            if (drawHeight > texHeight * 0.7) {
                drawHeight = texHeight * 0.7;
                drawWidth = drawHeight * imgAspect;
            }
            const x = (texWidth - drawWidth) / 2;
            const y = (texHeight - drawHeight) / 2;
            ctx.drawImage(img, x, y, drawWidth, drawHeight);
            logoTex.update();
            
            // Material for logo - bright emissive so it's visible from all angles
            const brandMat = new BABYLON.StandardMaterial('brandMat', scene);
            brandMat.diffuseTexture = logoTex;
            brandMat.diffuseTexture.hasAlpha = true;
            brandMat.useAlphaFromDiffuseTexture = true;
            brandMat.emissiveTexture = logoTex;
            brandMat.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.9); // Bright white glow
            brandMat.disableLighting = true; // Ignore scene lighting for consistent brightness
            brandMat.backFaceCulling = false;
            
            // Plane dimensions - slightly bigger
            const planeWidth = self.cargoLength * 0.75;
            const planeHeight = planeWidth * (texHeight / texWidth);
            
            // Right side - slightly higher position
            const brandR = BABYLON.MeshBuilder.CreatePlane('brandR', { width: planeWidth, height: planeHeight }, scene);
            brandR.rotation.y = -Math.PI / 2;
            brandR.position = new BABYLON.Vector3(self.cargoWidth / 2 + 0.12, self.cargoFloorHeight + self.cargoHeight * 0.55, 0);
            brandR.material = brandMat;
            brandR.parent = self.root;
            brandR.isPickable = false;
            
            // Left side texture - same, no mirror
            const logoTexL = new BABYLON.DynamicTexture('logoTexL', { width: texWidth, height: texHeight }, scene, true);
            logoTexL.hasAlpha = true;
            const ctxL = logoTexL.getContext();
            
            ctxL.clearRect(0, 0, texWidth, texHeight);
            ctxL.drawImage(img, x, y, drawWidth, drawHeight);
            logoTexL.update();
            
            // Left side material - same brightness, ignore lighting
            const brandMatL = new BABYLON.StandardMaterial('brandMatL', scene);
            brandMatL.diffuseTexture = logoTexL;
            brandMatL.diffuseTexture.hasAlpha = true;
            brandMatL.useAlphaFromDiffuseTexture = true;
            brandMatL.emissiveTexture = logoTexL;
            brandMatL.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.9); // Same bright white
            brandMatL.disableLighting = true; // Ignore scene lighting
            brandMatL.backFaceCulling = false;
            
            const brandL = BABYLON.MeshBuilder.CreatePlane('brandL', { width: planeWidth, height: planeHeight }, scene);
            brandL.rotation.y = Math.PI / 2;
            brandL.position = new BABYLON.Vector3(-self.cargoWidth / 2 - 0.12, self.cargoFloorHeight + self.cargoHeight * 0.55, 0);
            brandL.material = brandMatL;
            brandL.parent = self.root;
            brandL.isPickable = false;
            
            
        };
        img.onerror = function(e) {
            
        };
        img.src = 'assets/images/jd-logo-white.svg';
    }
    
    getBounds() { return this.cargoBounds; }
    
    getFloorTopY() { return this.floorTopY; }
    
    getTotalVolume() { return this.cargoWidth * this.cargoHeight * this.cargoLength; }
    
    getUsedVolume(placedItems) {
        let used = 0;
        placedItems.forEach(item => {
            if (item.isPlaced) {
                // Use volumeM3 which has packing factor applied, fallback to bounding box
                used += item.volumeM3 || (item.size.x * item.size.y * item.size.z);
            }
        });
        return used;
    }
    
    isInsideCargo(pos) {
        const b = this.cargoBounds;
        return pos.x >= b.minX && pos.x <= b.maxX && pos.y >= b.minY && pos.z >= b.minZ && pos.z <= b.maxZ;
    }
    
    // Debug: show collision boxes
    showCollisionDebug() {
        this.debugEnabled = true;
        
        // Create truck debug box if not exists
        if (!this.truckDebugBox) {
            const truckHalfWidth = 1.3;  // Match collision detection (wall outer edge)
            const truckFront = -4.3;
            const truckBack = 2.4;
            const totalLength = truckBack - truckFront;
            const centerZ = (truckFront + truckBack) / 2;
            
            this.truckDebugBox = BABYLON.MeshBuilder.CreateBox('truckCollisionDebug', {
                width: truckHalfWidth * 2,
                height: 0.2,
                depth: totalLength
            }, this.scene);
            this.truckDebugBox.position.z = centerZ;
            this.truckDebugBox.position.y = 0.3;
            const truckMat = new BABYLON.StandardMaterial('truckDebugMat', this.scene);
            truckMat.diffuseColor = new BABYLON.Color3(0, 1, 0);
            truckMat.alpha = 0.6;
            truckMat.emissiveColor = new BABYLON.Color3(0, 0.5, 0);
            this.truckDebugBox.material = truckMat;
            this.truckDebugBox.parent = this.root;
        }
        
        this.houseDebugBoxes = [];
    }
    
    // Call this in the update loop to show nearby house collision boxes
    updateCollisionDebug() {
        if (!this.debugEnabled) return;
        
        // Clear old house debug boxes
        if (this.houseDebugBoxes) {
            this.houseDebugBoxes.forEach(box => box.dispose());
            this.houseDebugBoxes = [];
        }
        
        // Create house debug boxes for nearby houses
        if (this.sceneManager && this.sceneManager.housesByTile) {
            const checkRadius = 30;
            const allHouses = [];
            for (const tileKey in this.sceneManager.housesByTile) {
                const houses = this.sceneManager.housesByTile[tileKey];
                if (houses) allHouses.push(...houses);
            }
            if (this.sceneManager.pickupHouse) {
                allHouses.push(this.sceneManager.pickupHouse);
            }
            
            const houseMat = new BABYLON.StandardMaterial('houseDebugMat', this.scene);
            houseMat.diffuseColor = new BABYLON.Color3(1, 0, 0);
            houseMat.alpha = 0.5;
            houseMat.emissiveColor = new BABYLON.Color3(0.5, 0, 0);
            
            for (const house of allHouses) {
                if (!house || !house.position) continue;
                
                // Only show nearby houses
                const dx = house.position.x - this.position.x;
                const dz = house.position.z - this.position.z;
                if (dx * dx + dz * dz > checkRadius * checkRadius) continue;
                
                // Full house dimensions (no buffer - truck has the buffer)
                const houseWidth = house.houseWidth || 6;
                const houseDepth = house.houseDepth || 6;
                const houseRot = house.houseRotation || 0;
                
                const houseDebug = BABYLON.MeshBuilder.CreateBox('houseCollisionDebug', {
                    width: houseWidth,
                    height: 0.2,
                    depth: houseDepth
                }, this.scene);
                houseDebug.material = houseMat;
                houseDebug.position = new BABYLON.Vector3(house.position.x, 0.3, house.position.z);
                houseDebug.rotation.y = houseRot;
                this.houseDebugBoxes.push(houseDebug);
            }
        }
    }
    
    hideCollisionDebug() {
        this.debugEnabled = false;
        if (this.truckDebugBox) {
            this.truckDebugBox.dispose();
            this.truckDebugBox = null;
        }
        if (this.houseDebugBoxes) {
            this.houseDebugBoxes.forEach(box => box.dispose());
            this.houseDebugBoxes = null;
        }
    }
    
    // Debug: toggle visibility of physics walls (press '9' in game)
    togglePhysicsWallsDebug() {
        this.physicsWallsVisible = !this.physicsWallsVisible;

        if (!this.physicsWallConfig) {
            console.warn('🔧 Physics wall config missing; cannot show debug meshes.');
            return this.physicsWallsVisible;
        }

        const physicsMeshes = [
            this.truckFloorMesh,
            this.truckLeftWallMesh,
            this.truckRightWallMesh,
            this.truckFrontWallMesh,
            this.truckBackWallMesh
        ];
        physicsMeshes.forEach(mesh => {
            if (mesh) {
                mesh.isVisible = false;
            }
        });

        if (this.physicsWallsVisible) {
            if (!this._physicsDebugMat) {
                const mat = new BABYLON.StandardMaterial('physicsDebugMat', this.scene);
                mat.diffuseColor = new BABYLON.Color3(1, 0, 0);
                mat.alpha = 0.3;
                mat.wireframe = true;
                this._physicsDebugMat = mat;
            }

            if (this.physicsDebugMeshes) {
                this.physicsDebugMeshes.forEach(mesh => mesh.dispose());
            }

            const { wallHeight, sideWallThickness, frontWallThickness, backWallThickness, backGap, floorDepth, wallFloorOverlap = 0 } = this.physicsWallConfig;
            const wallCenterY = this.floorTopY - wallFloorOverlap + wallHeight / 2;

            const debugFloor = BABYLON.MeshBuilder.CreateBox('debugPhysicsFloor', {
                width: this.cargoWidth + 0.2,
                height: 0.2,
                depth: floorDepth
            }, this.scene);
            debugFloor.position.set(0, this.floorTopY - 0.12, -backGap / 2);
            debugFloor.material = this._physicsDebugMat;
            debugFloor.isPickable = false;
            debugFloor.parent = this.root;

            const debugLeft = BABYLON.MeshBuilder.CreateBox('debugPhysicsLeftWall', {
                width: sideWallThickness,
                height: wallHeight,
                depth: this.cargoLength
            }, this.scene);
            debugLeft.position.set(
                -this.cargoWidth / 2 - sideWallThickness / 2,
                wallCenterY,
                0
            );
            debugLeft.material = this._physicsDebugMat;
            debugLeft.isPickable = false;
            debugLeft.parent = this.root;

            const debugRight = BABYLON.MeshBuilder.CreateBox('debugPhysicsRightWall', {
                width: sideWallThickness,
                height: wallHeight,
                depth: this.cargoLength
            }, this.scene);
            debugRight.position.set(
                this.cargoWidth / 2 + sideWallThickness / 2,
                wallCenterY,
                0
            );
            debugRight.material = this._physicsDebugMat;
            debugRight.isPickable = false;
            debugRight.parent = this.root;

            const debugFront = BABYLON.MeshBuilder.CreateBox('debugPhysicsFrontWall', {
                width: this.cargoWidth + sideWallThickness * 2,
                height: wallHeight,
                depth: frontWallThickness
            }, this.scene);
            debugFront.position.set(
                0,
                wallCenterY,
                -this.cargoLength / 2 - frontWallThickness / 2
            );
            debugFront.material = this._physicsDebugMat;
            debugFront.isPickable = false;
            debugFront.parent = this.root;

            const debugBack = BABYLON.MeshBuilder.CreateBox('debugPhysicsBackWall', {
                width: this.cargoWidth + sideWallThickness * 2,
                height: wallHeight,
                depth: backWallThickness
            }, this.scene);
            debugBack.position.set(
                0,
                wallCenterY,
                this.cargoLength / 2 + backWallThickness / 2
            );
            debugBack.material = this._physicsDebugMat;
            debugBack.isPickable = false;
            debugBack.parent = this.root;

            this.physicsDebugMeshes = [debugFloor, debugLeft, debugRight, debugFront, debugBack];
        } else if (this.physicsDebugMeshes) {
            this.physicsDebugMeshes.forEach(mesh => mesh.dispose());
            this.physicsDebugMeshes = null;
        }

        console.log(`🔧 Physics walls visibility: ${this.physicsWallsVisible ? 'ON' : 'OFF'}`);
        return this.physicsWallsVisible;
    }
    
    
    checkCollision(newX, newZ) {
        // Get scene manager's houses
        if (!this.sceneManager) return false;
        
        // Truck collision dimensions - EXACT match to VISUAL truck outer edges
        // Cargo walls are 0.1m thick, positioned at cargoWidth/2 + wallThickness/2
        // So visual outer edge = cargoWidth/2 + wallThickness = 1.2 + 0.1 = 1.3m
        // Cab is 2.2m wide (half = 1.1m), so cargo walls are the widest part
        const truckHalfWidth = 1.3;    // Cargo wall outer edge: 1.2 + 0.1 = 1.3m
        const truckFront = -4.3;       // Cab front: -2.4 - 1.0 - 0.9 = -4.3m
        const truckBack = 2.4;         // Cargo back: +cargoLength/2 = +2.4m
        
        const truckCos = Math.cos(this.rotation);
        const truckSin = Math.sin(this.rotation);
        
        // Check points along truck perimeter (asymmetric front/back)
        // More dense points for better collision accuracy
        const checkPoints = [
            // Front corners (cab)
            { x: -truckHalfWidth, z: truckFront, name: 'front-left' },
            { x: truckHalfWidth, z: truckFront, name: 'front-right' },
            // Back corners (cargo)
            { x: -truckHalfWidth, z: truckBack, name: 'back-left' },
            { x: truckHalfWidth, z: truckBack, name: 'back-right' },
            // Front edge (cab) - more points
            { x: -truckHalfWidth * 0.75, z: truckFront, name: 'front-1' },
            { x: -truckHalfWidth * 0.5, z: truckFront, name: 'front-2' },
            { x: -truckHalfWidth * 0.25, z: truckFront, name: 'front-3' },
            { x: 0, z: truckFront, name: 'front-center' },
            { x: truckHalfWidth * 0.25, z: truckFront, name: 'front-4' },
            { x: truckHalfWidth * 0.5, z: truckFront, name: 'front-5' },
            { x: truckHalfWidth * 0.75, z: truckFront, name: 'front-6' },
            // Back edge (cargo door) - more points
            { x: -truckHalfWidth * 0.75, z: truckBack, name: 'back-1' },
            { x: -truckHalfWidth * 0.5, z: truckBack, name: 'back-2' },
            { x: -truckHalfWidth * 0.25, z: truckBack, name: 'back-3' },
            { x: 0, z: truckBack, name: 'back-center' },
            { x: truckHalfWidth * 0.25, z: truckBack, name: 'back-4' },
            { x: truckHalfWidth * 0.5, z: truckBack, name: 'back-5' },
            { x: truckHalfWidth * 0.75, z: truckBack, name: 'back-6' },
            // Left side (more points distributed along length)
            { x: -truckHalfWidth, z: truckFront * 0.85, name: 'left-1' },
            { x: -truckHalfWidth, z: truckFront * 0.7, name: 'left-2' },
            { x: -truckHalfWidth, z: truckFront * 0.55, name: 'left-3' },
            { x: -truckHalfWidth, z: truckFront * 0.4, name: 'left-4' },
            { x: -truckHalfWidth, z: truckFront * 0.25, name: 'left-5' },
            { x: -truckHalfWidth, z: truckFront * 0.1, name: 'left-6' },
            { x: -truckHalfWidth, z: 0, name: 'left-center' },
            { x: -truckHalfWidth, z: truckBack * 0.33, name: 'left-7' },
            { x: -truckHalfWidth, z: truckBack * 0.66, name: 'left-8' },
            // Right side (more points)
            { x: truckHalfWidth, z: truckFront * 0.85, name: 'right-1' },
            { x: truckHalfWidth, z: truckFront * 0.7, name: 'right-2' },
            { x: truckHalfWidth, z: truckFront * 0.55, name: 'right-3' },
            { x: truckHalfWidth, z: truckFront * 0.4, name: 'right-4' },
            { x: truckHalfWidth, z: truckFront * 0.25, name: 'right-5' },
            { x: truckHalfWidth, z: truckFront * 0.1, name: 'right-6' },
            { x: truckHalfWidth, z: 0, name: 'right-center' },
            { x: truckHalfWidth, z: truckBack * 0.33, name: 'right-7' },
            { x: truckHalfWidth, z: truckBack * 0.66, name: 'right-8' },
        ];
        
        // Track collisions for both walls and houses together
        let newCollisions = 0;
        let currentCollisions = 0;
        let collisionDetails = []; // Store detailed collision info
        
        // Check wall collisions with escape logic
        const wallCollisionResult = this.countWallCollisions(newX, newZ, truckCos, truckSin, checkPoints);
        newCollisions += wallCollisionResult.newCollisions;
        currentCollisions += wallCollisionResult.currentCollisions;
        if (wallCollisionResult.details) {
            collisionDetails.push(...wallCollisionResult.details);
        }
        
        // Skip house check if no houses exist
        if (this.sceneManager.housesByTile) {
        const checkRadius = 20;
        
        // Collect all houses including pickup house
        const allHouses = [];
        for (const tileKey in this.sceneManager.housesByTile) {
            const houses = this.sceneManager.housesByTile[tileKey];
            if (houses) allHouses.push(...houses);
        }
        // Add pickup house if it exists
        if (this.sceneManager.pickupHouse) {
            allHouses.push(this.sceneManager.pickupHouse);
        }
        
        for (const house of allHouses) {
                if (!house) continue;
                if (typeof house.isDisposed === 'function' && house.isDisposed()) continue;
                if (!house.position) continue;
                
                // Quick distance check
                const dx = house.position.x - newX;
                const dz = house.position.z - newZ;
                const distSq = dx * dx + dz * dz;
                if (distSq > checkRadius * checkRadius) continue;
                
                // Get house actual dimensions (stored during creation)
                // Use full house size - collision points on truck provide the buffer
                const houseHalfWidth = (house.houseWidth || 6) / 2;
                const houseHalfDepth = (house.houseDepth || 6) / 2;
                const houseRot = house.houseRotation || 0;
                const houseCos = Math.cos(-houseRot);
                const houseSin = Math.sin(-houseRot);
                
                for (const point of checkPoints) {
                    // Transform truck point to world space for NEW position
                    const newWorldX = newX + point.x * truckCos - point.z * truckSin;
                    const newWorldZ = newZ + point.x * truckSin + point.z * truckCos;
                    
                    // Transform world point to house's local space
                    const relX = newWorldX - house.position.x;
                    const relZ = newWorldZ - house.position.z;
                    const localX = relX * houseCos - relZ * houseSin;
                    const localZ = relX * houseSin + relZ * houseCos;
                    
                    // Check if point is INSIDE house's local bounding box (< not <=, excludes boundary)
                    const insideX = Math.abs(localX) < houseHalfWidth;
                    const insideZ = Math.abs(localZ) < houseHalfDepth;
                    if (insideX && insideZ) {
                        newCollisions++;
                        collisionDetails.push({
                            type: 'HOUSE',
                            point: point.name,
                            pointLocal: { x: point.x.toFixed(2), z: point.z.toFixed(2) },
                            pointWorld: { x: newWorldX.toFixed(2), z: newWorldZ.toFixed(2) },
                            housePos: { x: house.position.x.toFixed(2), z: house.position.z.toFixed(2) },
                            houseSize: { halfW: houseHalfWidth.toFixed(2), halfD: houseHalfDepth.toFixed(2) },
                            houseRot: (houseRot * 180 / Math.PI).toFixed(1) + '°',
                            localPos: { x: localX.toFixed(2), z: localZ.toFixed(2) },
                            penetration: {
                                x: (houseHalfWidth - Math.abs(localX)).toFixed(2),
                                z: (houseHalfDepth - Math.abs(localZ)).toFixed(2)
                            }
                        });
                    }
                    
                    // Same for current position
                    const curWorldX = this.position.x + point.x * truckCos - point.z * truckSin;
                    const curWorldZ = this.position.z + point.x * truckSin + point.z * truckCos;
                    const curRelX = curWorldX - house.position.x;
                    const curRelZ = curWorldZ - house.position.z;
                    const curLocalX = curRelX * houseCos - curRelZ * houseSin;
                    const curLocalZ = curRelX * houseSin + curRelZ * houseCos;
                    
                    if (Math.abs(curLocalX) < houseHalfWidth && Math.abs(curLocalZ) < houseHalfDepth) {
                        currentCollisions++;
                    }
                    }
                }
            }
        
        // If already stuck (in wall OR house), allow movement that reduces collisions (lets truck escape)
        if (currentCollisions > 0) {
            const blocking = newCollisions >= currentCollisions;
            if (!this._stuckLogCooldown) {
                console.log(`⚠️ STUCK: cur=${currentCollisions}, new=${newCollisions}, ${blocking ? 'BLOCKING' : 'allowing escape'}`);
                this._stuckLogCooldown = 60;
            } else {
                this._stuckLogCooldown--;
            }
            return blocking;
        }
        
        // Return true if any collision detected (for legacy compatibility)
        if (newCollisions > 0) {
            return true;
        }
        
        // Reset cooldown when not colliding
        if (this._collisionLogCooldown > 0) this._collisionLogCooldown--;
        
        return false;
    }
    
    // Count wall collisions for both current and new position (allows escape logic)
    countWallCollisions(newX, newZ, truckCos, truckSin, checkPoints) {
        const result = { newCollisions: 0, currentCollisions: 0, details: [] };
        
        // Get wall bounds from scene manager
        if (!this.sceneManager.destinationWallBounds) {
            return result;
        }
        
        const walls = this.sceneManager.destinationWallBounds;
        
        // NO buffer - collision only on actual contact
        const wallBuffer = 0;
        
        for (let wallIdx = 0; wallIdx < walls.length; wallIdx++) {
            const wall = walls[wallIdx];
            // Ensure bounds are correctly ordered (min < max)
            const minX = Math.min(wall.minX, wall.maxX);
            const maxX = Math.max(wall.minX, wall.maxX);
            const minZ = Math.min(wall.minZ, wall.maxZ);
            const maxZ = Math.max(wall.minZ, wall.maxZ);
            
            for (const point of checkPoints) {
                // Transform truck point to world space for NEW position
                const newWorldX = newX + point.x * truckCos - point.z * truckSin;
                const newWorldZ = newZ + point.x * truckSin + point.z * truckCos;
                
                // Check if point is inside wall bounds (with buffer)
                if (newWorldX >= minX - wallBuffer && newWorldX <= maxX + wallBuffer &&
                    newWorldZ >= minZ - wallBuffer && newWorldZ <= maxZ + wallBuffer) {
                    result.newCollisions++;
                    result.details.push({
                        type: 'WALL',
                        wallIndex: wallIdx,
                        point: point.name,
                        pointLocal: { x: point.x.toFixed(2), z: point.z.toFixed(2) },
                        pointWorld: { x: newWorldX.toFixed(2), z: newWorldZ.toFixed(2) },
                        wallBounds: { 
                            minX: minX.toFixed(2), maxX: maxX.toFixed(2),
                            minZ: minZ.toFixed(2), maxZ: maxZ.toFixed(2)
                        }
                    });
                }
                
                // Same for current position
                const curWorldX = this.position.x + point.x * truckCos - point.z * truckSin;
                const curWorldZ = this.position.z + point.x * truckSin + point.z * truckCos;
                
                if (curWorldX >= minX - wallBuffer && curWorldX <= maxX + wallBuffer &&
                    curWorldZ >= minZ - wallBuffer && curWorldZ <= maxZ + wallBuffer) {
                    result.currentCollisions++;
                }
            }
        }
        
        return result;
    }
    
    // Legacy method for backward compatibility - now uses countWallCollisions internally
    checkWallCollision(newX, newZ, truckCos, truckSin, checkPoints) {
        const result = this.countWallCollisions(newX, newZ, truckCos, truckSin, checkPoints);
        return result.newCollisions > 0;
    }
    
    // Check if position/rotation would cause mesh collision (accurate OBB check)
    checkMeshCollision(posX, posZ, rotY = this.rotation) {
        if (!this.sceneManager) return false;
        const frameId = this.scene.getFrameId ? this.scene.getFrameId() : 0;
        if (this._collisionCache
            && this._collisionCache.frameId === frameId
            && this._collisionCache.posX === posX
            && this._collisionCache.posZ === posZ
            && this._collisionCache.rotY === rotY) {
            return this._collisionCache.result;
        }
        
        // Temporarily move the truck root to test position
        const oldX = this.root.position.x;
        const oldZ = this.root.position.z;
        const oldRotY = this.root.rotation.y;
        this.root.position.x = posX;
        this.root.position.z = posZ;
        this.root.rotation.y = rotY;
        // Single matrix update for the truck hierarchy
        this.root.computeWorldMatrix(true);
        
        // Cache truck collision meshes
        if (!this.collisionMeshes) {
            this.collisionMeshes = [
                this.meshes.floor,
                this.meshes.leftWall,
                this.meshes.rightWall,
                this.meshes.frontWall,
                this.meshes.cab
            ].filter(m => m);
        }
        const truckMeshes = this.collisionMeshes;
        
        // Update truck mesh matrices once (children inherit from root)
        for (let i = 0; i < truckMeshes.length; i++) {
            truckMeshes[i].computeWorldMatrix(true);
        }
        
        let collision = false;
        const truckRadius = this.collisionRadiusXZ || 5;
        
        // Check nearby houses only (same + adjacent tiles)
        const housesByTile = this.sceneManager.housesByTile;
        const tileSize = this.sceneManager.groundTileSize || 50;
        const baseTileX = Math.round(posX / tileSize);
        const baseTileZ = Math.round(posZ / tileSize);
        
        if (housesByTile) {
            outer: for (let gx = baseTileX - 1; gx <= baseTileX + 1; gx++) {
                for (let gz = baseTileZ - 1; gz <= baseTileZ + 1; gz++) {
                    const houses = housesByTile[`${gx}_${gz}`];
                    if (!houses) continue;
                    for (let h = 0; h < houses.length; h++) {
                        const house = houses[h];
                        if (!house || house.isDisposed?.()) continue;
                        const dx = house.position.x - posX;
                        const dz = house.position.z - posZ;
                        const houseRadius = house.collisionRadiusXZ || 10;
                        const maxDist = truckRadius + houseRadius;
                        if (dx * dx + dz * dz > maxDist * maxDist) continue;
                        
                        // Houses are STATIC - no need to recompute their world matrix
                        for (let t = 0; t < truckMeshes.length; t++) {
                            if (truckMeshes[t].intersectsMesh(house, true)) {
                                collision = true;
                                break outer;
                            }
                        }
                    }
                }
            }
        }
        
        // Check pickup house if present
        if (!collision && this.sceneManager.pickupHouse) {
            const house = this.sceneManager.pickupHouse;
            if (house && !house.isDisposed?.()) {
                const dx = house.position.x - posX;
                const dz = house.position.z - posZ;
                const houseRadius = house.collisionRadiusXZ || 10;
                const maxDist = truckRadius + houseRadius;
                if (dx * dx + dz * dz <= maxDist * maxDist) {
                    for (let t = 0; t < truckMeshes.length; t++) {
                        if (truckMeshes[t].intersectsMesh(house, true)) {
                            collision = true;
                            break;
                        }
                    }
                }
            }
        }
        
        // Check destination walls (also static)
        if (!collision && this.sceneManager.destinationWalls) {
            const walls = this.sceneManager.destinationWalls;
            for (let w = 0; w < walls.length; w++) {
                const wall = walls[w];
                if (!wall || wall.isDisposed?.()) continue;
                for (let t = 0; t < truckMeshes.length; t++) {
                    if (truckMeshes[t].intersectsMesh(wall, true)) {
                        collision = true;
                        break;
                    }
                }
                if (collision) break;
            }
        }
        
        // Restore truck position
        this.root.position.x = oldX;
        this.root.position.z = oldZ;
        this.root.rotation.y = oldRotY;
        this.root.computeWorldMatrix(true);
        
        this._collisionCache = { frameId, posX, posZ, rotY, result: collision };
        return collision;
    }
    
    // Use Babylon.js mesh intersection for accurate collision detection
    getCollisionPushback(posX, posZ) {
        if (!this.sceneManager) return null;
        
        // Temporarily move the truck root to test position
        const oldX = this.root.position.x;
        const oldZ = this.root.position.z;
        this.root.position.x = posX;
        this.root.position.z = posZ;
        this.root.computeWorldMatrix(true);
        
        // Get the truck's collision meshes (floor + walls form the collision shape)
        const truckMeshes = [this.meshes.floor, this.meshes.leftWall, this.meshes.rightWall, this.meshes.frontWall].filter(m => m);
        
        let pushX = 0;
        let pushZ = 0;
        let collisionFound = false;
        
        // Collect all houses
        const allHouses = [];
        if (this.sceneManager.housesByTile) {
            for (const tileKey in this.sceneManager.housesByTile) {
                const houses = this.sceneManager.housesByTile[tileKey];
                if (houses) allHouses.push(...houses);
            }
        }
        if (this.sceneManager.pickupHouse) {
            allHouses.push(this.sceneManager.pickupHouse);
        }
        
        // Check intersection with each house using Babylon's built-in intersection
        for (const house of allHouses) {
            if (!house || house.isDisposed?.()) continue;
            
            // Quick distance check first
            const dx = house.position.x - posX;
            const dz = house.position.z - posZ;
            if (dx * dx + dz * dz > 625) continue; // 25m radius
            
            // Use Babylon's accurate mesh intersection
            for (const truckMesh of truckMeshes) {
                if (truckMesh.intersectsMesh(house, false)) {
                    collisionFound = true;
                    
                    // Calculate push direction from house center to truck center
                    const dirX = posX - house.position.x;
                    const dirZ = posZ - house.position.z;
                    const dist = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
                    
                    // Push in direction away from house
                    const houseHalfWidth = (house.houseWidth || 6) / 2;
                    const houseHalfDepth = (house.houseDepth || 6) / 2;
                    const pushDist = Math.max(houseHalfWidth, houseHalfDepth) * 0.1; // Push 10% of house size
                    
                    pushX += (dirX / dist) * pushDist;
                    pushZ += (dirZ / dist) * pushDist;
                }
            }
        }
        
        // Check walls
        if (this.sceneManager.destinationWalls) {
            for (const wall of this.sceneManager.destinationWalls) {
                if (!wall || wall.isDisposed?.()) continue;
                
                for (const truckMesh of truckMeshes) {
                    if (truckMesh.intersectsMesh(wall, false)) {
                        collisionFound = true;
                        
                        // Push away from wall
                        const dirX = posX - wall.position.x;
                        const dirZ = posZ - wall.position.z;
                        const dist = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
                        
                        pushX += (dirX / dist) * 0.5;
                        pushZ += (dirZ / dist) * 0.5;
                    }
                }
            }
        }
        
        // Restore truck position
        this.root.position.x = oldX;
        this.root.position.z = oldZ;
        
        if (collisionFound) {
            return { x: pushX, z: pushZ };
        }
        return null;
    }
    
    // === DRIVING CONTROLS ===
    
    initDriving() {
        const setDrivingKey = (event, isPressed) => {
            if (this.isEditableInput(event.target)) return false;

            const key = this.getDrivingKey(event);
            if (!key) return false;

            this.keys[key] = isPressed;
            event.preventDefault();
            return true;
        };

        // Set up keyboard listeners
        window.addEventListener('keydown', (e) => {
            setDrivingKey(e, true);
        });
        
        window.addEventListener('keyup', (e) => {
            setDrivingKey(e, false);
        });

        window.addEventListener('blur', () => this.resetDrivingKeys());
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.resetDrivingKeys();
        });
    }

    getDrivingKey(event) {
        const codeMap = {
            KeyW: 'w',
            KeyA: 'a',
            KeyS: 's',
            KeyD: 'd',
            Space: 'space'
        };
        if (codeMap[event.code]) return codeMap[event.code];

        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key === 'w' || key === 'a' || key === 's' || key === 'd') return key;
        if (key === ' ') return 'space';
        return null;
    }

    isEditableInput(target) {
        if (!target) return false;

        const tagName = target.tagName;
        return target.isContentEditable ||
            tagName === 'INPUT' ||
            tagName === 'TEXTAREA' ||
            tagName === 'SELECT';
    }

    resetDrivingKeys() {
        this.keys.w = false;
        this.keys.a = false;
        this.keys.s = false;
        this.keys.d = false;
        this.keys.space = false;
    }
    
    updateDriving(deltaTime, options = {}) {
        const perfEnabled = this.enablePerfStats === true;
        const perfStart = perfEnabled ? performance.now() : 0;
        const dt = Math.min(deltaTime, 0.05); // Cap delta time
        const inputEnabled = options.inputEnabled !== false;
        
        // Debug logging (only log once per second to avoid spam)
        const nowMs = Date.now();
        if (!this._lastLogTime) this._lastLogTime = nowMs;
        if (perfEnabled && !this._perfStats) {
            this._perfStats = { frames: 0, totalMs: 0, collisionMs: 0, itemsMs: 0 };
        }

        // Auto-brake countdown
        if (this.autoBrakeTimer > 0) {
            this.autoBrakeTimer = Math.max(0, this.autoBrakeTimer - dt);
        }
        const autoBraking = this.autoBrakeTimer > 0;
        
        // Store previous values for acceleration calculation and collision revert
        this.prevSpeed = this.speed;
        const prevRotation = this.rotation;
        const prevPosX = this.position.x;
        const prevPosZ = this.position.z;
        
        // Acceleration / Deceleration (Space = brake, W = forward, S = backward)
        const effectiveKeys = inputEnabled ? this.keys : { w: false, a: false, s: false, d: false, space: false };
        
        // Payload physics: heavier cargo means slower acceleration and longer
        // braking distances. Brakes are less affected than engine power.
        this.payloadWeight = this.getPayloadWeight();
        this.loadAccelFactor = Math.max(0.5, this.truckBaseMass / (this.truckBaseMass + this.payloadWeight));
        const loadedBrakeDecel = this.brakeDeceleration * (0.55 + 0.45 * this.loadAccelFactor);

        // Get gear-based acceleration (slower in higher gears)
        const gearAccel = (this.gearAcceleration[Math.max(0, this.currentGear)] || this.baseAcceleration) * this.loadAccelFactor;

        if (effectiveKeys.space || autoBraking) {
            // Spacebar = brake only (no reverse), override W/S
            const brakeDecel = loadedBrakeDecel;
            if (this.speed > 0) {
                this.speed = Math.max(0, this.speed - brakeDecel * dt);
            } else if (this.speed < 0) {
                this.speed = Math.min(0, this.speed + brakeDecel * dt);
            }
        } else if (effectiveKeys.w) {
            // If moving backward, brake harder first
            if (this.speed > 0) {
                this.speed = Math.max(0, this.speed - loadedBrakeDecel * dt);
            } else {
                this.speed -= gearAccel * dt; // Negative Z is forward (toward cab)
            }
        } else if (effectiveKeys.s) {
            // If moving forward, brake harder first
            if (this.speed < 0) {
                this.speed = Math.min(0, this.speed + loadedBrakeDecel * dt);
            } else {
                this.speed += gearAccel * dt;
            }
        } else {
            // Decelerate when no input
            if (this.speed > 0) {
                this.speed = Math.max(0, this.speed - this.deceleration * dt);
            } else if (this.speed < 0) {
                this.speed = Math.min(0, this.speed + this.deceleration * dt);
            }
        }
        
        // Clamp speed (forward is negative, reverse is positive and slower)
        this.speed = Math.max(-this.maxSpeed, Math.min(this.maxSpeed * 0.3, this.speed));

        // Snap tiny residual speed to zero only while coasting.
        // Active W/S input starts from tiny per-frame acceleration values.
        const hasDrivingInput = effectiveKeys.w || effectiveKeys.s || effectiveKeys.space;
        if (!hasDrivingInput && !autoBraking && this.autoBrakeTimer === 0 && Math.abs(this.speed) < 0.2) {
            this.speed = 0;
        }
        
        // Update automatic transmission
        this.updateGear();
        
        // Calculate current acceleration (for item physics)
        this.currentAcceleration = (this.speed - this.prevSpeed) / dt;
        
        // Turning (only when moving) - A = left, D = right
        this.turnRate = 0;
        if (this.turnInput === undefined) this.turnInput = 0;
        const rawTurnInput = (effectiveKeys.a ? 1 : 0) + (effectiveKeys.d ? -1 : 0);
        const turnLerp = Math.min(1, dt * 12);
        this.turnInput += (rawTurnInput - this.turnInput) * turnLerp;
        const isTurning = Math.abs(rawTurnInput) > 0.01;
        const isBraking = effectiveKeys.space || effectiveKeys.s || autoBraking;
        
        // Initialize drift state if needed
        if (this.driftAngle === undefined) this.driftAngle = 0;
        if (this.isDrifting === undefined) this.isDrifting = false;
        
        // Check for drift conditions: braking + turning + enough speed
        const speedThreshold = this.maxSpeed * 0.3; // Need at least 30% speed to drift
        const canDrift = isBraking && isTurning && Math.abs(this.speed) > speedThreshold;
        
        if (Math.abs(this.speed) > 0.1) {
            const turnFactor = this.speed < 0 ? -1 : 1; // Flip turn when going backwards
            const absSpeed = Math.abs(this.speed);
            
            // Turn rate scales with speed - can't turn faster than you're moving
            // At 5 mph: 25% turn rate, at 20+ mph: full turn rate
            // A heavy payload also makes steering slightly more sluggish.
            const speedTurnScale = Math.min(1, absSpeed / 20);
            const loadTurnScale = 0.82 + 0.18 * this.loadAccelFactor;
            const effectiveTurnSpeed = this.turnSpeed * speedTurnScale * loadTurnScale;
            
            // Scale pivot effect by speed - at low speeds, rotate more from center
            // At higher speeds, use full rear axle pivot for realistic steering
            const pivotBlend = Math.min(1, absSpeed / 15); // Full pivot at 15+ mph
            const effectivePivotOffset = this.rearAxleOffset * pivotBlend;
            
            // Calculate pivot point BEFORE rotation
            const pivotX = this.position.x + Math.sin(this.rotation) * effectivePivotOffset;
            const pivotZ = this.position.z + Math.cos(this.rotation) * effectivePivotOffset;
            
            let deltaRotation = 0;
            
            if (canDrift) {
                // DRIFTING - slight extra rotation, rear slides out a bit
                this.isDrifting = true;
                const driftTurnBoost = 1.3; // Slightly faster turn while drifting
                
                if (this.turnInput > 0.01) {
                    const inputScale = Math.min(1, Math.abs(this.turnInput));
                    deltaRotation = effectiveTurnSpeed * dt * turnFactor * driftTurnBoost * inputScale;
                    this.turnRate = effectiveTurnSpeed * turnFactor * driftTurnBoost * inputScale;
                    // Build up drift angle (subtle slide)
                    this.driftAngle = Math.min(0.15, this.driftAngle + dt * 0.8);
                }
                if (this.turnInput < -0.01) {
                    const inputScale = Math.min(1, Math.abs(this.turnInput));
                    deltaRotation = -effectiveTurnSpeed * dt * turnFactor * driftTurnBoost * inputScale;
                    this.turnRate = -effectiveTurnSpeed * turnFactor * driftTurnBoost * inputScale;
                    this.driftAngle = Math.max(-0.15, this.driftAngle - dt * 0.8);
                }
            } else {
                // Normal turning
                this.isDrifting = false;
                if (this.turnInput > 0.01) {
                    const inputScale = Math.min(1, Math.abs(this.turnInput));
                    deltaRotation = effectiveTurnSpeed * dt * turnFactor * inputScale;
                    this.turnRate = effectiveTurnSpeed * turnFactor * inputScale;
                }
                if (this.turnInput < -0.01) {
                    const inputScale = Math.min(1, Math.abs(this.turnInput));
                    deltaRotation = -effectiveTurnSpeed * dt * turnFactor * inputScale;
                    this.turnRate = -effectiveTurnSpeed * turnFactor * inputScale;
                }
            }
            
            // Apply rotation
            if (deltaRotation !== 0) {
                this.rotation += deltaRotation;
                
                // Pivot around the blended pivot point
                // At low speeds: pivot near center (no position shift)
                // At high speeds: pivot around rear axle (front swings out)
                this.position.x = pivotX - Math.sin(this.rotation) * effectivePivotOffset;
                this.position.z = pivotZ - Math.cos(this.rotation) * effectivePivotOffset;
            }
        } else {
            this.isDrifting = false;
        }

        // Prevent rotation that would intersect with nearby obstacles
        if (this.rotation !== prevRotation) {
            const collisionStart = perfEnabled ? performance.now() : 0;
            const rotationCollides = this.checkMeshCollision(this.position.x, this.position.z, this.rotation);
            if (perfEnabled) this._perfStats.collisionMs += performance.now() - collisionStart;
            if (rotationCollides) {
                // Restore both rotation AND position (since we pivot around rear axle)
                this.rotation = prevRotation;
                this.position.x = prevPosX;
                this.position.z = prevPosZ;
                this.turnRate = 0;
                this.driftAngle = 0;
            }
        }
        
        // Decay drift angle when not drifting
        if (!this.isDrifting) {
            this.driftAngle *= 0.9; // Gradually return to normal
            if (Math.abs(this.driftAngle) < 0.01) this.driftAngle = 0;
        }
        
        
        // Update front wheel steering visual
        this.updateWheelSteering(effectiveKeys);
        
        // Update tail lights based on braking/reversing
        this.updateTailLights(autoBraking, effectiveKeys);
        
        // Update engine sound based on speed and input
        if (this.audioManager) {
            const isAccelerating = effectiveKeys.w || effectiveKeys.s;
            const isBrakingForSound = effectiveKeys.space || autoBraking || 
                (effectiveKeys.w && this.speed > 0) || (effectiveKeys.s && this.speed < 0);
            this.audioManager.updateEngineSound(this.speed, this.maxSpeed, isAccelerating, isBrakingForSound);
        }
        
        // Calculate movement direction - during drift, movement is offset from facing
        const moveDirection = this.rotation + this.driftAngle;
        // Convert MPH to m/s for world/physics units.
        const speedMps = this.speed * 0.44704;
        const moveX = Math.sin(moveDirection) * speedMps * dt;
        const moveZ = Math.cos(moveDirection) * speedMps * dt;

        // Store truck world velocity for relative item stabilization (m/s)
        this._truckWorldVelX = dt > 0 ? (moveX / dt) : 0;
        this._truckWorldVelZ = dt > 0 ? (moveZ / dt) : 0;
        this._truckRotationRate = dt > 0 ? ((this.rotation - prevRotation) / dt) : 0;
        
        const newPosX = this.position.x + moveX;
        const newPosZ = this.position.z + moveZ;
        
        // Simple collision check using mesh intersection
        const collisionStart = perfEnabled ? performance.now() : 0;
        const wouldCollide = this.checkMeshCollision(newPosX, newPosZ);
        if (perfEnabled) this._perfStats.collisionMs += performance.now() - collisionStart;
        
        if (!wouldCollide) {
            // No collision - move normally
            this.position.x = newPosX;
            this.position.z = newPosZ;
        } else {
            // Collision - just stop. No sliding, no pushing, no jerking.
            this.speed *= 0.5; // Reduce speed on impact
        }
        
        // Suspension weight transfer: lean the body from the acceleration
        // forces computed above (needs currentAcceleration and turnRate)
        this.updateSuspension(dt);

        // Apply to all meshes
        this.applyTransform();
        
        // Enable CCD only when needed to prevent tunneling without heavy cost
        this.updateItemCcd();
        
        // Move loaded items with truck and apply physics forces
        if (this.enableItemPhysics) {
            const itemsStart = perfEnabled ? performance.now() : 0;
        this.updateLoadedItems(dt, moveX, moveZ, this.rotation - prevRotation);
            if (perfEnabled) this._perfStats.itemsMs += performance.now() - itemsStart;
        }
        
        // Update debug collision boxes if enabled
        this.updateCollisionDebug();

        // Perf logging (once per second)
        if (perfEnabled) {
            const perfEnd = performance.now();
            this._perfStats.frames += 1;
            this._perfStats.totalMs += (perfEnd - perfStart);
        }
        if (perfEnabled && nowMs - this._lastLogTime >= 1000) {
            this._perfStats.frames = 0;
            this._perfStats.totalMs = 0;
            this._perfStats.collisionMs = 0;
            this._perfStats.itemsMs = 0;
            this._lastLogTime = nowMs;
        }
    }

    setItemCcdEnabled(body, enabled) {
        if (!body) return false;
        if (body.setCcdEnabled) {
            body.setCcdEnabled(enabled);
            return true;
        }
        if (enabled && body.enableCCD) {
            body.enableCCD(true);
            return true;
        }
        return false;
    }

    updateItemCcd() {
        // Ensure CCD is enabled on all items and log wall penetrations.
        // NO velocity manipulation here - that's handled by updateLoadedItems and enforceItemBounds.
        
        if (!this.loadedItems || this.loadedItems.length === 0) return;
        
        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();
        this.root.computeWorldMatrix(true);
        const invMatrix = this.root.getWorldMatrix().clone();
        invMatrix.invert();
        
        // Wall positions (inner edge)
        const wallX = this.cargoWidth / 2;
        const wallFrontZ = -this.cargoLength / 2;
        
        // Wall collision logging (throttled)
        const nowMs = performance.now();
        const canLogWall = !this._lastWallLogMs || nowMs - this._lastWallLogMs > 300;
        
        for (let i = 0; i < this.loadedItems.length; i++) {
            const item = this.loadedItems[i];
            if (!item.mesh || !item.mesh.physicsAggregate || !item.mesh.physicsAggregate.body) continue;
            if (item.isFallen) continue;
            
            const body = item.mesh.physicsAggregate.body;
            
            // Ensure CCD stays enabled
            if (!item._ccdEnabled) {
                this.setItemCcdEnabled(body, true);
                item._ccdEnabled = true;
            }
            
            const worldVec = new BABYLON.Vector3(item.mesh.position.x, item.mesh.position.y, item.mesh.position.z);
            const localVec = BABYLON.Vector3.TransformCoordinates(worldVec, invMatrix);
            const localX = localVec.x;
            const localZ = localVec.z;
            
            // Item dimensions
            const halfX = item.size ? item.size.x / 2 : 0.3;
            const halfZ = item.size ? item.size.z / 2 : 0.3;
            
            // Check for wall penetration (item edge past wall)
            const leftPenetration = (-wallX) - (localX - halfX);   // positive = penetrating left wall
            const rightPenetration = (localX + halfX) - wallX;     // positive = penetrating right wall
            const frontPenetration = wallFrontZ - (localZ - halfZ); // positive = penetrating front wall
            
            // Diagnostic logging only for deep penetration; shallow contact is normal with thick walls.
            if (canLogWall && (leftPenetration > 0.6 || rightPenetration > 0.6 || frontPenetration > 0.6)) {
                const vel = body.getLinearVelocity ? body.getLinearVelocity() : null;
                const angVel = body.getAngularVelocity ? body.getAngularVelocity() : null;
                
                let wallName = '';
                if (leftPenetration > 0) wallName += `LEFT(${leftPenetration.toFixed(3)}) `;
                if (rightPenetration > 0) wallName += `RIGHT(${rightPenetration.toFixed(3)}) `;
                if (frontPenetration > 0) wallName += `FRONT(${frontPenetration.toFixed(3)}) `;
                
                console.warn(`🚧 WALL PENETRATION: ${item.id || item.mesh.name}`,
                    `walls: ${wallName}`,
                    `local(${localX.toFixed(2)}, ${localZ.toFixed(2)})`,
                    vel ? `vel(${vel.x.toFixed(2)},${vel.y.toFixed(2)},${vel.z.toFixed(2)})` : '',
                    angVel ? `ang(${angVel.x.toFixed(2)},${angVel.y.toFixed(2)},${angVel.z.toFixed(2)})` : '',
                    `truck: spd=${this.speed.toFixed(1)} turn=${this.turnRate.toFixed(2)}`
                );
                this._lastWallLogMs = nowMs;
            }
        }
    }

    applyAutoBrake(duration = 0.6) {
        this.autoBrakeTimer = Math.max(this.autoBrakeTimer, duration);
    }
    
    updateGear() {
        const prevGear = this.currentGear;
        const absSpeed = Math.abs(this.speed);
        
        // Determine direction
        if (this.speed > 0.5) {
            // Reversing (positive speed = backward)
            this.currentGear = -1;
        } else if (this.speed < -0.5) {
            // Moving forward (negative speed = forward)
            // Find appropriate gear based on speed
            let newGear = 1;
            for (let g = 1; g <= 5; g++) {
                // Use hysteresis: upshift at higher threshold, downshift at lower
                if (this.currentGear >= g) {
                    // Currently in this gear or higher - use downshift threshold
                    if (absSpeed >= this.gearDownSpeeds[g]) {
                        newGear = g;
                    }
                } else {
                    // Currently in lower gear - use upshift threshold
                    if (absSpeed >= this.gearSpeeds[g]) {
                        newGear = g;
                    }
                }
            }
            this.currentGear = newGear;
        } else {
            // Neutral (stopped or nearly stopped)
            this.currentGear = 0;
        }
        
        // Return whether gear changed (for audio feedback)
        this.gearJustChanged = prevGear !== this.currentGear && prevGear !== 0 && this.currentGear !== 0;
    }
    
    getGearDisplay() {
        if (this.currentGear === -1) return 'R';
        if (this.currentGear === 0) return 'N';
        return this.currentGear.toString();
    }

    updateWheelSteering(keys) {
        if (!this.frontWheelNodes || this.frontWheelNodes.length === 0) return;
        
        // Target steering angle based on input (max ~30 degrees)
        const maxSteerAngle = Math.PI / 6; // 30 degrees
        let targetAngle = 0;
        
        if (keys.a) targetAngle = -maxSteerAngle; // Turn left
        if (keys.d) targetAngle = maxSteerAngle;  // Turn right
        
        // Store current steering angle if not set
        if (this.currentSteerAngle === undefined) this.currentSteerAngle = 0;
        
        // Smoothly interpolate to target angle
        const steerSpeed = 0.15;
        this.currentSteerAngle += (targetAngle - this.currentSteerAngle) * steerSpeed;
        
        // Apply rotation to front wheel nodes (indexed loop avoids iterator creation)
        const angle = this.currentSteerAngle;
        for (let i = 0; i < this.frontWheelNodes.length; i++) {
            this.frontWheelNodes[i].rotation.y = angle;
        }
    }
    
    updateTailLights(autoBraking = false, keysOverride = null) {
        if (!this.tailLightMat) return;
        const keys = keysOverride || this.keys;
        const braking = autoBraking || keys.space || keys.s;
        
        // Cache target colors to avoid object creation every frame
        const targetEr = braking ? 1 : 0.3;
        const targetEg = braking ? 0.1 : 0.02;
        const targetEb = braking ? 0.1 : 0.02;
        const targetDr = braking ? 0.8 : 0.4;
        const targetDg = braking ? 0.1 : 0.04;
        const targetDb = braking ? 0.1 : 0.04;
        
        // Smooth 0.2s transition
        const dt = this.scene.getEngine().getDeltaTime() / 1000;
        const t = Math.min(1, dt / 0.05);
        
        // Mutate existing colors instead of creating new objects
        const em = this.tailLightMat.emissiveColor;
        const df = this.tailLightMat.diffuseColor;
        em.r += (targetEr - em.r) * t;
        em.g += (targetEg - em.g) * t;
        em.b += (targetEb - em.b) * t;
        df.r += (targetDr - df.r) * t;
        df.g += (targetDg - df.g) * t;
        df.b += (targetDb - df.b) * t;
    }
    
    addLoadedItem(item) {
        // Items are now PARENTED to truck.root in ItemManager.placeItem()
        // They move automatically with the truck - no physics or manual updates needed!

        // If item is parented, local coords are already set by ItemManager
        if (item.isParented) {
            console.log(`📦 TRUCK: Added parented item ${item.id} at local (${item.localX?.toFixed(2)}, ${item.localZ?.toFixed(2)})`);
            this.loadedItems.push(item);
            return;
        }

        // Legacy path for non-parented items (shouldn't happen anymore)
        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();
        this.root.computeWorldMatrix(true);

        const invMatrix = this.root.getWorldMatrix().clone();
        invMatrix.invert();
        const worldVec = new BABYLON.Vector3(item.mesh.position.x, item.mesh.position.y, item.mesh.position.z);
        const localVec = BABYLON.Vector3.TransformCoordinates(worldVec, invMatrix);
        item.localX = localVec.x;
        item.localZ = localVec.z;
        item.localY = localVec.y;

        const meshQuat = item.mesh.rotationQuaternion
            ? item.mesh.rotationQuaternion.clone()
            : BABYLON.Quaternion.RotationYawPitchRoll(
                item.mesh.rotation.y,
                item.mesh.rotation.x,
                item.mesh.rotation.z
            );
        const truckQuat = this.getTruckBodyQuaternion();
        const truckQuatInv = BABYLON.Quaternion.Inverse(truckQuat);
        item.localQuat = truckQuatInv.multiply(meshQuat);

        this.loadedItems.push(item);
    }

    restoreItemMotionType(item, body, nowMs) {
        if (!item || !body || !body.setMotionType) return;
        if (!item._restoreMotionAt || nowMs < item._restoreMotionAt) return;
        const restoreType = item._restoreMotionType ?? BABYLON.PhysicsMotionType.DYNAMIC;
        // CRITICAL: Zero velocities before restoring to prevent explosion
        if (body.setLinearVelocity) body.setLinearVelocity(BABYLON.Vector3.Zero());
        if (body.setAngularVelocity) body.setAngularVelocity(BABYLON.Vector3.Zero());
        if (body.setPrestepType && BABYLON.PhysicsPrestepType && restoreType === BABYLON.PhysicsMotionType.DYNAMIC) {
            body.setPrestepType(BABYLON.PhysicsPrestepType.DISABLED);
        }
        body.setMotionType(restoreType);
        item._restoreMotionAt = 0;
        item._restoreMotionType = null;
    }

    teleportItemBody(item, body, position, rotation, nowMs) {
        if (!body || !body.setMotionType || !body.getMotionType) return;
        const currentType = body.getMotionType();
        item._restoreMotionType = currentType;
        // Use ANIMATED to move the body explicitly while it settles.
        item._restoreMotionAt = nowMs + 150;
        body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
        if (body.setPrestepType && BABYLON.PhysicsPrestepType) {
            body.setPrestepType(BABYLON.PhysicsPrestepType.TELEPORT);
        }
        // Zero velocities immediately
        if (body.setLinearVelocity) body.setLinearVelocity(BABYLON.Vector3.Zero());
        if (body.setAngularVelocity) body.setAngularVelocity(BABYLON.Vector3.Zero());
        // Direct position update for animated bodies
        if (body.setTargetTransform) {
            body.setTargetTransform(position, rotation);
        }
    }

    getSettledItemPose(item, worldMatrix) {
        const localX = item.settleLocalX ?? item.localX ?? 0;
        const localY = item.settleLocalY ?? item.localY ?? item.mesh.position.y;
        const localZ = item.settleLocalZ ?? item.localZ ?? 0;
        const position = BABYLON.Vector3.TransformCoordinates(
            new BABYLON.Vector3(localX, localY, localZ),
            worldMatrix
        );

        const truckQuat = this.getTruckBodyQuaternion();
        const localQuat = item.localQuat
            ? item.localQuat
            : BABYLON.Quaternion.RotationYawPitchRoll(item.localRotation || 0, 0, 0);

        return {
            position,
            rotation: truckQuat.multiply(localQuat)
        };
    }

    getTruckPointVelocity(worldX, worldZ, truckVelX, truckVelZ, rotationRate) {
        const relX = worldX - this.position.x;
        const relZ = worldZ - this.position.z;

        return new BABYLON.Vector3(
            truckVelX + rotationRate * relZ,
            0,
            truckVelZ - rotationRate * relX
        );
    }

    applyCargoStaticFriction(item, body, localX, localY, localZ, halfX, halfY, halfZ, truckVelX, truckVelZ, rotationRate) {
        if (!item || !body || !body.getLinearVelocity || !body.setLinearVelocity) return false;

        const insideCargo =
            Math.abs(localX) <= this.cargoWidth / 2 + halfX &&
            localZ >= -this.cargoLength / 2 - halfZ &&
            localZ <= this.cargoLength / 2 + halfZ;
        const restingCenterY = this.floorTopY + halfY;
        const restingOnBed =
            localY >= restingCenterY - 0.18 &&
            localY <= restingCenterY + 0.26;

        item.mesh.computeWorldMatrix(true);
        const itemUp = BABYLON.Vector3.TransformNormal(BABYLON.Axis.Y, item.mesh.getWorldMatrix());
        itemUp.normalize();
        const uprightEnough = itemUp.y > 0.72;

        // Static friction should hold during normal driving, then break loose
        // under hard braking, sharp acceleration, or strong turning.
        const longitudinalAccel = Math.abs(this.currentAcceleration || 0) * 0.44704;
        const lateralAccel = Math.abs((this.speed || 0) * 0.44704 * rotationRate);
        const staticAccelLimit = 13.0;
        const staticTurnAccelLimit = 9.0;
        const canHold =
            insideCargo &&
            restingOnBed &&
            uprightEnough &&
            longitudinalAccel <= staticAccelLimit &&
            lateralAccel <= staticTurnAccelLimit;

        const bedVelocity = this.getTruckPointVelocity(
            item.mesh.position.x,
            item.mesh.position.z,
            truckVelX,
            truckVelZ,
            rotationRate
        );
        const vel = body.getLinearVelocity();
        if (!vel) return false;

        const slipSpeed = Math.sqrt(
            Math.pow(vel.x - bedVelocity.x, 2) +
            Math.pow(vel.z - bedVelocity.z, 2)
        );
        const maxStaticSlip = item._staticFrictionHeld ? Infinity : 1.1;

        if (canHold && slipSpeed <= maxStaticSlip) {
            if (!item._staticFrictionHeld) {
                item._staticFrictionLocalX = localX;
                item._staticFrictionLocalY = localY;
                item._staticFrictionLocalZ = localZ;

                const worldQuat = item.mesh.rotationQuaternion
                    ? item.mesh.rotationQuaternion.clone()
                    : BABYLON.Quaternion.RotationYawPitchRoll(
                        item.mesh.rotation.y,
                        item.mesh.rotation.x,
                        item.mesh.rotation.z
                    );
                const truckQuat = this.getTruckBodyQuaternion();
                const truckQuatInv = BABYLON.Quaternion.Inverse(truckQuat);
                item._staticFrictionLocalQuat = truckQuatInv.multiply(worldQuat);

                if (body.setMotionType) {
                    body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
                }
                if (body.setPrestepType && BABYLON.PhysicsPrestepType) {
                    body.setPrestepType(BABYLON.PhysicsPrestepType.TELEPORT);
                }
            }

            const targetLocal = new BABYLON.Vector3(
                item._staticFrictionLocalX ?? localX,
                item._staticFrictionLocalY ?? localY,
                item._staticFrictionLocalZ ?? localZ
            );
            const targetWorld = BABYLON.Vector3.TransformCoordinates(targetLocal, this.root.getWorldMatrix());
            const truckQuat = this.getTruckBodyQuaternion();
            const targetQuat = truckQuat.multiply(
                item._staticFrictionLocalQuat || item.localQuat || BABYLON.Quaternion.Identity()
            );

            item.mesh.position.copyFrom(targetWorld);
            if (!item.mesh.rotationQuaternion) {
                item.mesh.rotationQuaternion = targetQuat;
            } else {
                item.mesh.rotationQuaternion.copyFrom(targetQuat);
            }
            item.mesh.computeWorldMatrix(true);

            if (body.setTargetTransform) {
                body.setTargetTransform(targetWorld, targetQuat);
            }
            body.setLinearVelocity(bedVelocity);
            if (body.setAngularVelocity) body.setAngularVelocity(BABYLON.Vector3.Zero());
            if (body.setLinearDamping) body.setLinearDamping(item.baseLinearDamping || 1.0);
            if (body.setAngularDamping) body.setAngularDamping(Math.max(item.baseAngularDamping || 1.35, 1.5));
            item._staticFrictionHeld = true;
            return true;
        }

        if (item._staticFrictionHeld) {
            if (body.setPrestepType && BABYLON.PhysicsPrestepType) {
                body.setPrestepType(BABYLON.PhysicsPrestepType.DISABLED);
            }
            if (body.setMotionType) {
                body.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
            }
            body.setLinearVelocity(bedVelocity);
            if (body.setAngularVelocity) body.setAngularVelocity(BABYLON.Vector3.Zero());
        }

        item._staticFrictionHeld = false;
        item._staticFrictionLocalX = null;
        item._staticFrictionLocalY = null;
        item._staticFrictionLocalZ = null;
        item._staticFrictionLocalQuat = null;
        return false;
    }

    updateLoadedItems(dt, moveX, moveZ, rotationDelta) {
        // Items are physics bodies that collide with the truck's animated walls/floor.
        // Havok handles sliding, tipping, and impacts; the static-friction pass
        // below only keeps resting cargo coupled to the moving bed until normal
        // friction would break under hard acceleration, braking, or turning.

        // CRITICAL: Sync root transform with current position/rotation BEFORE computing matrix
        // (applyTransform happens AFTER this function, so root may be stale)
        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();

        // Use Babylon's matrices for coordinate transforms (guaranteed correct)
        this.root.computeWorldMatrix(true);
        const worldMatrix = this.root.getWorldMatrix();
        const invMatrix = worldMatrix.clone();
        invMatrix.invert();
        
        const itemsNowMs = performance.now();
        const maxSafeVelocity = 45; // Emergency guard only; normal cargo motion is handled by Havok.
        const maxSafeAngularVelocity = 35;

        const truckVelX = dt > 0 ? (moveX / dt) : 0;
        const truckVelZ = dt > 0 ? (moveZ / dt) : 0;
        const truckMotionSpeed = Math.sqrt(truckVelX * truckVelX + truckVelZ * truckVelZ);
        const rotationRate = dt > 0 ? rotationDelta / dt : 0;
        const truckIsActivelyMoving =
            truckMotionSpeed > 0.2 ||
            Math.abs(rotationRate) > 0.05 ||
            this.keys.w ||
            this.keys.s ||
            this.keys.a ||
            this.keys.d;
        
        let riskLines = [];
        const diagNowMs = performance.now();
        const logIntervalMs = 1200;
        const canLog = !this._itemDiagLastLog || diagNowMs - this._itemDiagLastLog > logIntervalMs;
        
        for (let i = 0; i < this.loadedItems.length; i++) {
            const item = this.loadedItems[i];
            if (!item.mesh) continue;

            // PARENTED ITEMS: Skip all physics processing - they move with truck automatically!
            if (item.isParented && item.mesh.parent === this.root) {
                continue; // Item is parented to truck.root, no updates needed
            }

            const body = item.mesh.physicsAggregate && item.mesh.physicsAggregate.body;

            // Restore items that were temporarily made animated for teleportation
            this.restoreItemMotionType(item, body, itemsNowMs);

            // Create physics for newly placed items after settling period
            if (!body && item.createPhysicsAt && itemsNowMs >= item.createPhysicsAt && item.mesh._pendingPhysics) {
                const params = item.mesh._pendingPhysics;

                // SAFETY: Ensure item is within bounds before creating physics
                // This prevents collision impulses from walls
                const itemLocalVec = BABYLON.Vector3.TransformCoordinates(
                    new BABYLON.Vector3(item.mesh.position.x, item.mesh.position.y, item.mesh.position.z),
                    invMatrix
                );
                const halfX = item.size ? item.size.x / 2 : 0.3;
                const halfZ = item.size ? item.size.z / 2 : 0.3;
                const availableHalfWidth = Math.max(0, this.cargoWidth / 2 - halfX);
                const availableHalfLength = Math.max(0, this.cargoLength / 2 - halfZ);
                const marginX = Math.min(0.08, availableHalfWidth * 0.5);
                const marginZ = Math.min(0.08, availableHalfLength * 0.5);

                const maxX = Math.max(0, this.cargoWidth / 2 - halfX - marginX);
                const minZ = Math.min(0, -this.cargoLength / 2 + halfZ + marginZ);
                const maxZ = Math.max(0, this.cargoLength / 2 - halfZ - marginZ);

                let needsAdjust = false;
                let safeLocalX = itemLocalVec.x;
                let safeLocalZ = itemLocalVec.z;

                if (maxX === 0) {
                    if (safeLocalX !== 0) {
                        safeLocalX = 0;
                        needsAdjust = true;
                    }
                } else {
                    if (safeLocalX < -maxX) { safeLocalX = -maxX; needsAdjust = true; }
                    if (safeLocalX > maxX) { safeLocalX = maxX; needsAdjust = true; }
                }
                if (safeLocalZ < minZ) { safeLocalZ = minZ; needsAdjust = true; }
                if (safeLocalZ > maxZ) { safeLocalZ = maxZ; needsAdjust = true; }

                if (needsAdjust) {
                    // Move item to safe position before creating physics
                    const safeWorldVec = BABYLON.Vector3.TransformCoordinates(
                        new BABYLON.Vector3(safeLocalX, itemLocalVec.y, safeLocalZ),
                        worldMatrix
                    );
                    item.mesh.position.x = safeWorldVec.x;
                    item.mesh.position.z = safeWorldVec.z;
                    item.localX = safeLocalX;
                    item.localZ = safeLocalZ;
                    console.log(`⚠️ ADJUSTED ${item.id} position before physics creation`);
                }

                console.log(`⚙️ CREATING PHYSICS for ${item.id}. LocalPos: (${safeLocalX.toFixed(2)}, ${safeLocalZ.toFixed(2)})`);

                // Create physics aggregate
                const aggregate = new BABYLON.PhysicsAggregate(
                    item.mesh,
                    BABYLON.PhysicsShapeType.BOX,
                    {
                        mass: params.mass,
                        restitution: params.restitution,
                        friction: params.friction
                    },
                    this.scene
                );
                item.mesh.physicsAggregate = aggregate;

                if (aggregate.shape && aggregate.shape.setMargin) {
                    aggregate.shape.setMargin(0.01);
                }

                if (aggregate.body) {
                    // Hold as ANIMATED until the item can be released cleanly.
                    aggregate.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
                    if (aggregate.body.setPrestepType && BABYLON.PhysicsPrestepType) {
                        aggregate.body.setPrestepType(BABYLON.PhysicsPrestepType.TELEPORT);
                    }

                    // Zero velocities
                    aggregate.body.setLinearVelocity(BABYLON.Vector3.Zero());
                    aggregate.body.setAngularVelocity(BABYLON.Vector3.Zero());

                    // Apply very high damping
                    aggregate.body.setLinearDamping(30.0);
                    aggregate.body.setAngularDamping(40.0);

                    // Set collision filters
                    if (aggregate.body.setCollisionFilterMembership) {
                        aggregate.body.setCollisionFilterMembership(1);
                        aggregate.body.setCollisionFilterCollideMask(1 | 2);
                    }
                }

                // Clear pending physics flag, set time to become DYNAMIC
                item.mesh._pendingPhysics = null;
                item.createPhysicsAt = 0;
                item.becomeDynamicAt = itemsNowMs + 200; // Brief animated settle period

                continue;
            }

            // Transition from animated placement hold to DYNAMIC after physics creation.
            // Preserve the intended local bed pose until this moment; reading the
            // animated body's lagging position can turn the settle phase into a launch.
            if (body && item.becomeDynamicAt) {
                const settleAgeMs = item.settleStartedAt ? itemsNowMs - item.settleStartedAt : Infinity;
                const movingReleaseReady = truckIsActivelyMoving && settleAgeMs >= 50;
                const timedReleaseReady = itemsNowMs >= item.becomeDynamicAt;

                if (!movingReleaseReady && !timedReleaseReady) {
                    // Let the settle block below keep driving the target transform.
                } else {
                    const pose = this.getSettledItemPose(item, worldMatrix);
                    item.mesh.position.copyFrom(pose.position);
                    if (!item.mesh.rotationQuaternion) {
                        item.mesh.rotationQuaternion = pose.rotation.clone();
                    } else {
                        item.mesh.rotationQuaternion.copyFrom(pose.rotation);
                    }
                    item.mesh.computeWorldMatrix(true);

                    if (body.setTargetTransform) {
                        body.setTargetTransform(pose.position, pose.rotation);
                    }
                    if (body.setPrestepType && BABYLON.PhysicsPrestepType) {
                        body.setPrestepType(BABYLON.PhysicsPrestepType.DISABLED);
                    }

                    const relX = pose.position.x - this.position.x;
                    const relZ = pose.position.z - this.position.z;
                    const releaseVelocity = new BABYLON.Vector3(
                        truckVelX + rotationRate * relZ,
                        0,
                        truckVelZ - rotationRate * relX
                    );

                    // Match the truck's current world velocity at release. This is
                    // the physical initial condition for cargo that was resting on
                    // the moving bed, and avoids a wall-slam impulse.
                    body.setLinearVelocity(releaseVelocity);
                    body.setAngularVelocity(BABYLON.Vector3.Zero());

                    // Transition to DYNAMIC
                    body.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);

                    // Re-apply after motion-type change; Havok may reset velocity.
                    body.setLinearVelocity(releaseVelocity);
                    body.setAngularVelocity(BABYLON.Vector3.Zero());

                    body.setLinearDamping(item.baseLinearDamping || 1.0);
                    body.setAngularDamping(item.baseAngularDamping || 1.35);

                    item.localX = item.settleLocalX ?? item.localX;
                    item.localY = item.settleLocalY ?? item.localY;
                    item.localZ = item.settleLocalZ ?? item.localZ;
                    item.settleLocalX = null;
                    item.settleLocalY = null;
                    item.settleLocalZ = null;
                    item.becomeDynamicAt = 0;
                    console.log(`✅ ${item.id} now DYNAMIC`);
                }
            }

            // Items without physics OR still animated need to move with the truck
            // to stay in their local cargo position
            const motionType = body && body.getMotionType ? body.getMotionType() : null;
            const isTemporarilyAnimated = body &&
                item._restoreMotionAt &&
                itemsNowMs < item._restoreMotionAt &&
                motionType === BABYLON.PhysicsMotionType.ANIMATED;

            if ((item.createPhysicsAt && item.createPhysicsAt > 0) ||
                (item.becomeDynamicAt && item.becomeDynamicAt > 0) ||
                isTemporarilyAnimated) {
                // Log to verify we're in settling mode
                if (!item._loggedSkip) {
                    console.log(`⏳ SETTLING ${item.id} - moving with truck`);
                    item._loggedSkip = true;
                }

                // Move item with truck by maintaining its local position
                // This prevents items from being left behind when truck moves during settling
                if (item.localX !== undefined && item.localZ !== undefined) {
                    // Use Babylon's matrix for local-to-world transformation
                    const targetLocalX = item.settleLocalX ?? item.localX;
                    const targetLocalY = item.settleLocalY ?? item.localY ?? item.mesh.position.y;
                    const targetLocalZ = item.settleLocalZ ?? item.localZ;
                    const localVec = new BABYLON.Vector3(targetLocalX, targetLocalY, targetLocalZ);
                    const worldVec = BABYLON.Vector3.TransformCoordinates(localVec, worldMatrix);
                    item.mesh.position.copyFrom(worldVec);

                    // Also update rotation using localQuat (stored in addLoadedItem)
                    if (item.localQuat) {
                        const truckQuat = this.getTruckBodyQuaternion();
                        const worldQuat = truckQuat.multiply(item.localQuat);
                        if (!item.mesh.rotationQuaternion) {
                            item.mesh.rotationQuaternion = worldQuat;
                        } else {
                            item.mesh.rotationQuaternion.copyFrom(worldQuat);
                        }
                    }
                    item.mesh.computeWorldMatrix(true);

                    // If body exists (kinematic phase), update its transform too
                    if (body) {
                        const quat = item.mesh.rotationQuaternion || BABYLON.Quaternion.Identity();
                        if (!this._settleTargetPos) {
                            this._settleTargetPos = new BABYLON.Vector3();
                        }
                        this._settleTargetPos.set(worldVec.x, worldVec.y, worldVec.z);
                        body.setTargetTransform(this._settleTargetPos, quat);
                    }
                }
                continue;
            }

            // Calculate local position using Babylon's inverse matrix
            const worldVec = new BABYLON.Vector3(item.mesh.position.x, item.mesh.position.y, item.mesh.position.z);
            const localVec = BABYLON.Vector3.TransformCoordinates(worldVec, invMatrix);
            const localX = localVec.x;
            const localZ = localVec.z;
            const localY = localVec.y;

            const halfX = item.size ? item.size.x / 2 : 0.3;
            const halfZ = item.size ? item.size.z / 2 : 0.3;
            const halfY = item.size ? item.size.y / 2 : 0.3;

            // Update local position tracking
            if (item.mesh.physicsAggregate) {
                item.localX = localX;
                item.localZ = localZ;
                item.localY = localY;
            }
            
            if (body && !item.isFallen) {
                if (item.wasPlacedAsleep && !item._wokeForTruckMotion && truckIsActivelyMoving) {
                    const wakeVelocity = this.getTruckPointVelocity(
                        item.mesh.position.x,
                        item.mesh.position.z,
                        truckVelX,
                        truckVelZ,
                        rotationRate
                    );

                    body.setLinearVelocity(wakeVelocity);
                    body.setAngularVelocity(BABYLON.Vector3.Zero());
                    item._wokeForTruckMotion = true;
                }

                const heldByStaticFriction = this.applyCargoStaticFriction(
                    item,
                    body,
                    localX,
                    localY,
                    localZ,
                    halfX,
                    halfY,
                    halfZ,
                    truckVelX,
                    truckVelZ,
                    rotationRate
                );

                if (body.getLinearVelocity && body.setLinearVelocity) {
                    const vel = body.getLinearVelocity();
                    if (vel) {
                        const overCargoFootprint =
                            Math.abs(localX) <= this.cargoWidth / 2 + halfX &&
                            localZ >= -this.cargoLength / 2 - halfZ &&
                            localZ <= this.cargoLength / 2 + halfZ;

                        if (overCargoFootprint) {
                            const maxUpVelocity = 0.35;
                            const cargoSoftCeilingY = this.floorTopY + this.cargoHeight + halfY;
                            const restingCenterY = this.floorTopY + halfY;
                            const nearBedSurface = localY <= restingCenterY + 0.22;
                            let guardedVel = null;

                            if (!heldByStaticFriction && nearBedSurface) {
                                const bedVelocity = this.getTruckPointVelocity(
                                    item.mesh.position.x,
                                    item.mesh.position.z,
                                    truckVelX,
                                    truckVelZ,
                                    rotationRate
                                );
                                const relX = vel.x - bedVelocity.x;
                                const relZ = vel.z - bedVelocity.z;
                                const slipSpeed = Math.sqrt(relX * relX + relZ * relZ);
                                if (slipSpeed > 0.05) {
                                    const slipRetention = Math.pow(0.5, Math.min(dt, 0.05) / 0.045);
                                    guardedVel = new BABYLON.Vector3(
                                        bedVelocity.x + relX * slipRetention,
                                        vel.y,
                                        bedVelocity.z + relZ * slipRetention
                                    );
                                }
                            }

                            if (nearBedSurface && vel.y > 0.05) {
                                guardedVel = new BABYLON.Vector3(
                                    guardedVel ? guardedVel.x : vel.x,
                                    Math.min(vel.y * 0.25, 0.14),
                                    guardedVel ? guardedVel.z : vel.z
                                );
                            } else if (vel.y > maxUpVelocity) {
                                guardedVel = new BABYLON.Vector3(
                                    guardedVel ? guardedVel.x : vel.x,
                                    maxUpVelocity,
                                    guardedVel ? guardedVel.z : vel.z
                                );
                            }

                            if (item.mesh.position.y > cargoSoftCeilingY) {
                                const downwardY = Math.min(guardedVel ? guardedVel.y : vel.y, -2.0);
                                guardedVel = new BABYLON.Vector3(
                                    guardedVel ? guardedVel.x : vel.x,
                                    downwardY,
                                    guardedVel ? guardedVel.z : vel.z
                                );
                            }

                            if (guardedVel) {
                                body.setLinearVelocity(guardedVel);
                                vel.x = guardedVel.x;
                                vel.y = guardedVel.y;
                                vel.z = guardedVel.z;
                            }
                        }

                        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
                        if (speed > maxSafeVelocity) {
                            const scale = maxSafeVelocity / speed;
                            body.setLinearVelocity(new BABYLON.Vector3(vel.x * scale, vel.y * scale, vel.z * scale));
                        }
                    }
                }
                if (body.getAngularVelocity && body.setAngularVelocity) {
                    const angVel = body.getAngularVelocity();
                    if (angVel) {
                        const angSpeed = Math.sqrt(angVel.x * angVel.x + angVel.y * angVel.y + angVel.z * angVel.z);
                        const airborne = item.mesh.position.y > this.floorTopY + halfY + 0.25;
                        const angularLimit = airborne ? 8 : maxSafeAngularVelocity;
                        if (angSpeed > angularLimit) {
                            const scale = angularLimit / angSpeed;
                            body.setAngularVelocity(new BABYLON.Vector3(
                                angVel.x * scale,
                                angVel.y * scale,
                                angVel.z * scale
                            ));
                        }
                    }
                }
            }
            
            // Check if item has fallen out of truck
            if (!item.isFallen) {
                const itemHalfX = item.size ? item.size.x / 2 : 0.25;
                const itemHalfZ = item.size ? item.size.z / 2 : 0.25;
                const maxX = this.cargoWidth / 2 + 1.0;
                const maxZ = this.cargoLength / 2 + 1.0;
                
                if (item.mesh.position.y < this.floorTopY - 0.5 ||
                    Math.abs(localX) > maxX + itemHalfX ||
                    localZ > maxZ + itemHalfZ) {
                    item.isFallen = true;
                }
            }
            
            // Diagnostic logging
            if (canLog && !item.isFallen) {
                const nearSide = Math.abs(localX) > (this.cargoWidth / 2 - 0.2);
                const nearBack = localZ > (this.cargoLength / 2 - 0.6);
                const nearFront = localZ < (-this.cargoLength / 2 + 0.3);
                if (nearSide || nearBack || nearFront) {
                    let velStr = 'vel n/a';
                    let angStr = 'ang n/a';
                    if (body && body.getLinearVelocity) {
                        const v = body.getLinearVelocity();
                        if (v) velStr = `vel ${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
                    }
                    if (body && body.getAngularVelocity) {
                        const w = body.getAngularVelocity();
                        if (w) angStr = `ang ${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}`;
                    }
                    const ccd = item._ccdEnabled ? 'ccd on' : 'ccd off';
                    riskLines.push(
                        `- ${item.id || item.mesh.name}: ` +
                        `loc ${localX.toFixed(2)},${localZ.toFixed(2)} ` +
                        `y ${item.mesh.position.y.toFixed(2)} ` +
                        `${velStr} ${angStr} ${ccd}` +
                        `${nearSide ? ' SIDE' : ''}${nearBack ? ' BACK' : ''}${nearFront ? ' FRONT' : ''}`
                    );
                }
            } else if (item.isFallen && !item._fallLogged && canLog) {
                riskLines.push(
                    `- ${item.id || item.mesh.name}: FELL OUT at ` +
                    `loc ${localX.toFixed(2)},${localZ.toFixed(2)} ` +
                    `y ${item.mesh.position.y.toFixed(2)}`
                );
                item._fallLogged = true;
            }
        }
        
        if (canLog && riskLines.length > 0) {
            const speedMph = Math.abs(this.speed);
            const header = [
                `[ItemDiag] t=${(diagNowMs / 1000).toFixed(1)}s`,
                `spd=${speedMph.toFixed(1)}mph`,
                `turn=${this.turnRate.toFixed(2)}`,
                `accel=${this.currentAcceleration.toFixed(1)}`,
                `items=${this.loadedItems.length}`
            ].join(' ');
            console.log(`${header}\n${riskLines.join('\n')}`);
            this._itemDiagLastLog = diagNowMs;
        }
    }

    enforceItemBounds() {
        // Runs after physics to track cargo in truck-local coordinates and catch
        // rare floor tunneling. Wall contact is left to Havok so cargo can roll,
        // slide, and tip naturally in physics mode.
        if (!this.loadedItems || this.loadedItems.length === 0) return;
        
        // Log once to verify this function is being called
        if (!this._enforceItemBoundsLogged) {
            this._enforceItemBoundsLogged = true;
            console.log('✅ enforceItemBounds is running (post-physics)');
        }

        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();
        this.root.computeWorldMatrix(true);
        const worldMatrix = this.root.getWorldMatrix();
        const invMatrix = worldMatrix.clone();
        invMatrix.invert();
        
        const floorCorrectionTolerance = 0.4;
        
        // Outer bounds - beyond this is definitely fallen
        const outerHalfX = this.cargoWidth / 2 + 1.0;
        const outerFrontZ = -this.cargoLength / 2 - 1.0;
        const outerBackZ = this.cargoLength / 2 + 2.0;
        const floorY = this.floorTopY - 0.5;
        const nowMs = performance.now();
        
        for (let i = 0; i < this.loadedItems.length; i++) {
            const item = this.loadedItems[i];
            if (!item.mesh || item.isFallen) continue;

            // Skip items that don't have physics yet or are in the placement
            // handoff. Their intended local pose is owned by updateLoadedItems
            // until they become dynamic.
            if ((item.createPhysicsAt && item.createPhysicsAt > 0) ||
                (item.becomeDynamicAt && item.becomeDynamicAt > 0)) {
                continue;
            }

            const body = item.mesh.physicsAggregate && item.mesh.physicsAggregate.body;
            this.restoreItemMotionType(item, body, nowMs);
            
            const halfX = item.size ? item.size.x / 2 : 0.3;
            const halfZ = item.size ? item.size.z / 2 : 0.3;
            const halfY = item.size ? item.size.y / 2 : 0.3;

            // Calculate local position (item center relative to truck center)
            let localX, localZ, localY;
            if (item.isParented && item.mesh.parent === this.root) {
                // Item is parented to truck.root - position IS local coordinates
                localX = item.mesh.position.x;
                localZ = item.mesh.position.z;
                localY = item.mesh.position.y;
            } else {
                const worldVec = new BABYLON.Vector3(item.mesh.position.x, item.mesh.position.y, item.mesh.position.z);
                const localVec = BABYLON.Vector3.TransformCoordinates(worldVec, invMatrix);
                localX = localVec.x;
                localZ = localVec.z;
                localY = localVec.y;
            }

            // Update stored position
            item.localX = localX;
            item.localZ = localZ;
            item.localY = localY;

            const overBedFootprint =
                Math.abs(localX) <= this.cargoWidth / 2 + halfX * 0.5 &&
                localZ >= -this.cargoLength / 2 - halfZ * 0.5 &&
                localZ <= this.cargoLength / 2 + halfZ * 0.5;
            const overCargoFootprint =
                Math.abs(localX) <= this.cargoWidth / 2 + halfX &&
                localZ >= -this.cargoLength / 2 - halfZ &&
                localZ <= this.cargoLength / 2 + halfZ;

            const itemBottomY = item.mesh.position.y - halfY;
            const floorPenetration = this.floorTopY - itemBottomY;

            if (!item.isParented && overBedFootprint && floorPenetration > floorCorrectionTolerance) {
                const correctedY = item.mesh.position.y + floorPenetration + 0.02;
                item.mesh.position.y = correctedY;
                item.localY = correctedY;

                if (body) {
                    const quat = item.mesh.rotationQuaternion || BABYLON.Quaternion.Identity();
                    this.teleportItemBody(
                        item,
                        body,
                        new BABYLON.Vector3(item.mesh.position.x, correctedY, item.mesh.position.z),
                        quat,
                        nowMs
                    );
                }

                console.warn(`⬇️ FLOOR BREACH: ${item.id || item.mesh.name}`,
                    `bottom=${itemBottomY.toFixed(2)} < floor=${this.floorTopY.toFixed(2)}`,
                    `moving y to ${correctedY.toFixed(2)}`
                );
            }

            if (body && overCargoFootprint && body.getLinearVelocity && body.setLinearVelocity) {
                const vel = body.getLinearVelocity();
                if (vel) {
                    const restingCenterY = this.floorTopY + halfY;
                    const nearBedSurface = localY <= restingCenterY + 0.22;
                    let guardedY = null;

                    if (nearBedSurface && vel.y > 0.05) {
                        guardedY = Math.min(vel.y * 0.25, 0.14);
                    } else if (vel.y > 0.35) {
                        guardedY = 0.35;
                    }

                    if (guardedY !== null) {
                        body.setLinearVelocity(new BABYLON.Vector3(vel.x, guardedY, vel.z));
                    }
                }
            }

            if (body && overCargoFootprint && body.getAngularVelocity && body.setAngularVelocity) {
                const angVel = body.getAngularVelocity();
                if (angVel) {
                    const angSpeed = Math.sqrt(angVel.x * angVel.x + angVel.y * angVel.y + angVel.z * angVel.z);
                    const angularLimit = 5.2;
                    if (angSpeed > angularLimit) {
                        const scale = angularLimit / angSpeed;
                        body.setAngularVelocity(new BABYLON.Vector3(
                            angVel.x * scale,
                            angVel.y * scale,
                            angVel.z * scale
                        ));
                    }
                }
            }

            if (item.isParented && item.mesh.parent === this.root) {
                const wayOutsideParented =
                    Math.abs(localX) > outerHalfX + halfX ||
                    localZ < outerFrontZ - halfZ ||
                    localZ > outerBackZ + halfZ;
                if (wayOutsideParented && !item.isFallen) {
                    console.warn(`🚨 PARENTED ITEM OUTSIDE BOUNDS: ${item.id || item.mesh.name}`);
                    item.isFallen = true;
                }
                continue;
            }
            
            // Mark as fallen if WAY outside bounds
            const wayOutside = 
                Math.abs(localX) > outerHalfX + halfX ||
                localZ < outerFrontZ - halfZ ||
                localZ > outerBackZ + halfZ ||
                item.mesh.position.y < floorY;
            
            if (wayOutside && !item.isFallen) {
                item.isFallen = true;
                console.error(`💀 ITEM FELL: ${item.id || item.mesh.name}`,
                    `local(${localX.toFixed(2)}, ${localZ.toFixed(2)})`,
                    `y=${item.mesh.position.y.toFixed(2)}`,
                    `limits: X±${outerHalfX.toFixed(1)}, Z[${outerFrontZ.toFixed(1)},${outerBackZ.toFixed(1)}]`
                );
            }
        }
    }
    
    // Legacy method kept for compatibility - no longer needed with pure Havok physics
    updateLoadedItemsLegacy(dt, moveX, moveZ, rotationDelta) {
        const isMoving = Math.abs(this.speed) > 0.01 || this.keys.w || this.keys.s || this.keys.a || this.keys.d;
        // IMPORTANT: Negate rotation for Babylon.js convention
        const cos = Math.cos(-this.rotation);
        const sin = Math.sin(-this.rotation);
        
        for (let i = 0; i < this.loadedItems.length; i++) {
            const item = this.loadedItems[i];
            if (!item.mesh || item.isFallen) continue;
            
            // Update local position from physics
            if (item.mesh.physicsAggregate) {
                const dx = item.mesh.position.x - this.position.x;
                const dz = item.mesh.position.z - this.position.z;
                item.localX = dx * cos + dz * sin;   // Correct world-to-local
                item.localZ = -dx * sin + dz * cos;  // Correct world-to-local
                item.localY = item.mesh.position.y;
                
                // Bounds checking - only intervene if item is WAY outside bounds (fallen out)
                const itemHalfX = item.size ? item.size.x / 2 : 0.25;
                const itemHalfZ = item.size ? item.size.z / 2 : 0.25;
                const maxX = this.cargoWidth / 2 + 0.5; // Allow some overhang
                const maxZ = this.cargoLength / 2 + 0.5;
                const minZ = -this.cargoLength / 2 - 0.5;
                
                // Only mark as fallen if completely outside
                if (Math.abs(item.localX) > maxX + itemHalfX || 
                    item.localZ > maxZ + itemHalfZ || 
                    item.localZ < minZ - itemHalfZ) {
                    item.isFallen = true;
                }
            }
        }
    }
    
    storeInitialPositions() {
        // Store initial local positions for physics meshes
        this.physicsMeshes.forEach(mesh => {
            mesh.initialLocalPos = mesh.position.clone();
        });
    }
    
    getPayloadWeight() {
        let total = 0;
        for (let i = 0; i < this.loadedItems.length; i++) {
            const item = this.loadedItems[i];
            if (!item.isFallen) total += item.weight || 0;
        }
        return total;
    }

    updateSuspension(dt) {
        // Weight transfer: nose dips under braking, tail squats under throttle,
        // and the body rolls away from the turn center. Heavier payloads lean
        // more. The lean is spring-damped so it eases in and settles smoothly.
        const sdt = Math.min(dt, 0.05);
        const loadLean = 1 + Math.min(1, this.payloadWeight / this.truckBaseMass) * 0.8;
        // currentAcceleration is in mph/s; braking from forward motion is positive
        const longAccel = (this.currentAcceleration || 0) * 0.44704;
        // Lateral (centripetal) acceleration along local +X is v * omega
        const latAccel = (this.speed || 0) * 0.44704 * (this.turnRate || 0);

        const targetPitch = Math.max(-this.suspensionMaxPitch, Math.min(this.suspensionMaxPitch,
            -this.suspensionPitchGain * loadLean * longAccel));
        const targetRoll = Math.max(-this.suspensionMaxRoll, Math.min(this.suspensionMaxRoll,
            this.suspensionRollGain * loadLean * latAccel));

        this.suspensionPitchVel += (this.suspensionStiffness * (targetPitch - this.suspensionPitch) - this.suspensionDamping * this.suspensionPitchVel) * sdt;
        this.suspensionPitch += this.suspensionPitchVel * sdt;
        this.suspensionRollVel += (this.suspensionStiffness * (targetRoll - this.suspensionRoll) - this.suspensionDamping * this.suspensionRollVel) * sdt;
        this.suspensionRoll += this.suspensionRollVel * sdt;
    }

    syncRootRotation() {
        // Root carries yaw plus the suspension lean. Every consumer of
        // bed-local coordinates goes through the root world matrix, so the
        // lean stays consistent between visuals, physics, and cargo math.
        this.root.rotation.y = this.rotation;
        this.root.rotation.x = this.suspensionPitch;
        this.root.rotation.z = this.suspensionRoll;
    }

    getTruckBodyQuaternion() {
        // Full body orientation (yaw + suspension lean) matching root.rotation
        // in Babylon's YXZ Euler order. Cargo pose math must use this instead
        // of a yaw-only quaternion so positions and orientations agree.
        return BABYLON.Quaternion.RotationYawPitchRoll(this.rotation, this.suspensionPitch, this.suspensionRoll);
    }

    applyTransform() {
        // Update the root node - all meshes are parented so they move together
        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();

        // Sync physics bodies with mesh positions (for kinematic/static bodies)
        this.syncPhysicsBodies();
        
        // Update cargo bounds
        this.updateCargoBounds();
    }
    
    applyRenderTransform() {
        // Apply interpolated transform for rendering only
        if (!this.renderPosition) return;
        this.root.position.x = this.renderPosition.x;
        this.root.position.z = this.renderPosition.z;
        this.root.rotation.y = this.renderRotation ?? this.rotation;
        this.root.rotation.x = this.suspensionPitch;
        this.root.rotation.z = this.suspensionRoll;
        this.updateCargoBounds();
    }

    applySimTransform() {
        // Restore simulation transform without syncing physics (avoids jitter)
        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();
    }
    
    syncPhysicsBodies() {
        // Update all truck physics bodies to follow the truck
        if (!this.truckPhysicsAggregates) return;
        if (!this.root) return;
        // Ensure the root's world matrix is up to date before transforming local offsets.
        this.root.computeWorldMatrix(true);
        const parentNode = this.physicsRoot || this.root;
        parentNode.computeWorldMatrix(true);
        
        // Cache rotation quaternion - use same rotation as visual truck,
        // including the suspension lean so the animated cargo bed tilts with
        // the body and cargo physically reacts to weight transfer.
        if (!this._physicsRotQuat) {
            this._physicsRotQuat = BABYLON.Quaternion.Identity();
        }
        BABYLON.Quaternion.RotationYawPitchRollToRef(this.rotation, this.suspensionPitch, this.suspensionRoll, this._physicsRotQuat);
        
        // Cache target position vector
        if (!this._physicsTargetPos) {
            this._physicsTargetPos = new BABYLON.Vector3();
        }
        
        // Periodic sync logging for debugging
        const nowMs = performance.now();
        if (!this._lastPhysicsSyncLog || nowMs - this._lastPhysicsSyncLog > 2000) {
            this._lastPhysicsSyncLog = nowMs;
            console.log(`🔧 Physics sync: truck=(${this.position.x.toFixed(2)}, ${this.position.z.toFixed(2)}) rot=${(this.rotation * 180 / Math.PI).toFixed(1)}° root.rot.y=${(this.root.rotation.y * 180 / Math.PI).toFixed(1)}° parent=${parentNode.name || 'root'}`);
        }
        
        for (let i = 0; i < this.truckPhysicsAggregates.length; i++) {
            const { mesh, aggregate } = this.truckPhysicsAggregates[i];
            if (!mesh || !aggregate || !aggregate.body) continue;
            
            // Get local position (stored BEFORE unparenting during creation)
            const localX = mesh._localPosX;
            const localZ = mesh._localPosZ;
            const localY = mesh._localPosY;
            
            // Safety check - local positions must be set during initPhysics
            if (localX === undefined || localY === undefined || localZ === undefined) {
                console.error(`❌ Missing local position for ${mesh.name}! Physics wall will not move correctly.`);
                continue;
            }
            
            // Transform local offsets through parent matrix to world space
            const localVec = new BABYLON.Vector3(localX, localY, localZ);
            const worldVec = BABYLON.Vector3.TransformCoordinates(localVec, parentNode.getWorldMatrix());

            // Update mesh position and rotation (unparented)
            mesh.position.set(worldVec.x, worldVec.y, worldVec.z);
            if (!mesh.rotationQuaternion) {
                mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
            }
            mesh.rotationQuaternion.copyFrom(this._physicsRotQuat);
            mesh.computeWorldMatrix(true);
            
            // IMPORTANT: For moving bodies, set the target transform on the physics body
            this._physicsTargetPos.set(worldVec.x, worldVec.y, worldVec.z);
            aggregate.body.setTargetTransform(this._physicsTargetPos, this._physicsRotQuat);
        }
    }
    
    initPhysics() {
        // Create physics floor and walls for truck cargo area
        if (!this.truckFloorMesh) {
            const wallHeight = this.cargoHeight + 1.5; // Extra height to prevent items flying over
            
            // EXTREMELY THICK walls - even at 10 m/s, item needs multiple frames to pass through
            // At 60fps, 10 m/s = 0.167m per frame. 2m walls = 12 frames minimum to pass through
            const sideWallThickness = 2.0;  // 2m thick side walls
            const frontWallThickness = 2.0; // 2m thick front wall
            const backWallThickness = 2.0;  // 2m thick rear wall
            const wallFloorOverlap = 0.15;
            
            // Floor extends the full bed length; rear containment is handled by the back wall.
            const backGap = 0.0;
            const floorDepth = this.cargoLength - backGap;
            this.physicsWallConfig = {
                wallHeight,
                sideWallThickness,
                frontWallThickness,
                backWallThickness,
                backGap,
                floorDepth,
                wallFloorOverlap
            };
            const wallCenterY = this.floorTopY - wallFloorOverlap + wallHeight / 2;
            const floorThickness = 0.5; // Match visual floor thickness for perfect overlap
            this.truckFloorMesh = BABYLON.MeshBuilder.CreateBox('truckPhysicsFloor', {
                width: this.cargoWidth + 0.2,  // Slightly wider than cargo for edge grip
                height: floorThickness,
                depth: floorDepth
            }, this.scene);
            // Center the floor; top surface aligns with visual cargo floor
            this.truckFloorMesh.position.set(0, this.floorTopY - floorThickness / 2, -backGap / 2);
            this.truckFloorMesh.isVisible = false;
            this.truckFloorMesh.isPickable = false;
            
            // === PHYSICS WALL CONFIGURATION ===
            // Side walls extend the full length and connect with front/back walls.
            
            // Left wall - extends full cargo length (front to back)
            // Inner edge at -cargoWidth/2, outer edge at -(cargoWidth/2 + thickness)
            this.truckLeftWallMesh = BABYLON.MeshBuilder.CreateBox('truckPhysicsLeftWall', {
                width: sideWallThickness,
                height: wallHeight,
                depth: this.cargoLength // Full length
            }, this.scene);
            this.truckLeftWallMesh.position.set(
                -this.cargoWidth / 2 - sideWallThickness / 2,  // Outside the cargo area
                wallCenterY,
                0  // Centered on truck
            );
            this.truckLeftWallMesh.isVisible = false;
            this.truckLeftWallMesh.isPickable = false;
            
            // Right wall - mirrors left wall
            this.truckRightWallMesh = BABYLON.MeshBuilder.CreateBox('truckPhysicsRightWall', {
                width: sideWallThickness,
                height: wallHeight,
                depth: this.cargoLength // Full length
            }, this.scene);
            this.truckRightWallMesh.position.set(
                this.cargoWidth / 2 + sideWallThickness / 2,  // Outside the cargo area
                wallCenterY,
                0  // Centered on truck
            );
            this.truckRightWallMesh.isVisible = false;
            this.truckRightWallMesh.isPickable = false;
            
            // Front wall (cab side) - wide enough to overlap with side walls
            // This ensures no gaps at corners
            const frontWallWidth = this.cargoWidth + sideWallThickness * 2; // Overlaps side walls
            this.truckFrontWallMesh = BABYLON.MeshBuilder.CreateBox('truckPhysicsFrontWall', {
                width: frontWallWidth,
                height: wallHeight,
                depth: frontWallThickness
            }, this.scene);
            // Position at front of cargo area (negative Z = toward cab)
            this.truckFrontWallMesh.position.set(
                0, 
                wallCenterY,
                -this.cargoLength / 2 - frontWallThickness / 2  // Front (cab side)
            );
            this.truckFrontWallMesh.isVisible = false;
            this.truckFrontWallMesh.isPickable = false;

            // Back wall (rear side) - keeps physics cargo in the bed after placement
            this.truckBackWallMesh = BABYLON.MeshBuilder.CreateBox('truckPhysicsBackWall', {
                width: frontWallWidth,
                height: wallHeight,
                depth: backWallThickness
            }, this.scene);
            this.truckBackWallMesh.position.set(
                0,
                wallCenterY,
                this.cargoLength / 2 + backWallThickness / 2
            );
            this.truckBackWallMesh.isVisible = false;
            this.truckBackWallMesh.isPickable = false;
            
            // Log wall configuration for debugging
            console.log('🚛 Truck physics walls initialized:');
            console.log(`   Cargo size: ${this.cargoWidth}m x ${this.cargoLength}m`);
            console.log(`   Wall thickness: side=${sideWallThickness}m, front=${frontWallThickness}m, back=${backWallThickness}m`);
            console.log(`   Left wall: localX=${this.truckLeftWallMesh.position.x.toFixed(2)} (inner edge at ${(-this.cargoWidth/2).toFixed(2)})`);
            console.log(`   Right wall: localX=${this.truckRightWallMesh.position.x.toFixed(2)} (inner edge at ${(this.cargoWidth/2).toFixed(2)})`);
            console.log(`   Front wall: localZ=${this.truckFrontWallMesh.position.z.toFixed(2)} (inner edge at ${(-this.cargoLength/2).toFixed(2)})`);
            console.log(`   Back wall: localZ=${this.truckBackWallMesh.position.z.toFixed(2)} (inner edge at ${(this.cargoLength/2).toFixed(2)})`);
            
            // Parent all to a physics root that follows the truck (needed for transforms)
            this.physicsRoot = new BABYLON.TransformNode('truckPhysicsRoot', this.scene);
            this.physicsRoot.parent = this.root; // Keep physics aligned with visual truck
            this.truckFloorMesh.parent = this.physicsRoot;
            this.truckLeftWallMesh.parent = this.physicsRoot;
            this.truckRightWallMesh.parent = this.physicsRoot;
            this.truckFrontWallMesh.parent = this.physicsRoot;
            this.truckBackWallMesh.parent = this.physicsRoot;
            
            // Create moving truck bodies. Contact friction now handles cargo
            // motion; cargo is not pinned or orientation-locked in physics mode.
            const physicsParts = [
                { mesh: this.truckFloorMesh, friction: 3.4, restitution: 0.0 },
                { mesh: this.truckLeftWallMesh, friction: 0.02, restitution: 0.0 },
                { mesh: this.truckRightWallMesh, friction: 0.02, restitution: 0.0 },
                { mesh: this.truckFrontWallMesh, friction: 0.02, restitution: 0.0 },
                { mesh: this.truckBackWallMesh, friction: 0.02, restitution: 0.0 }
            ];
            
            this.truckPhysicsAggregates = [];
            physicsParts.forEach(({ mesh, friction, restitution }) => {
                // CRITICAL: Ensure world transform matches current parented pose
                mesh.computeWorldMatrix(true);
                const worldPos = mesh.getAbsolutePosition();
                const worldRot = mesh.rotationQuaternion ? mesh.rotationQuaternion.clone() : BABYLON.Quaternion.RotationYawPitchRoll(mesh.rotation.y, mesh.rotation.x, mesh.rotation.z);

                // Store parented local offsets for later sync
                const localPos = mesh.position.clone();
                mesh._localPosX = localPos.x;
                mesh._localPosY = localPos.y;
                mesh._localPosZ = localPos.z;
                
                // Unparent temporarily for physics creation while preserving pose
                mesh.parent = null;
                mesh.position.copyFrom(worldPos);
                if (!mesh.rotationQuaternion) {
                    mesh.rotationQuaternion = worldRot.clone();
                } else {
                    mesh.rotationQuaternion.copyFrom(worldRot);
                }
                mesh.computeWorldMatrix(true);
            
                const aggregate = new BABYLON.PhysicsAggregate(
                    mesh, 
                    BABYLON.PhysicsShapeType.BOX,
                    { mass: 0, friction, restitution },
                    this.scene
                );
            
                // Use ANIMATED bodies so moving truck parts have proper Havok
                // velocity during contact with dynamic cargo.
                if (aggregate.body && aggregate.body.setMotionType) {
                    aggregate.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
                    if (aggregate.body.setPrestepType && BABYLON.PhysicsPrestepType) {
                        aggregate.body.setPrestepType(BABYLON.PhysicsPrestepType.ACTION);
                    }
                }
                
                if (aggregate.shape && aggregate.shape.setMargin) {
                    // The truck bodies are already thick; tiny margins avoid
                    // inflated edge contacts that can launch cargo.
                    const margin = 0.005;
                    aggregate.shape.setMargin(margin);
                }
                
                // Set collision filter - truck parts are in group 2
                if (aggregate.body && aggregate.body.setCollisionFilterMembership) {
                    // Use default group 1 and collide with everything to avoid filter mismatches
                    aggregate.body.setCollisionFilterMembership(1);
                }
                if (aggregate.body && aggregate.body.setCollisionFilterCollideMask) {
                    aggregate.body.setCollisionFilterCollideMask(~0 >>> 0);
                }
                
                // Enable CCD on moving walls - this helps when truck moves fast
                if (aggregate.body) {
                    if (aggregate.body.setCcdEnabled) {
                        aggregate.body.setCcdEnabled(true);
                    }
                    // Set a reasonable motion threshold for walls
                    if (aggregate.body.setCcdMotionThreshold) {
                        aggregate.body.setCcdMotionThreshold(0.15);
                    }
                    if (aggregate.body.setCcdSweptSphereRadius) {
                        aggregate.body.setCcdSweptSphereRadius(0.2);
                    }
                }
                
                this.truckPhysicsAggregates.push({ mesh, aggregate });
            });

            if (!this._physicsSyncObserver) {
                this._physicsSyncObserver = this.scene.onBeforePhysicsObservable.add(() => {
                    this.syncPhysicsBodies();
                });
            }
        }
    }
    
    updateCargoBounds() {
        // IMPORTANT: Negate rotation for Babylon.js convention
        const cos = Math.cos(-this.rotation);
        const sin = Math.sin(-this.rotation);
        const px = this.position.x;
        const pz = this.position.z;
        
        // Get corners of cargo area in local space
        const halfW = this.cargoWidth / 2 - 0.15;
        const halfL = this.cargoLength / 2 - 0.15;
        
        // Inline corner calculations to avoid object creation
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        
        // Corner 1: (-halfW, -halfL)
        let worldX = px + (-halfW) * cos - (-halfL) * sin;
        let worldZ = pz + (-halfW) * sin + (-halfL) * cos;
        if (worldX < minX) minX = worldX; if (worldX > maxX) maxX = worldX;
        if (worldZ < minZ) minZ = worldZ; if (worldZ > maxZ) maxZ = worldZ;
        
        // Corner 2: (halfW, -halfL)
        worldX = px + halfW * cos - (-halfL) * sin;
        worldZ = pz + halfW * sin + (-halfL) * cos;
        if (worldX < minX) minX = worldX; if (worldX > maxX) maxX = worldX;
        if (worldZ < minZ) minZ = worldZ; if (worldZ > maxZ) maxZ = worldZ;
        
        // Corner 3: (-halfW, halfL)
        worldX = px + (-halfW) * cos - halfL * sin;
        worldZ = pz + (-halfW) * sin + halfL * cos;
        if (worldX < minX) minX = worldX; if (worldX > maxX) maxX = worldX;
        if (worldZ < minZ) minZ = worldZ; if (worldZ > maxZ) maxZ = worldZ;
        
        // Corner 4: (halfW, halfL)
        worldX = px + halfW * cos - halfL * sin;
        worldZ = pz + halfW * sin + halfL * cos;
        if (worldX < minX) minX = worldX; if (worldX > maxX) maxX = worldX;
        if (worldZ < minZ) minZ = worldZ; if (worldZ > maxZ) maxZ = worldZ;
        
        this.cargoBounds = {
            minX, maxX,
            minY: this.floorTopY,
            maxY: this.cargoFloorHeight + this.cargoHeight - 0.1,
            minZ, maxZ
        };
    }
}
