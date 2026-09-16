/**
 * ItemManager - Handles spawning, managing, and tracking items
 */
class ItemManager {
    constructor(scene, sceneManager, truck, audioManager, game) {
        this.scene = scene;
        this.sceneManager = sceneManager;
        this.truck = truck;
        this.audioManager = audioManager;
        this.game = game; // Reference to main game for physics mode check
        
        this.itemDefinitions = [];
        this.placedItems = [];      // Items placed IN the truck
        this.groundItems = [];      // Items on the ground at pickup location
        this.selectedItemId = null;
        this.previewMesh = null;
        this.previewModelMeshes = null;
        this.heldGroundItem = null; // Reference to ground item being picked up
        this.heldItemLabelMesh = null;
        this.heldItemLabelTex = null;
        this.heldItemLabelMat = null;
        
        // Item colors by type
        this.colors = {
            box: new BABYLON.Color3(0.45, 0.30, 0.15), // Base cardboard brown
            chair: new BABYLON.Color3(0.4, 0.3, 0.25),
            couch: new BABYLON.Color3(0.35, 0.4, 0.5),
            table: new BABYLON.Color3(0.5, 0.4, 0.3),
            fridge: new BABYLON.Color3(0.85, 0.85, 0.85),
            washer: new BABYLON.Color3(0.9, 0.9, 0.9),
            dresser: new BABYLON.Color3(0.45, 0.35, 0.25),
            mattress: new BABYLON.Color3(0.95, 0.95, 0.9),
            lamp: new BABYLON.Color3(0.8, 0.75, 0.6)
        };
        
        this.modelCache = {};
        this.modelSizes = {};
        this.modelVolumes = {};
    }
    
    applyCcdSettings(body, boxSize) {
        if (!body) return;
        
        // Log available CCD methods (once)
        if (!ItemManager._ccdMethodsLogged) {
            ItemManager._ccdMethodsLogged = true;
            console.log('🔍 Checking Havok body CCD methods:',
                `setCcdMotionThreshold: ${typeof body.setCcdMotionThreshold}`,
                `setCcdSweptSphereRadius: ${typeof body.setCcdSweptSphereRadius}`,
                `setCcdEnabled: ${typeof body.setCcdEnabled}`,
                `enableCCD: ${typeof body.enableCCD}`
            );
            // List all available methods on body
            const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(body)).filter(m => typeof body[m] === 'function');
            console.log('🔍 Available body methods:', methods.slice(0, 30).join(', '));
        }
        
        // Enable CCD (Continuous Collision Detection) to prevent tunneling
        // CCD threshold should be SMALL but POSITIVE - this is the distance the body
        // must travel per step before CCD activates. Setting to 0 DISABLES CCD!
        const minDimension = Math.min(boxSize.x, boxSize.y, boxSize.z);
        const ccdThreshold = Math.min(0.1, minDimension * 0.25);
        
        if (body.setCcdMotionThreshold) {
            body.setCcdMotionThreshold(ccdThreshold);
        }
        
        // Swept sphere radius should be large enough to catch collisions
        if (body.setCcdSweptSphereRadius) {
            const minHalfExtent = minDimension * 0.5;
            const sweptRadius = Math.max(0.05, minHalfExtent * 0.8);
            body.setCcdSweptSphereRadius(sweptRadius);
            body._ccdSweptRadius = sweptRadius;
        }
        
        // Also enable CCD on the body itself if Havok supports it
        if (body.setCcdEnabled) {
            body.setCcdEnabled(true);
        } else if (body.enableCCD) {
            body.enableCCD(true);
        }
        
        body._ccdConfigured = true;
    }

    configurePlacedPhysicsBody(body, boxSize, worldPosition) {
        if (!body) return;
        // Havok derives the box inertia from its dimensions and mass. World-space
        // damping stays low so it cannot drag cargo backwards off a moving bed.
        body.setLinearDamping(0.03);
        body.setAngularDamping(0.12);
        body.setLinearVelocity(this.truck.getPointVelocity(worldPosition));
        body.setAngularVelocity(this.truck._truckAngularVelocity || BABYLON.Vector3.Zero());
        this.applyCcdSettings(body, boxSize);
    }

    _worldToTruckLocalXZ(worldX, worldZ) {
        // Use Babylon's matrix for accurate transformation
        // CRITICAL: Sync root transform with truck's current position/rotation first
        if (this.truck.root) {
            this.truck.root.position.x = this.truck.position.x;
            this.truck.root.position.z = this.truck.position.z;
            this.truck.root.rotation.y = this.truck.rotation;
            this.truck.root.computeWorldMatrix(true);
            const invMatrix = this.truck.root.getWorldMatrix().clone();
            invMatrix.invert();
            const worldVec = new BABYLON.Vector3(worldX, 0, worldZ);
            const localVec = BABYLON.Vector3.TransformCoordinates(worldVec, invMatrix);
            return { x: localVec.x, z: localVec.z };
        }
        // Fallback
        const dx = worldX - this.truck.position.x;
        const dz = worldZ - this.truck.position.z;
        return { x: dx, z: dz };
    }

    _truckLocalToWorldXZ(localX, localZ) {
        // Use Babylon's matrix for accurate transformation
        // CRITICAL: Sync root transform with truck's current position/rotation first
        if (this.truck.root) {
            this.truck.root.position.x = this.truck.position.x;
            this.truck.root.position.z = this.truck.position.z;
            this.truck.root.rotation.y = this.truck.rotation;
            this.truck.root.computeWorldMatrix(true);
            const localVec = new BABYLON.Vector3(localX, 0, localZ);
            const worldVec = BABYLON.Vector3.TransformCoordinates(localVec, this.truck.root.getWorldMatrix());
            return { x: worldVec.x, z: worldVec.z };
        }
        // Fallback
        return {
            x: this.truck.position.x + localX,
            z: this.truck.position.z + localZ
        };
    }

    _getHalfExtentsXZForRotation(boxSize, yawRel) {
        const cos = Math.abs(Math.cos(yawRel));
        const sin = Math.abs(Math.sin(yawRel));
        return {
            halfX: 0.5 * (boxSize.x * cos + boxSize.z * sin),
            halfZ: 0.5 * (boxSize.x * sin + boxSize.z * cos)
        };
    }

    _clampWorldPointToCargo(worldX, worldZ, boxSize, yawRel) {
        const local = this._worldToTruckLocalXZ(worldX, worldZ);
        const { halfX, halfZ } = this._getHalfExtentsXZForRotation(boxSize, yawRel);

        // Minimal margin - item edge can touch walls (no physics collisions with parented items)
        const safety = 0.02; // Just 2cm to prevent z-fighting

        const minX = -this.truck.cargoWidth / 2 + halfX + safety;
        const maxX = this.truck.cargoWidth / 2 - halfX - safety;
        const minZ = -this.truck.cargoLength / 2 + halfZ + safety;
        const maxZ = this.truck.cargoLength / 2 - halfZ - safety;

        const clampedX = Math.max(minX, Math.min(maxX, local.x));
        const clampedZ = Math.max(minZ, Math.min(maxZ, local.z));
        return this._truckLocalToWorldXZ(clampedX, clampedZ);
    }
    
    // Get color for item type (randomizes brown shades for boxes)
    getItemColor(itemType) {
        if (itemType === 'box') {
            // Randomize darker cardboard brown shades
            const variation = (Math.random() - 0.5) * 0.12;
            return new BABYLON.Color3(
                0.35 + variation,       // Darker base red
                0.22 + variation * 0.7, // Darker base green
                0.10 + variation * 0.4  // Darker base blue
            );
        }
        return this.colors[itemType] || new BABYLON.Color3(0.5, 0.5, 0.5);
    }

    async preloadModels() {
        // Preload chair model
        try {
            const result = await BABYLON.SceneLoader.ImportMeshAsync(
                '',
                'assets/models/',
                'dining_chair.glb',
                this.scene
            );
            const rootMesh = result.meshes[0];
            rootMesh.setEnabled(false);
            this.modelCache.chair = rootMesh;
            const chairSize = this.computeModelSize(rootMesh);
            if (chairSize) this.modelSizes.chair = chairSize;
            const chairVolume = this.computeModelVolume(rootMesh);
            if (chairVolume) this.modelVolumes.chair = chairVolume;
        } catch (e) {
            console.warn('Chair model failed to load, using box fallback.', e);
        }
        
        // Preload table model
        try {
            const result = await BABYLON.SceneLoader.ImportMeshAsync(
                '',
                'assets/models/',
                'dining_table.glb',
                this.scene
            );
            const rootMesh = result.meshes[0];
            rootMesh.setEnabled(false);
            this.modelCache.table = rootMesh;
            const tableSize = this.computeModelSize(rootMesh);
            if (tableSize) this.modelSizes.table = tableSize;
            const tableVolume = this.computeModelVolume(rootMesh);
            if (tableVolume) this.modelVolumes.table = tableVolume;
        } catch (e) {
            console.warn('Table model failed to load, using box fallback.', e);
        }

    }

    computeModelSize(modelRoot) {
        if (!modelRoot) return null;
        
        let meshes = modelRoot.getChildMeshes(false);
        if (meshes.length === 0 && modelRoot instanceof BABYLON.Mesh) {
            meshes = [modelRoot];
        }
        if (meshes.length === 0) return null;
        
        const prevPos = modelRoot.position.clone();
        const prevRot = modelRoot.rotation.clone();
        const prevScale = modelRoot.scaling.clone();
        
        modelRoot.position = BABYLON.Vector3.Zero();
        modelRoot.rotation = BABYLON.Vector3.Zero();
        modelRoot.scaling = BABYLON.Vector3.One();
        modelRoot.computeWorldMatrix(true);
        
        meshes.forEach(mesh => {
            mesh.computeWorldMatrix(true);
            if (mesh.refreshBoundingInfo) {
                mesh.refreshBoundingInfo(true);
            }
        });
        
        const bounds = BABYLON.Mesh.MinMax(meshes);
        const size = bounds.max.subtract(bounds.min);
        
        modelRoot.position = prevPos;
        modelRoot.rotation = prevRot;
        modelRoot.scaling = prevScale;
        modelRoot.computeWorldMatrix(true);
        
        return size;
    }

    computeModelVolume(modelRoot) {
        if (!modelRoot) return null;
        
        let meshes = modelRoot.getChildMeshes(false);
        if (meshes.length === 0 && modelRoot instanceof BABYLON.Mesh) {
            meshes = [modelRoot];
        }
        if (meshes.length === 0) return null;
        
        const prevPos = modelRoot.position.clone();
        const prevRot = modelRoot.rotation.clone();
        const prevScale = modelRoot.scaling.clone();
        
        modelRoot.position = BABYLON.Vector3.Zero();
        modelRoot.rotation = BABYLON.Vector3.Zero();
        modelRoot.scaling = BABYLON.Vector3.One();
        modelRoot.computeWorldMatrix(true);
        
        let total = 0;
        for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i];
            const positions = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            const indices = mesh.getIndices();
            if (!positions || !indices || indices.length < 3) continue;
            
            mesh.computeWorldMatrix(true);
            const wm = mesh.getWorldMatrix();
            
            for (let j = 0; j < indices.length; j += 3) {
                const i0 = indices[j] * 3;
                const i1 = indices[j + 1] * 3;
                const i2 = indices[j + 2] * 3;
                
                const p0 = BABYLON.Vector3.TransformCoordinates(
                    new BABYLON.Vector3(positions[i0], positions[i0 + 1], positions[i0 + 2]),
                    wm
                );
                const p1 = BABYLON.Vector3.TransformCoordinates(
                    new BABYLON.Vector3(positions[i1], positions[i1 + 1], positions[i1 + 2]),
                    wm
                );
                const p2 = BABYLON.Vector3.TransformCoordinates(
                    new BABYLON.Vector3(positions[i2], positions[i2 + 1], positions[i2 + 2]),
                    wm
                );
                
                total += BABYLON.Vector3.Dot(p0, BABYLON.Vector3.Cross(p1, p2)) / 6;
            }
        }
        
        modelRoot.position = prevPos;
        modelRoot.rotation = prevRot;
        modelRoot.scaling = prevScale;
        modelRoot.computeWorldMatrix(true);
        
        return Math.abs(total);
    }

    getModelConfig(itemDef) {
        const itemType = typeof itemDef === 'string' ? itemDef : itemDef.type;
        const itemName = typeof itemDef === 'string' ? '' : itemDef.name;
        return {
            'chair': { 
                model: this.modelCache.chair,
                rotationCorrection: null,
                useModelDimensions: false
            },
            'table': { 
                model: this.modelCache.table,
                rotationCorrection: null,
                useModelDimensions: true,
                fitToTemplate: true
            },
            'couch': {
                model: null,
                rotationCorrection: null,
                useModelDimensions: false
            }
        }[itemType] || null;
    }

    getItemBoxSize(itemDef) {
        const config = this.getModelConfig(itemDef);
        const sizeKey = itemDef.name === 'Loveseat' ? 'loveseat' : itemDef.type;
        const modelSize = config && config.useModelDimensions
            ? this.modelSizes[sizeKey]
            : null;
        if (modelSize) {
            const scale = config.fitToTemplate
                ? Math.min(
                    itemDef.size.x / modelSize.x,
                    itemDef.size.y / modelSize.y,
                    itemDef.size.z / modelSize.z
                )
                : 1;
            const boxScale = config.boxScale || 1;
            return {
                x: modelSize.x * scale * boxScale,
                y: modelSize.y * scale * boxScale,
                z: modelSize.z * scale * boxScale
            };
        }
        return itemDef.size;
    }

    getItemVolumeM3(itemDef) {
        if (itemDef.volumeOverrideM3) {
            return itemDef.volumeOverrideM3;
        }
        if (itemDef.volumeOverrideYd3) {
            return itemDef.volumeOverrideYd3 * 0.764555;
        }
        const config = this.getModelConfig(itemDef);
        const volumeKey = itemDef.name === 'Loveseat' ? 'loveseat' : itemDef.type;
        const modelVolume = config && config.useModelDimensions
            ? this.modelVolumes[volumeKey]
            : null;
        const modelSize = config && config.useModelDimensions
            ? this.modelSizes[volumeKey]
            : null;
        const fallbackVolume = itemDef.volumeM3 || (itemDef.size.x * itemDef.size.y * itemDef.size.z);
        if (modelVolume) {
            const scale = (config.fitToTemplate && modelSize)
                ? Math.min(
                    itemDef.size.x / modelSize.x,
                    itemDef.size.y / modelSize.y,
                    itemDef.size.z / modelSize.z
                )
                : 1;
            const scaledVolume = modelVolume * Math.pow(scale, 3);
            // If mesh volume is too small vs its bounds, treat as unreliable and fall back
            if (modelSize) {
                const boundsVolume = modelSize.x * modelSize.y * modelSize.z;
                const fillRatio = boundsVolume > 0 ? modelVolume / boundsVolume : 0;
                if (fillRatio < 0.05) {
                    return fallbackVolume;
                }
            }
            if (scaledVolume > 0.05) {
                return scaledVolume;
            }
        }
        return fallbackVolume;
    }

    attachModelToBox(box, itemDef, modelRoot, options = {}) {
        if (!modelRoot) return;
        
        // Clone the entire hierarchy - third param FALSE to include children
        const clone = modelRoot.clone(`${box.name}_model`, null, false);
        if (!clone) return;

        clone.setEnabled(true);
        
        // Get all child meshes
        let meshes = clone.getChildMeshes(false);
        if (meshes.length === 0 && clone instanceof BABYLON.Mesh) {
            meshes = [clone];
        }
        if (meshes.length === 0) return;
        
        // Enable all meshes
        meshes.forEach(mesh => {
            mesh.setEnabled(true);
            mesh.isVisible = true;
        });
        
        // Compute bounds with clone at origin (unparented, unscaled)
        clone.position = BABYLON.Vector3.Zero();
        clone.rotation = BABYLON.Vector3.Zero();
        clone.scaling = BABYLON.Vector3.One();
        clone.computeWorldMatrix(true);
        meshes.forEach(mesh => {
            mesh.computeWorldMatrix(true);
            if (mesh.refreshBoundingInfo) {
                mesh.refreshBoundingInfo(true);
            }
        });
        
        // Get bounding box of all meshes
        const bounds = BABYLON.Mesh.MinMax(meshes);
        const size = bounds.max.subtract(bounds.min);
        const center = bounds.min.add(bounds.max).scale(0.5);

        // Calculate uniform scale to fit item dimensions
        let uniform = 1;
        const targetSize = options.boxSize || itemDef.size;
        if (size.x > 0 && size.y > 0 && size.z > 0) {
            const scaleX = targetSize.x / size.x;
            const scaleY = targetSize.y / size.y;
            const scaleZ = targetSize.z / size.z;
            // Use min to ensure model fits within the box
            uniform = Math.min(scaleX, scaleY, scaleZ);
        }
        
        // Parent to box first
        clone.parent = box;
        clone.scaling = new BABYLON.Vector3(uniform, uniform, uniform);
        
        // Apply model-specific rotation correction if provided
        if (options.rotationCorrection) {
            clone.rotation = options.rotationCorrection.clone();
        } else {
            clone.rotation = BABYLON.Vector3.Zero();
        }
        
        // Offset so model's BOTTOM aligns with physics box's BOTTOM
        // This ensures legs touch the floor when the physics box rests on the floor
        const modelBottomY = bounds.min.y * uniform;
        const boxBottomY = -targetSize.y / 2;
        clone.position = new BABYLON.Vector3(
            -center.x * uniform,
            boxBottomY - modelBottomY,  // Align bottoms
            -center.z * uniform
        );

        // Hide the physics box visually
        box.isVisible = false;
        // Re-enable child meshes since isVisible=false hides children
        meshes.forEach(mesh => mesh.isVisible = true);
        
        // Clone materials if alpha is specified (for preview) to avoid affecting other instances
        if (options.alpha !== undefined) {
            meshes.forEach(mesh => {
                if (mesh.material) {
                    // Clone material so we don't modify shared material
                    const clonedMat = mesh.material.clone(`${mesh.material.name}_clone_${Date.now()}`);
                    clonedMat.alpha = options.alpha;
                    if (clonedMat.transparencyMode !== undefined) {
                        clonedMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
                    }
                    mesh.material = clonedMat;
                }
            });
        }
        
        return meshes;
    }
    
    // Helper to attach the appropriate model based on item type
    attachModelIfAvailable(mesh, itemDef, options = {}) {
        const config = this.getModelConfig(itemDef.type);
        if (config && config.model) {
            const mergedOptions = { ...options };
            if (config.rotationCorrection) {
                mergedOptions.rotationCorrection = config.rotationCorrection;
            }
            return this.attachModelToBox(mesh, itemDef, config.model, mergedOptions);
        }
        return null;
    }
    
    loadItems(items) {
        // Deep copy items and reset placed flag
        this.itemDefinitions = items.map(item => {
            const def = { ...item, placed: false };
            def.volumeM3 = this.getItemVolumeM3(def);
            return def;
        });
        this.placedItems = [];
        this.selectedItemId = null;
        this.heldGroundItem = null;
        this.clearPreview();
    }
    
    // Spawn items as physical objects on the ground at pickup location
    spawnItemsAtPickup(pickupX, pickupZ) {
        // Clear any existing ground items
        this.clearGroundItems();
        
        
        // Spawn each item definition as a physical object on the ground
        const itemCount = this.itemDefinitions.length;
        const spacing = 3; // 3m between items
        const itemsPerRow = Math.ceil(Math.sqrt(itemCount));
        
        this.itemDefinitions.forEach((itemDef, index) => {
            // Calculate grid position around pickup center
            const row = Math.floor(index / itemsPerRow);
            const col = index % itemsPerRow;
            const offsetX = (col - (itemsPerRow - 1) / 2) * spacing;
            const offsetZ = (row - (itemsPerRow - 1) / 2) * spacing;
            
            const x = pickupX + offsetX;
            const z = pickupZ + offsetZ;
            const boxSize = this.getItemBoxSize(itemDef);
            const y = boxSize.y / 2 + 0.1; // Sitting on ground
            
            // Create mesh
            const mesh = BABYLON.MeshBuilder.CreateBox(`ground_${itemDef.id}`, {
                width: boxSize.x,
                height: boxSize.y,
                depth: boxSize.z
            }, this.scene);
            
            const mat = new BABYLON.PBRMaterial(`ground_${itemDef.id}Mat`, this.scene);
            mat.albedoColor = this.getItemColor(itemDef.type);
            mat.metallic = 0.1;
            mat.roughness = 0.8;
            mesh.material = mat;
            
            mesh.position = new BABYLON.Vector3(x, y, z);
            mesh.receiveShadows = true;
            mesh.isPickable = true;
            this.sceneManager.addShadowCaster(mesh);

        // Attach 3D model if available
        this.attachModelIfAvailable(mesh, itemDef, { boxSize });
            
            // Store ground item reference
            this.groundItems.push({
                id: itemDef.id,
                mesh: mesh,
                itemDef: itemDef,
                originalPos: { x, y, z }
            });
        });
        
    }

    // Spawn extra test items without affecting required item tracking
    spawnExtraItemsAtPickup(pickupX, pickupZ, items, spacing = 4) {
        if (!items || items.length === 0) return;
        const itemsPerRow = Math.ceil(Math.sqrt(items.length));
        items.forEach((itemDef, index) => {
            const row = Math.floor(index / itemsPerRow);
            const col = index % itemsPerRow;
            const offsetX = (col - (itemsPerRow - 1) / 2) * spacing;
            const offsetZ = (row - (itemsPerRow - 1) / 2) * spacing;

            const x = pickupX + offsetX;
            const z = pickupZ + offsetZ;
            const boxSize = this.getItemBoxSize(itemDef);
            const y = boxSize.y / 2 + 0.1;

            const mesh = BABYLON.MeshBuilder.CreateBox(`ground_${itemDef.id}`, {
                width: boxSize.x,
                height: boxSize.y,
                depth: boxSize.z
            }, this.scene);

            const mat = new BABYLON.PBRMaterial(`ground_${itemDef.id}Mat`, this.scene);
            mat.albedoColor = this.getItemColor(itemDef.type);
            mat.metallic = 0.1;
            mat.roughness = 0.8;
            mesh.material = mat;

            mesh.position = new BABYLON.Vector3(x, y, z);
            mesh.receiveShadows = true;
            mesh.isPickable = true;
            this.sceneManager.addShadowCaster(mesh);
            
            this.attachModelIfAvailable(mesh, itemDef, { boxSize });

            this.groundItems.push({
                id: itemDef.id,
                mesh,
                itemDef,
                originalPos: { x, y, z }
            });
        });
    }
    
    // Check if a mesh is a ground item and return it (includes child meshes like 3D models)
    getGroundItem(mesh) {
        return this.groundItems.find(gi => {
            // Direct match
            if (gi.mesh === mesh) return true;
            // Check if it's a child of the ground item (like a 3D model)
            let parent = mesh.parent;
            while (parent) {
                if (gi.mesh === parent) return true;
                parent = parent.parent;
            }
            return false;
        });
    }
    
    // Pick up a ground item (start dragging)
    pickupGroundItem(groundItem) {
        if (!groundItem || this.heldGroundItem) return;
        
        this.heldGroundItem = groundItem;
        this.selectedItemId = groundItem.id;
        
        // Create preview from the ground item's definition
        this.createPreviewFromDef(groundItem.itemDef);
        
        // Hide the ground item mesh AND all children (including 3D model) while carrying
        groundItem.mesh.setEnabled(false);
        
        this.audioManager.playSound('pickup');
    }
    
    // Create preview from item definition (used when picking from ground)
    createPreviewFromDef(itemDef) {
        this.clearPreview();
        
        const boxSize = this.getItemBoxSize(itemDef);
        const mesh = BABYLON.MeshBuilder.CreateBox('preview', {
            width: boxSize.x,
            height: boxSize.y,
            depth: boxSize.z
        }, this.scene);
        
        const mat = new BABYLON.StandardMaterial('previewMat', this.scene);
        mat.diffuseColor = this.getItemColor(itemDef.type);
        mat.alpha = 0.6;
        mat.emissiveColor = new BABYLON.Color3(0, 0.15, 0);
        mesh.material = mat;
        
        mesh.isPickable = false;
        mesh.position.y = -100;
        
        this.previewMesh = mesh;
        this.previewItemDef = itemDef;
        this.previewModelMeshes = null;

        // Attach 3D model if available (with preview alpha)
        this.previewModelMeshes = this.attachModelIfAvailable(mesh, itemDef, { alpha: 0.6, boxSize });
    }
    
    // Cancel pickup and return item to ground
    cancelPickup() {
        if (this.heldGroundItem) {
            this.heldGroundItem.mesh.setEnabled(true);
            this.heldGroundItem = null;
        }
        this.selectedItemId = null;
        this.clearPreview();
    }
    
    selectItem(itemId) {
        // Check if already placed in placedItems
        const placed = this.placedItems.find(p => p.id === itemId);
        if (placed) {
            return;
        }
        
        // Also check if marked as placed in definitions
        const itemDef = this.itemDefinitions.find(d => d.id === itemId);
        if (!itemDef || itemDef.placed) {
            return;
        }
        
        this.selectedItemId = itemId;
        this.createPreview(itemId);
        this.audioManager.playSound('pickup');
    }
    
    createPreview(itemId) {
        this.clearPreview();
        
        const itemDef = this.itemDefinitions.find(i => i.id === itemId);
        if (!itemDef) return;
        
        const boxSize = this.getItemBoxSize(itemDef);
        const mesh = BABYLON.MeshBuilder.CreateBox('preview', {
            width: boxSize.x,
            height: boxSize.y,
            depth: boxSize.z
        }, this.scene);
        
        const mat = new BABYLON.StandardMaterial('previewMat', this.scene);
        mat.diffuseColor = this.getItemColor(itemDef.type);
        mat.alpha = 0.6;
        mat.emissiveColor = new BABYLON.Color3(0, 0.15, 0);
        mesh.material = mat;
        
        mesh.isPickable = false;
        mesh.position.y = -100; // Hide initially
        
        this.previewMesh = mesh;
        this.previewItemDef = itemDef;
        this.previewModelMeshes = null;

        // Attach 3D model if available (with preview alpha)
        this.previewModelMeshes = this.attachModelIfAvailable(mesh, itemDef, { alpha: 0.6, boxSize });
    }
    
    // Find the Y position for placing an item at x,z (accounting for stacking)
    findPlacementY(x, z, itemHeight) {
        const bounds = this.truck.getBounds();
        const floorTop = this.truck.getFloorTopY();

        // Check items in truck (includes fallen items with correct state)
        let highestSurfaceY = floorTop;
        const itemHalfW = 0.3; // Approximate half-width for overlap check

        // Convert input world coords to local for comparison with parented items
        const inputLocal = this._worldToTruckLocalXZ(x, z);

        // Use truck.loadedItems which has the actual fallen state and positions
        const itemsToCheck = this.truck.loadedItems || this.placedItems;

        for (const placed of itemsToCheck) {
            if (!placed.mesh) continue;

            // For parented items, position is already local; for non-parented, convert to local
            let px, pz;
            if (placed.isParented && placed.mesh.parent === this.truck.root) {
                px = placed.mesh.position.x;
                pz = placed.mesh.position.z;
            } else {
                const placedLocal = this._worldToTruckLocalXZ(placed.mesh.position.x, placed.mesh.position.z);
                px = placedLocal.x;
                pz = placedLocal.z;
            }
            
            // Check if placement point overlaps with this item's footprint
            let halfW, halfD, topY;
            
            // For parented items, Y is local (relative to truck floor origin)
            // Convert to world Y by adding truck root's world Y
            const yOffset = (placed.isParented && placed.mesh.parent === this.truck.root)
                ? this.truck.root.position.y
                : 0;

            if (placed.isFallen && placed.fallDirection) {
                // Fallen item - use rotated dimensions
                const origHalfH = placed.size ? placed.size.y / 2 : 0.25;
                const origHalfW = placed.size ? placed.size.x / 2 : 0.25;
                const origHalfD = placed.size ? placed.size.z / 2 : 0.25;

                if (Math.abs(placed.fallDirection.x) > Math.abs(placed.fallDirection.z)) {
                    // Fell sideways - height becomes width
                    halfW = origHalfH;
                    halfD = origHalfD;
                    topY = placed.mesh.position.y + yOffset + origHalfW;
                } else {
                    // Fell forward/back - height becomes depth
                    halfW = origHalfW;
                    halfD = origHalfH;
                    topY = placed.mesh.position.y + yOffset + origHalfD;
                }
            } else {
                // Standing item - use normal dimensions
                halfW = placed.size ? placed.size.x / 2 : 0.25;
                halfD = placed.size ? placed.size.z / 2 : 0.25;
                topY = placed.mesh.position.y + yOffset + (placed.size ? placed.size.y / 2 : 0.25);
            }
            
            // Check overlap using local coordinates
            if (Math.abs(inputLocal.x - px) < halfW + itemHalfW && Math.abs(inputLocal.z - pz) < halfD + itemHalfW) {
                if (topY > highestSurfaceY) {
                    highestSurfaceY = topY;
                }
            }
        }
        
        // Also do raycast for truck bed and any other meshes
        const rayStart = new BABYLON.Vector3(x, bounds.maxY + 1, z);
        const rayDir = new BABYLON.Vector3(0, -1, 0);
        const rayLength = bounds.maxY - floorTop + 2;
        
        const ray = new BABYLON.Ray(rayStart, rayDir, rayLength);
        
        const hits = this.scene.multiPickWithRay(ray, (mesh) => {
            if (mesh.name === 'truckBed') return true;
            return false;
        });
        
        if (hits && hits.length > 0) {
            hits.sort((a, b) => a.distance - b.distance);
            const topHit = hits[0];
            if (topHit.pickedPoint.y > highestSurfaceY) {
                highestSurfaceY = topHit.pickedPoint.y;
            }
        }
        
        // Item center should be at surface + half item height
        return highestSurfaceY + itemHeight / 2;
    }
    
    updatePreview(x, z, rotation) {
        if (!this.previewMesh || !this.previewItemDef) return;

        const boxSize = this.getItemBoxSize(this.previewItemDef);
        const clamped = this._clampWorldPointToCargo(x, z, boxSize, rotation);
        const y = this.findPlacementY(clamped.x, clamped.z, boxSize.y);

        this.previewMesh.position = new BABYLON.Vector3(clamped.x, y, clamped.z);
        // Add truck rotation so preview orients with truck
        this.previewMesh.rotation.y = rotation + this.truck.rotation;
        this.updateHeldItemLabel(boxSize.y);

        // Check validity and update color
        const isValid = this.isValidPlacement(this.previewMesh);
        this.previewMesh.material.emissiveColor = isValid
            ? new BABYLON.Color3(0, 0.15, 0)
            : new BABYLON.Color3(0.3, 0, 0);
        if (this.previewModelMeshes) {
            const glow = isValid ? new BABYLON.Color3(0, 0.15, 0) : new BABYLON.Color3(0.3, 0, 0);
            this.previewModelMeshes.forEach(mesh => {
                if (mesh.material && mesh.material.emissiveColor) {
                    mesh.material.emissiveColor = glow;
                }
            });
        }

        // Update debug visualization if enabled
        if (this.debugEnabled) {
            this.updateDebugVisualization();

            // Log placement coordinates for debugging
            const local = this._worldToTruckLocalXZ(clamped.x, clamped.z);
            console.log('🎯 Preview:',
                `Input world=(${x.toFixed(2)}, ${z.toFixed(2)})`,
                `Clamped world=(${clamped.x.toFixed(2)}, ${clamped.z.toFixed(2)})`,
                `Local=(${local.x.toFixed(2)}, ${local.z.toFixed(2)})`,
                `ItemRot=${(rotation * 180 / Math.PI).toFixed(1)}°`,
                `TruckRot=${(this.truck.rotation * 180 / Math.PI).toFixed(1)}°`,
                `Valid=${isValid}`
            );
        }

        return { x: clamped.x, y, z: clamped.z, isValid };
    }

    createHeldItemLabel(text, itemHeight) {
        // Tooltip disabled per UX request
        return;
    }

    updateHeldItemLabel(itemHeight) {
        return;
    }

    disposeHeldItemLabel() {
        if (this.heldItemLabelMesh) {
            this.heldItemLabelMesh.dispose();
            this.heldItemLabelMesh = null;
        }
        if (this.heldItemLabelMat) {
            this.heldItemLabelMat.dispose();
            this.heldItemLabelMat = null;
        }
        if (this.heldItemLabelTex) {
            this.heldItemLabelTex.dispose();
            this.heldItemLabelTex = null;
        }
    }
    
    clearPreview() {
        if (this.previewMesh) {
            this.previewMesh.dispose();
            this.previewMesh = null;
        }
        this.disposeHeldItemLabel();
        this.previewItemDef = null;
        this.previewModelMeshes = null;
    }
    
    placeItem(x, z, rotation) {
        if (!this.selectedItemId || !this.previewItemDef) return null;
        
        const itemDef = this.previewItemDef;
        const boxSize = this.getItemBoxSize(itemDef);
        const itemHeight = boxSize.y;
        
        // Use the preview's current position instead of recalculating
        // This ensures the item goes exactly where the preview showed
        let placeX = x;
        let placeY;
        let placeZ = z;
        let placeRotation = rotation; // Will be overridden by preview if available
        
        if (this.previewMesh) {
            placeX = this.previewMesh.position.x;
            placeY = this.previewMesh.position.y;
            placeZ = this.previewMesh.position.z;
            // Use preview's rotation directly - it's already in world space
            if (this.previewMesh.rotationQuaternion) {
                const euler = this.previewMesh.rotationQuaternion.toEulerAngles();
                placeRotation = euler.y; // Y is yaw
            } else if (this.previewMesh.rotation) {
                placeRotation = this.previewMesh.rotation.y;
            }
        } else {
            placeY = this.findPlacementY(x, z, itemHeight);
        }
        
        // Force sync truck physics bodies to current world position
        this.truck.syncPhysicsBodies();
        
        // Check if placement is valid (not too high)
        const bounds = this.truck.getBounds();
        if (placeY + itemHeight / 2 > bounds.maxY) {
            this.audioManager.playSound('error');
            return null; // Item would stick out of truck
        }
        
        // Create the actual item mesh
        const mesh = BABYLON.MeshBuilder.CreateBox(itemDef.id, {
            width: boxSize.x,
            height: boxSize.y,
            depth: boxSize.z
        }, this.scene);
        
        const mat = new BABYLON.PBRMaterial(`${itemDef.id}Mat`, this.scene);
        mat.albedoColor = this.getItemColor(itemDef.type);
        mat.metallic = 0.1;
        mat.roughness = 0.8;
        mesh.material = mat;

        const physicsEnabled = this.game && this.game.physicsEnabled;
        const physicsLift = physicsEnabled ? 0.005 : 0.02;

        // Convert world position to truck-local position
        const local = this._worldToTruckLocalXZ(placeX, placeZ);
        const localX = local.x;
        const localZ = local.z;
        const localY = placeY + physicsLift; // Small lift above floor
        const localRotation = placeRotation - this.truck.rotation;

        let placedItem;

        if (physicsEnabled) {
            // === PHYSICS MODE: Items use live Havok bodies immediately ===
            // Position in world space, don't parent to truck
            mesh.position = new BABYLON.Vector3(placeX, localY, placeZ);
            mesh.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(placeRotation, 0, 0);

            // Attach 3D model if available
            this.attachModelIfAvailable(mesh, itemDef, { boxSize });

            mesh.receiveShadows = true;
            mesh.isPickable = true;
            this.sceneManager.addShadowCaster(mesh);

            // Create the physics body right away so placement matches the preview
            const aggregate = new BABYLON.PhysicsAggregate(
                mesh,
                BABYLON.PhysicsShapeType.BOX,
                {
                    mass: Math.max(1, itemDef.weight || 10),
                    restitution: 0.0,
                    friction: itemDef.type === 'box' ? 0.65 : 0.8,
                    startAsleep: false
                },
                this.scene
            );
            mesh.physicsAggregate = aggregate;

            if (aggregate.shape && aggregate.shape.setMargin) {
                aggregate.shape.setMargin(0.01);
            }

            if (aggregate.body) {
                this.configurePlacedPhysicsBody(aggregate.body, boxSize, mesh.position);
            }

            console.log(`📦 PLACED ITEM ${itemDef.id} (PHYSICS): World=(${placeX.toFixed(2)}, ${placeY.toFixed(2)}, ${placeZ.toFixed(2)})`);

            // Track placed item with physics
            placedItem = {
                id: itemDef.id,
                mesh: mesh,
                size: boxSize,
                weight: itemDef.weight,
                volumeM3: itemDef.volumeM3,
                isPlaced: true,
                isFallen: false,
                isParented: false, // NOT parented - uses physics
                localX: localX,
                localY: localY,
                localZ: localZ,
                localRotation: localRotation
            };

        } else {
            // === PARENTED MODE: Items are children of truck.root ===
            // No physics needed - items move automatically with the truck
            mesh.parent = this.truck.root;
            mesh.position = new BABYLON.Vector3(localX, localY, localZ);
            mesh.rotationQuaternion = BABYLON.Quaternion.RotationYawPitchRoll(localRotation, 0, 0);

            // Attach 3D model if available
            this.attachModelIfAvailable(mesh, itemDef, { boxSize });

            mesh.receiveShadows = true;
            mesh.isPickable = true;
            this.sceneManager.addShadowCaster(mesh);

            console.log(`📦 PLACED ITEM ${itemDef.id} (PARENTED): Local=(${localX.toFixed(2)}, ${localY.toFixed(2)}, ${localZ.toFixed(2)})`);

            // Track placed item - NO PHYSICS needed while parented
            placedItem = {
                id: itemDef.id,
                mesh: mesh,
                size: boxSize,
                weight: itemDef.weight,
                volumeM3: itemDef.volumeM3,
                isPlaced: true,
                isFallen: false,
                isParented: true, // Flag indicating item is parented to truck
                localX: localX,
                localY: localY,
                localZ: localZ,
                localRotation: localRotation
            };
        }

        this.placedItems.push(placedItem);

        // Register with truck for tracking
        this.truck.addLoadedItem(placedItem);
        
        // Remove item from queue (mark as used)
        const defIndex = this.itemDefinitions.findIndex(d => d.id === itemDef.id && !d.placed);
        if (defIndex !== -1) {
            this.itemDefinitions[defIndex].placed = true;
        }
        
        // If this was a ground item, remove it
        if (this.heldGroundItem) {
            const groundIndex = this.groundItems.findIndex(gi => gi.id === this.heldGroundItem.id);
            if (groundIndex !== -1) {
                this.groundItems[groundIndex].mesh.dispose();
                this.groundItems.splice(groundIndex, 1);
            } else {
                console.warn(`Ground item ${this.heldGroundItem.id} not found in groundItems array!`);
            }
            this.heldGroundItem = null;
        } else {
            console.warn('placeItem called but heldGroundItem is null');
        }
        
        // Clear selection
        this.selectedItemId = null;
        this.clearPreview();
        
        this.audioManager.playSound('place');
        
        return placedItem;
    }
    
    isValidPlacement(mesh) {
        if (!mesh) return false;
        
        const bounds = this.truck.getBounds();
        const pos = mesh.position;
        const bb = mesh.getBoundingInfo().boundingBox;
        const halfH = bb.extendSize.y;
        
        // Only check height - allow risky edge placements (physics will decide if it falls)
        if (pos.y + halfH > bounds.maxY) return false;

        const boxSize = this.previewItemDef ? this.getItemBoxSize(this.previewItemDef) : bb.extendSize.scale(2);
        const yawRel = (mesh.rotationQuaternion ? mesh.rotationQuaternion.toEulerAngles().y : mesh.rotation.y) - this.truck.rotation;
        const { halfX, halfZ } = this._getHalfExtentsXZForRotation(boxSize, yawRel);
        const local = this._worldToTruckLocalXZ(pos.x, pos.z);

        // Minimal margin - item edge can touch walls (no physics collisions with parented items)
        const safety = 0.02; // Just 2cm to prevent z-fighting

        const minX = -this.truck.cargoWidth / 2 + halfX + safety;
        const maxX = this.truck.cargoWidth / 2 - halfX - safety;
        const minZ = -this.truck.cargoLength / 2 + halfZ + safety;
        const maxZ = this.truck.cargoLength / 2 - halfZ - safety;

        return local.x >= minX && local.x <= maxX && local.z >= minZ && local.z <= maxZ;
    }
    
    areAllItemsPlaced() {
        // Check that ALL items from definitions are placed
        const requiredDefs = this.itemDefinitions.filter(def => !def.optional && !def.isTest);
        const allRequiredPlaced = requiredDefs.every(def => def.placed);
        
        // Check that NO ground items remain (more reliable check)
        const groundItemCount = this.groundItems.filter(gi => !gi.itemDef.optional && !gi.itemDef.isTest).length;
        
        // Debug logging
        const placedCount = requiredDefs.filter(d => d.placed).length;
        
        // Both conditions must be true
        return allRequiredPlaced && groundItemCount === 0;
    }

    hasRequiredGroundItems() {
        return this.groundItems.some(gi => !gi.itemDef.optional && !gi.itemDef.isTest);
    }
    
    getRemainingItems() {
        return this.itemDefinitions.filter(def => 
            !this.placedItems.some(p => p.id === def.id)
        );
    }
    
    getStableItemCount() {
        return this.placedItems.filter(item => !item.isFallen).length;
    }
    
    clearGroundItems() {
        this.groundItems.forEach(gi => {
            if (gi.mesh) gi.mesh.dispose();
        });
        this.groundItems = [];
        this.heldGroundItem = null;
    }
    
    clearAll() {
        this.placedItems.forEach(item => {
            if (item.mesh) {
                if (item.mesh.physicsAggregate) item.mesh.physicsAggregate.dispose();
                item.mesh.dispose();
            }
        });
        this.placedItems = [];
        this.clearGroundItems();
        this.selectedItemId = null;
        this.clearPreview();
    }
    
    // Add arrow on top of box pointing "North" (+Z direction)
    addArrowToBox(boxMesh, size) {
        // Create arrow using a cone (arrowhead) and cylinder (shaft)
        const arrowLength = Math.min(size.x, size.z) * 0.6;
        const arrowRadius = arrowLength * 0.15;
        
        // Shaft (cylinder)
        const shaft = BABYLON.MeshBuilder.CreateCylinder('shaft', {
            height: arrowLength * 0.6,
            diameter: arrowRadius * 0.5
        }, this.scene);
        shaft.rotation.x = Math.PI / 2; // Point along Z axis
        shaft.position.z = -arrowLength * 0.15; // Center behind arrowhead
        shaft.position.y = size.y / 2 + 0.02; // On top of box
        
        // Arrowhead (cone)
        const head = BABYLON.MeshBuilder.CreateCylinder('head', {
            height: arrowLength * 0.4,
            diameterTop: 0,
            diameterBottom: arrowRadius
        }, this.scene);
        head.rotation.x = Math.PI / 2; // Point along Z axis
        head.position.z = arrowLength * 0.2; // In front
        head.position.y = size.y / 2 + 0.02; // On top of box
        
        // Red material for visibility
        const arrowMat = new BABYLON.StandardMaterial('arrowMat', this.scene);
        arrowMat.diffuseColor = new BABYLON.Color3(1, 0, 0);
        arrowMat.emissiveColor = new BABYLON.Color3(0.5, 0, 0);
        shaft.material = arrowMat;
        head.material = arrowMat;
        
        // Parent to box so they move together
        shaft.parent = boxMesh;
        head.parent = boxMesh;
    }

    // ========== DEBUG VISUALIZATION ==========
    // Uses PARENTING to truck.root - meshes automatically follow truck transforms
    // This is the same proven pattern used by all truck visual meshes (cab, cargo, wheels)

    enableDebugVisualization() {
        this.debugEnabled = true;
        this._createDebugMeshes();
        console.log('🔍 DEBUG: Placement area visualization ENABLED');
    }

    disableDebugVisualization() {
        this.debugEnabled = false;
        this.cleanupDebugMeshes();
        console.log('🔍 DEBUG: Placement area visualization DISABLED');
    }

    updateDebugVisualization() {
        // Position updates now happen automatically via render loop observer
        // This function exists for API compatibility
    }

    _createDebugMeshes() {
        const truck = this.truck;
        if (!truck || !truck.root) {
            console.error('🔍 DEBUG: Cannot create debug meshes - truck or truck.root not available');
            return;
        }

        // Clean up any existing debug meshes first
        this.cleanupDebugMeshes();

        const halfW = truck.cargoWidth / 2;
        const halfL = truck.cargoLength / 2;
        const floorY = truck.cargoFloorHeight + 0.05; // Slightly above cargo floor

        // === GREEN FLOOR PLANE ===
        this.debugFloorPlane = BABYLON.MeshBuilder.CreateGround('debugFloorPlane', {
            width: truck.cargoWidth,
            height: truck.cargoLength
        }, this.scene);

        const floorMat = new BABYLON.StandardMaterial('debugFloorMat', this.scene);
        floorMat.diffuseColor = new BABYLON.Color3(0, 1, 0);
        floorMat.emissiveColor = new BABYLON.Color3(0, 0.5, 0);
        floorMat.alpha = 0.5;
        floorMat.backFaceCulling = false;
        this.debugFloorPlane.material = floorMat;
        this.debugFloorPlane.isPickable = false;
        this.debugFloorPlane.parent = truck.root;
        this.debugFloorPlane.position.set(0, floorY, 0);

        // === YELLOW CORNER MARKERS (outer cargo bounds) ===
        this.debugCornerMarkers = [];
        const markerMat = new BABYLON.StandardMaterial('debugMarkerMat', this.scene);
        markerMat.emissiveColor = new BABYLON.Color3(1, 1, 0);

        for (let i = 0; i < 4; i++) {
            const marker = BABYLON.MeshBuilder.CreateSphere(`debugMarker_${i}`, { diameter: 0.2 }, this.scene);
            marker.material = markerMat;
            marker.isPickable = false;
            this.debugCornerMarkers.push(marker);
        }
        this.debugCornerMarkers[0].parent = truck.root;
        this.debugCornerMarkers[0].position.set(-halfW, floorY + 0.15, -halfL);
        this.debugCornerMarkers[1].parent = truck.root;
        this.debugCornerMarkers[1].position.set(halfW, floorY + 0.15, -halfL);
        this.debugCornerMarkers[2].parent = truck.root;
        this.debugCornerMarkers[2].position.set(halfW, floorY + 0.15, halfL);
        this.debugCornerMarkers[3].parent = truck.root;
        this.debugCornerMarkers[3].position.set(-halfW, floorY + 0.15, halfL);


        // === RED CENTER MARKER ===
        const centerMat = new BABYLON.StandardMaterial('debugCenterMat', this.scene);
        centerMat.emissiveColor = new BABYLON.Color3(1, 0, 0);
        this.debugTruckCenterMarker = BABYLON.MeshBuilder.CreateSphere('debugCenter', { diameter: 0.3 }, this.scene);
        this.debugTruckCenterMarker.material = centerMat;
        this.debugTruckCenterMarker.isPickable = false;
        this.debugTruckCenterMarker.parent = truck.root;
        this.debugTruckCenterMarker.position.set(0, floorY + 0.3, 0);

        // === BLUE FORWARD ARROW ===
        const arrowMat = new BABYLON.StandardMaterial('debugArrowMat', this.scene);
        arrowMat.emissiveColor = new BABYLON.Color3(0, 0.5, 1);
        this.debugForwardArrow = BABYLON.MeshBuilder.CreateBox('debugArrow', {
            width: 0.15,
            height: 0.15,
            depth: 2.5
        }, this.scene);
        this.debugForwardArrow.material = arrowMat;
        this.debugForwardArrow.isPickable = false;
        this.debugForwardArrow.parent = truck.root;
        this.debugForwardArrow.position.set(0, floorY + 0.3, -halfL - 0.5);

        console.log('🔍 DEBUG: Created debug meshes parented to truck root');
    }

    // Clean up all debug meshes
    cleanupDebugMeshes() {
        if (this.debugLines) {
            this.debugLines.forEach(line => line.dispose());
            this.debugLines = [];
        }
        if (this.debugAABBLines) {
            this.debugAABBLines.forEach(line => line.dispose());
            this.debugAABBLines = [];
        }
        if (this.debugFloorPlane) {
            this.debugFloorPlane.dispose();
            this.debugFloorPlane = null;
        }
        if (this.debugCornerMarkers) {
            this.debugCornerMarkers.forEach(m => m.dispose());
            this.debugCornerMarkers = [];
        }
        if (this.debugTruckCenterMarker) {
            this.debugTruckCenterMarker.dispose();
            this.debugTruckCenterMarker = null;
        }
        if (this.debugForwardArrow) {
            this.debugForwardArrow.dispose();
            this.debugForwardArrow = null;
        }
    }
}
