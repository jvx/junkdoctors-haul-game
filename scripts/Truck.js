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
        this.maxSpeed = 90; // Governed road speed in mph
        this.maxReverseSpeed = 12;
        this.brakeDeceleration = 40; // mph/s; responsive game controls, not a truck simulator
        this.rearAxleOffset = 1.8;
        this.wheelbase = 4.8;
        this.maxSteerAngle = 50 * Math.PI / 180;
        this.steeringResponse = 26; // 90% input within 0.1 seconds, including a physics tick
        this.maxTurnRate = 1.5; // rad/s; responsive arcade handling at road speed
        this.turnInput = 0;
        this.currentSteerAngle = 0;
        this.currentAcceleration = 0; // For physics effects on items
        this.turnRate = 0; // Current turn rate for physics effects
        this.autoBrakeTimer = 0; // Seconds remaining for automatic braking
        
        // Automatic transmission with responsive, gear-dependent acceleration.
        this.currentGear = 0; // 0 = Neutral, 1-5 = Forward gears, -1 = Reverse
        this.gearSpeeds = [0, 0, 10, 22, 35, 50];
        this.gearDownSpeeds = [0, 0, 8, 19, 31, 46];
        this.gearAcceleration = [12, 12, 10, 8, 6, 4]; // mph/s

        // Payload physics: cargo weight reduces acceleration and lengthens braking (F = ma)
        this.truckBaseMass = 3500; // kg, same units as cargo weights
        this.payloadWeight = 0;   // Sum of loaded (non-fallen) item weights
        this.loadAccelFactor = 1; // truckBaseMass / (truckBaseMass + payload)

        // Suspension weight transfer: spring-damped body lean (radians).
        // Applied to root.rotation.x/z and to the animated cargo bed physics
        // bodies, so cargo physically feels the bed tilt under braking/turning.
        this.suspensionPitch = 0;    // Negative rotation.x lowers the nose (-Z).
        this.suspensionRoll = 0;     // Negative rotation.z leans toward local +X.
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
        this.cargoLateralGrip = 540; // Per-second bed-relative grip during arcade turns
        this._cargoPhysicsStep = 0;
        this._cargoItemsByBody = new WeakMap();
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
    
    collisionPenetration(mesh, obstacle) {
        const a = mesh.getBoundingInfo().boundingBox;
        const b = obstacle.getBoundingInfo().boundingBox;
        let depth = Infinity;
        for (const direction of [a.directions[0], a.directions[2], b.directions[0], b.directions[2]]) {
            const axis = new BABYLON.Vector3(direction.x, 0, direction.z).normalize();
            const pa = a.vectorsWorld.map(p => BABYLON.Vector3.Dot(p, axis));
            const pb = b.vectorsWorld.map(p => BABYLON.Vector3.Dot(p, axis));
            depth = Math.min(depth, Math.max(...pa) - Math.min(...pb), Math.max(...pb) - Math.min(...pa));
        }
        return Math.max(0, depth);
    }

    blocksTruckMovement(mesh, obstacle) {
        if (!mesh.intersectsMesh(obstacle, true)) return false;
        const nextDepth = this.collisionPenetration(mesh, obstacle);
        const targetPosition = this.root.position.clone();
        const targetRotation = this.root.rotation.clone();
        let currentDepth = 0;
        try {
            // Only an existing overlap may be escaped. Check each obstacle and
            // truck part independently so recovery cannot enter another wall.
            this.root.position.x = this.position.x;
            this.root.position.z = this.position.z;
            this.root.rotation.set(0, this.rotation, 0);
            this.root.computeWorldMatrix(true);
            mesh.computeWorldMatrix(true);
            if (mesh.intersectsMesh(obstacle, true)) currentDepth = this.collisionPenetration(mesh, obstacle);
        } finally {
            this.root.position.copyFrom(targetPosition);
            this.root.rotation.copyFrom(targetRotation);
            this.root.computeWorldMatrix(true);
            for (const part of this.collisionMeshes) part.computeWorldMatrix(true);
        }
        return currentDepth <= 0 || nextDepth >= currentDepth - 0.000001;
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
            if (this._collisionCache.startX === this.position.x
                && this._collisionCache.startZ === this.position.z
                && this._collisionCache.startYaw === this.rotation) return this._collisionCache.result;
        }
        
        // Temporarily move the truck root to test position
        const oldX = this.root.position.x;
        const oldZ = this.root.position.z;
        const oldRotY = this.root.rotation.y;
        const oldPitch = this.root.rotation.x;
        const oldRoll = this.root.rotation.z;
        this.root.position.x = posX;
        this.root.position.z = posZ;
        // Building collisions use a level footprint. Suspension settling must
        // not expand a stopped truck into a wall and block its reverse motion.
        this.root.rotation.set(0, rotY, 0);
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
                        
                        house.computeWorldMatrix(true);
                        for (let t = 0; t < truckMeshes.length; t++) {
                            if (this.blocksTruckMovement(truckMeshes[t], house)) {
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
                    house.computeWorldMatrix(true);
                    for (let t = 0; t < truckMeshes.length; t++) {
                        if (this.blocksTruckMovement(truckMeshes[t], house)) {
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
                wall.computeWorldMatrix(true);
                for (let t = 0; t < truckMeshes.length; t++) {
                    if (this.blocksTruckMovement(truckMeshes[t], wall)) {
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
        this.root.rotation.set(oldPitch, oldRotY, oldRoll);
        this.root.computeWorldMatrix(true);
        for (const mesh of truckMeshes) mesh.computeWorldMatrix(true);
        
        this._collisionCache = { frameId, posX, posZ, rotY, startX: this.position.x,
            startZ: this.position.z, startYaw: this.rotation, result: collision };
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
        const dt = Math.min(deltaTime, 1 / 30);
        if (!(dt > 0)) return;
        this._cargoPhysicsStep++;
        const keys = options.inputEnabled === false
            ? { w: false, a: false, s: false, d: false, space: false }
            : this.keys;
        const autoBraking = this.autoBrakeTimer > 0;
        this.autoBrakeTimer = Math.max(0, this.autoBrakeTimer - dt);
        const prevX = this.position.x;
        const prevZ = this.position.z;
        const prevRotation = this.rotation;
        const previousBodyRotation = this.getTruckBodyQuaternion();
        this.prevSpeed = this.speed;

        // The HUD/transmission use mph; forces and geometry use meters/seconds.
        const mphToMps = 0.44704;
        this.payloadWeight = this.getPayloadWeight();
        this.loadAccelFactor = this.truckBaseMass / (this.truckBaseMass + this.payloadWeight);
        const speedMps = this.speed * mphToMps;
        const direction = Math.sign(speedMps);
        const braking = keys.space || autoBraking ||
            (keys.w && speedMps > 0) || (keys.s && speedMps < 0) ||
            (keys.w && keys.s);
        let nextSpeed = speedMps;
        if (braking) {
            const brake = this.brakeDeceleration * mphToMps * this.loadAccelFactor;
            nextSpeed = direction * Math.max(0, Math.abs(speedMps) - brake * dt);
        } else {
            // Rolling resistance plus aerodynamic drag, independent of frame rate.
            const resistance = 0.12 + 0.0008 * speedMps * speedMps;
            if (keys.w || keys.s) {
                const throttle = keys.w ? -1 : 1;
                const gearAccel = this.gearAcceleration[Math.max(0, this.currentGear)];
                const acceleration = gearAccel * mphToMps * this.loadAccelFactor;
                nextSpeed += throttle * Math.max(0, acceleration - resistance) * dt;
            } else {
                nextSpeed = direction * Math.max(0, Math.abs(speedMps) - resistance * dt);
            }
        }
        this.speed = Math.max(-this.maxSpeed, Math.min(this.maxReverseSpeed, nextSpeed / mphToMps)) || 0;
        this.currentAcceleration = (this.speed - this.prevSpeed) / dt;

        // In the left-handed follow camera, negative steering turns screen-left.
        const rawSteer = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
        this.turnInput += (rawSteer - this.turnInput) * (1 - Math.exp(-this.steeringResponse * dt));
        const travelSpeed = (this.speed + this.prevSpeed) * 0.5 * mphToMps;
        // Cap yaw speed, not lateral acceleration: road-speed turns should stay useful.
        const speedSteerLimit = Math.atan(this.maxTurnRate * this.wheelbase / Math.max(0.01, Math.abs(travelSpeed)));
        this.currentSteerAngle = this.turnInput * Math.min(this.maxSteerAngle, speedSteerLimit);
        this.turnRate = -travelSpeed * Math.tan(this.currentSteerAngle) / this.wheelbase;
        const deltaRotation = this.turnRate * dt;
        const midpointYaw = prevRotation + deltaRotation / 2;
        const pivotX = prevX + Math.sin(prevRotation) * this.rearAxleOffset;
        const pivotZ = prevZ + Math.cos(prevRotation) * this.rearAxleOffset;
        const nextYaw = prevRotation + deltaRotation;
        const nextX = pivotX + Math.sin(midpointYaw) * travelSpeed * dt - Math.sin(nextYaw) * this.rearAxleOffset;
        const nextZ = pivotZ + Math.cos(midpointYaw) * travelSpeed * dt - Math.cos(nextYaw) * this.rearAxleOffset;

        if (!this.checkMeshCollision(nextX, nextZ, nextYaw)) {
            this.position.x = nextX;
            this.position.z = nextZ;
            this.rotation = nextYaw;
        } else {
            // Use the actual stopped transform for cargo velocity on impact.
            this.speed = 0;
            this.turnRate = 0;
            this.currentAcceleration = (this.speed - this.prevSpeed) / dt;
        }
        this._truckWorldVelX = (this.position.x - prevX) / dt;
        this._truckWorldVelZ = (this.position.z - prevZ) / dt;
        this._truckRotationRate = (this.rotation - prevRotation) / dt;
        this.updateGear();
        this.isDrifting = false;
        this.driftAngle = 0;
        this.updateSuspension(dt);
        const rotationDelta = this.getTruckBodyQuaternion().multiply(BABYLON.Quaternion.Inverse(previousBodyRotation));
        // Include yaw, pitch, and roll in the initial velocity of newly loaded cargo.
        const angularDelta = rotationDelta;
        this._truckAngularVelocity = new BABYLON.Vector3(angularDelta.x, angularDelta.y, angularDelta.z).scale(2 / dt);

        this.applyTransform();
        this.updateCargoGrip(dt);
        this.updateWheelSteering(keys);
        this.updateTailLights(autoBraking, keys);
        if (this.audioManager) {
            this.audioManager.updateEngineSound(this.speed, this.maxSpeed, keys.w || keys.s, braking);
        }
        this.updateCollisionDebug();
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
        this.gearJustChanged = this.gearJustChanged ||
            (prevGear !== this.currentGear && prevGear !== 0 && this.currentGear !== 0);
    }
    
    getGearDisplay() {
        if (this.currentGear === -1) return 'R';
        if (this.currentGear === 0) return 'N';
        return this.currentGear.toString();
    }

    updateWheelSteering() {
        for (const node of this.frontWheelNodes || []) {
            node.rotation.y = this.currentSteerAngle;
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
        // If item is parented, local coords are already set by ItemManager
        if (item.isParented) {
            console.log(`📦 TRUCK: Added parented item ${item.id} at local (${item.localX?.toFixed(2)}, ${item.localZ?.toFixed(2)})`);
            this.loadedItems.push(item);
            return;
        }

        // Dynamic cargo keeps bed-local coordinates for placement and bounds.
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
        this.trackCargoSupport(item);
    }

    trackCargoSupport(item) {
        const body = item.mesh.physicsAggregate?.body;
        if (!body) return;
        this._cargoItemsByBody.set(body, item);
        body.setCollisionCallbackEnabled(true);
        body.setCollisionEndedCallbackEnabled(true);
        body.getCollisionObservable().add(event => {
            if (!event.point || !event.normal || Math.abs(event.normal.y) < 0.5) return;
            const other = event.collider === body ? event.collidedAgainst : event.collider;
            if (event.point.y >= item.mesh.position.y || other.transformNode.position.y >= item.mesh.position.y) return;
            if (other.transformNode !== this.truckFloorMesh && !this._cargoItemsByBody.has(other)) return;
            item._cargoSupport = { body: other };
        });
        body.getCollisionEndedObservable().add(event => {
            const other = event.collider === body ? event.collidedAgainst : event.collider;
            if (item._cargoSupport?.body === other) item._cargoSupport = null;
        });
    }

    isCargoSupported(item) {
        // Follow actual contact support through a stack, bounded to avoid cycles.
        for (let depth = 0; depth < this.loadedItems.length; depth++) {
            const support = item._cargoSupport;
            // Sleeping bodies stop emitting continued-contact events. Retain
            // support until separation instead of making their grip disappear.
            if (item.isFallen || !support || support.body.transformNode.isDisposed()) return false;
            if (support.body.transformNode === this.truckFloorMesh) return true;
            item = this._cargoItemsByBody.get(support.body);
            if (!item) return false;
        }
        return false;
    }

    updateCargoGrip(dt) {
        if (!this.enableItemPhysics) return;
        const right = new BABYLON.Vector3(Math.cos(this.rotation), 0, -Math.sin(this.rotation));
        for (const item of this.loadedItems) {
            if (item.isParented || !item.mesh?.physicsAggregate) continue;
            const supported = this.isCargoSupported(item);
            const onFloor = supported && item._cargoSupport.body.transformNode === this.truckFloorMesh;
            if (!onFloor) item.floorContactArea = 0;
            else if (item.floorContactArea === undefined || this._cargoPhysicsStep % 4 === 0) {
                item.floorContactArea = PhysicsSystem.floorContactArea(item, this);
            }
            const friction = PhysicsSystem.contactFriction(item.floorContactArea || 0);
            if (Math.abs(friction - (item._contactFriction || 0)) > 0.01) {
                const material = { friction, staticFriction: friction * 1.2, restitution: 0,
                    frictionCombine: BABYLON.PhysicsMaterialCombineMode.MINIMUM };
                for (const shape of item.mesh.collisionShapes) shape.material = material;
                item._contactFriction = friction;
            }
            if (!supported || !this.cargoLateralGrip || Math.abs(this._truckRotationRate) < 0.01) continue;
            const body = item.mesh.physicsAggregate.body;
            const velocity = body.getLinearVelocity();
            const center = PhysicsSystem.centerOfMass(item.mesh);
            const matrix = item.mesh.getWorldMatrix();
            const corners = item.mesh.collisionParts.flatMap(part => PhysicsSystem.partCorners(part));
            const point = corners.map(p => BABYLON.Vector3.TransformCoordinates(p, matrix))
                .reduce((lowest, corner) => corner.y < lowest.y ? corner : lowest);
            const contactVelocity = BABYLON.Vector3.Cross(body.getAngularVelocity(), point.subtract(center)).add(velocity);
            if (contactVelocity.y - this.getPointVelocity(point).y > 0.3) continue; // Separating contact, not tipping about it.
            const contactCoverage = onFloor ? Math.min(1, Math.sqrt(item.floorContactArea / 0.32)) : 0;
            // Broad floor contact tracks the end-step bed velocity, avoiding
            // accumulated turn drift. Feet/edges retain more slip; stacks keep
            // their existing response. This predicts velocity, not position.
            const contactLead = onFloor ? 0.7 + 0.3 * contactCoverage : 0.5;
            const relativeVelocity = this.getPointVelocity(center.add(velocity.scale(dt * contactLead))).subtract(velocity);
            const areaGrip = onFloor ? 0.65 + 0.35 * contactCoverage : 0.75;
            const response = 1 - Math.exp(-this.cargoLateralGrip * areaGrip * dt);
            // Extra lateral grip compensates for arcade yaw, not throttle/brake
            // motion. Apply a bounded impulse at the COM, never a pose/velocity lock.
            const deltaV = BABYLON.Vector3.Dot(relativeVelocity, right) * response;
            const impulse = Math.max(-80 * dt, Math.min(80 * dt, deltaV)) * body.getMassProperties().mass;
            body.applyImpulse(right.scale(impulse), center);
        }
    }

    getPointVelocity(worldPosition) {
        const offset = worldPosition.subtract(this.position);
        const angular = this._truckAngularVelocity || BABYLON.Vector3.Zero();
        return BABYLON.Vector3.Cross(angular, offset).add(
            new BABYLON.Vector3(this._truckWorldVelX || 0, 0, this._truckWorldVelZ || 0)
        );
    }

    enforceItemBounds() {
        if (!this.loadedItems.length) return;
        this.root.computeWorldMatrix(true);
        const inverse = BABYLON.Matrix.Invert(this.root.getWorldMatrix());
        for (const item of this.loadedItems) {
            if (!item.mesh || item.isFallen) continue;
            item.mesh.computeWorldMatrix(true);
            const center = BABYLON.Vector3.TransformCoordinates(item.mesh.getAbsolutePosition(), inverse);
            item.localX = center.x;
            item.localY = center.y;
            item.localZ = center.z;
            if (item.isParented) continue;

            // Project the actual rotated box into the tilted bed's coordinates.
            // A chair on its side is still cargo, not an item below the floor.
            const corners = item.mesh.getBoundingInfo().boundingBox.vectorsWorld.map(
                point => BABYLON.Vector3.TransformCoordinates(point, inverse)
            );
            const minX = Math.min(...corners.map(point => point.x));
            const maxX = Math.max(...corners.map(point => point.x));
            const minZ = Math.min(...corners.map(point => point.z));
            const maxZ = Math.max(...corners.map(point => point.z));
            const maxY = Math.max(...corners.map(point => point.y));
            item.isFallen = maxY < this.floorTopY - 0.3 ||
                minX > this.cargoWidth / 2 + 0.4 || maxX < -this.cargoWidth / 2 - 0.4 ||
                minZ > this.cargoLength / 2 + 0.4 || maxZ < -this.cargoLength / 2 - 0.4;
        }
    }

    resetMotion() {
        this.speed = 0;
        this.prevSpeed = 0;
        this.currentAcceleration = 0;
        this.currentGear = 0;
        this.gearJustChanged = false;
        this.autoBrakeTimer = 0;
        this.turnInput = 0;
        this.turnRate = 0;
        this.currentSteerAngle = 0;
        this.suspensionPitch = 0;
        this.suspensionRoll = 0;
        this.suspensionPitchVel = 0;
        this.suspensionRollVel = 0;
        this._truckWorldVelX = 0;
        this._truckWorldVelZ = 0;
        this._truckRotationRate = 0;
        this._truckAngularVelocity = BABYLON.Vector3.Zero();
        this._cargoPhysicsStep = 0;
        for (const item of this.loadedItems) {
            item._cargoSupport = null;
            item.floorContactArea = undefined;
        }
        this._collisionCache = null;
        this.resetDrivingKeys();
        this.applyTransform(true);
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

    applyTransform(teleport = false) {
        // Update the root node - all meshes are parented so they move together
        this.root.position.x = this.position.x;
        this.root.position.z = this.position.z;
        this.syncRootRotation();

        // Sync physics bodies with mesh positions (for kinematic/static bodies)
        this.syncPhysicsBodies(teleport);
        
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
    
    syncPhysicsBodies(teleport = false) {
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
            
            // ACTION derives contact velocity from the next fixed-step target.
            aggregate.body.setPrestepType(teleport
                ? BABYLON.PhysicsPrestepType.TELEPORT
                : BABYLON.PhysicsPrestepType.ACTION);
            if (teleport) {
                aggregate.body.setLinearVelocity(BABYLON.Vector3.Zero());
                aggregate.body.setAngularVelocity(BABYLON.Vector3.Zero());
                this.scene.getPhysicsEngine().getPhysicsPlugin().setPhysicsBodyTransformation(aggregate.body, mesh);
            }
        }
    }
    
    initPhysics() {
        // Create physics floor and walls for truck cargo area
        if (!this.truckFloorMesh) {
            const wallHeight = this.cargoHeight - 0.1; // Match the visible bed walls
            
            // Fixed substeps allow narrow colliders without invisible ledges
            // extending meters beyond the truck.
            const sideWallThickness = 0.2;
            const frontWallThickness = 0.2;
            const backWallThickness = 0.2;
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
                { mesh: this.truckFloorMesh, friction: 3.2, restitution: 0.0 },
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

                if (mesh === this.truckFloorMesh) {
                    // Let each item's actual contact area determine bed grip.
                    aggregate.shape.material = {
                        ...aggregate.shape.material,
                        staticFriction: 3.84,
                        frictionCombine: BABYLON.PhysicsMaterialCombineMode.MINIMUM
                    };
                }
            
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
