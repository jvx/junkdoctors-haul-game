/**
 * PhysicsSystem - Manages physics simulation and stability checks
 */
class PhysicsSystem {
    constructor(scene) {
        this.scene = scene;
        this.onItemFallOut = null; // Callback when item falls out of truck
    }
    
    setFallOutCallback(callback) {
        this.onItemFallOut = callback;
    }

    static modelCollisionParts(root, meshes) {
        const inverse = BABYLON.Matrix.Invert(root.computeWorldMatrix(true));
        const parts = [];
        for (const mesh of meshes) {
            const vertices = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            const indices = mesh.getIndices();
            if (!vertices || !indices) continue;
            const matrix = mesh.computeWorldMatrix(true).multiply(inverse);
            const points = [], parents = [], welded = new Map();
            const find = i => parents[i] === i ? i : (parents[i] = find(parents[i]));
            // Imported furniture contains disconnected wooden pieces in each mesh.
            // Weld face-split vertices, then group connected triangles, not the
            // entire chair/table envelope (which would fill the gaps between legs).
            for (let i = 0; i < vertices.length / 3; i++) {
                const point = BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.FromArray(vertices, i * 3), matrix);
                points.push(point);
                const key = point.asArray().map(v => Math.round(v * 100000)).join(',');
                parents[i] = welded.has(key) ? welded.get(key) : i;
                welded.set(key, parents[i]);
            }
            for (let i = 0; i < indices.length; i += 3) {
                parents[find(indices[i + 1])] = find(indices[i]);
                parents[find(indices[i + 2])] = find(indices[i]);
            }
            const groups = new Map();
            points.forEach((point, i) => {
                const key = find(i);
                if (!groups.has(key)) groups.set(key, { min: point.clone(), max: point.clone() });
                const bounds = groups.get(key);
                bounds.min.minimizeInPlace(point);
                bounds.max.maximizeInPlace(point);
            });
            for (const part of groups.values()) {
                if (Math.min(...part.max.subtract(part.min).asArray()) > 0.001) parts.push(part);
            }
        }
        return parts;
    }

    static partCorners(part) {
        return part.corners ||= [0, 1, 2, 3, 4, 5, 6, 7].map(i => new BABYLON.Vector3(
            i & 1 ? part.max.x : part.min.x,
            i & 2 ? part.max.y : part.min.y,
            i & 4 ? part.max.z : part.min.z
        ));
    }

    static floorContactArea(item, truck) {
        const parts = item.mesh.collisionParts;
        if (!parts) return 0;
        const matrix = item.mesh.computeWorldMatrix(true).multiply(BABYLON.Matrix.Invert(truck.root.computeWorldMatrix(true)));
        const faces = [
            [0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4],
            [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]
        ];
        const normals = [BABYLON.Axis.X.scale(-1), BABYLON.Axis.X, BABYLON.Axis.Y.scale(-1),
            BABYLON.Axis.Y, BABYLON.Axis.Z.scale(-1), BABYLON.Axis.Z]
            .map(normal => BABYLON.Vector3.TransformNormal(normal, matrix).y);
        const clip = (polygon, axis, limit, sign) => {
            const output = [];
            for (let i = 0; i < polygon.length; i++) {
                const a = polygon[i], b = polygon[(i + 1) % polygon.length];
                const da = (a[axis] - limit) * sign, db = (b[axis] - limit) * sign;
                if (da <= 0) output.push(a);
                if ((da <= 0) !== (db <= 0)) output.push(BABYLON.Vector3.Lerp(a, b, da / (da - db)));
            }
            return output;
        };
        let area = 0;
        for (const part of parts) {
            const corners = PhysicsSystem.partCorners(part).map(p => BABYLON.Vector3.TransformCoordinates(p, matrix));
            for (let face = 0; face < faces.length; face++) {
                if (normals[face] > -0.25) continue;
                let polygon = faces[face].map(i => corners[i]);
                // A narrow contact band accounts for the solver's collision margin.
                polygon = clip(polygon, 'y', truck.floorTopY + 0.012, 1);
                polygon = clip(polygon, 'y', truck.floorTopY - 0.025, -1);
                polygon = clip(polygon, 'x', truck.cargoWidth / 2, 1);
                polygon = clip(polygon, 'x', -truck.cargoWidth / 2, -1);
                polygon = clip(polygon, 'z', truck.cargoLength / 2, 1);
                polygon = clip(polygon, 'z', -truck.cargoLength / 2, -1);
                let projected = 0;
                for (let i = 0; i < polygon.length; i++) {
                    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
                    projected += a.x * b.z - b.x * a.z;
                }
                area += Math.abs(projected) / 2;
            }
        }
        return area;
    }

    static contactFriction(area) {
        // Deliberate gameplay rule: broad contact grips more than feet or an edge.
        return Math.min(3.2, 0.8 + 1.8 * Math.sqrt(Math.max(0, area) / 0.25));
    }

    static centerOfMass(mesh) {
        const center = mesh.physicsAggregate.body.getMassProperties().centerOfMass || BABYLON.Vector3.Zero();
        return BABYLON.Vector3.TransformCoordinates(center, mesh.computeWorldMatrix(true));
    }
    
    isItemSettled(mesh) {
        if (!mesh.physicsAggregate || !mesh.physicsAggregate.body) return true;
        const vel = mesh.physicsAggregate.body.getLinearVelocity();
        const angVel = mesh.physicsAggregate.body.getAngularVelocity();
        return vel.length() < 0.05 && angVel.length() < 0.05;
    }
    
    checkFallenItems(items, truckBounds) {
        let newlyFallen = 0;
        
        items.forEach(item => {
            if (item.isFallen) return; // Already marked as fallen
            
            if (item.mesh) {
                const pos = item.mesh.position;
                
                // Check if item has fallen out of truck
                const fellBelow = pos.y < 0.5; // Below truck floor level
                const fellOffSide = truckBounds && (
                    pos.x < truckBounds.minX - 1 || 
                    pos.x > truckBounds.maxX + 1 ||
                    pos.z < truckBounds.minZ - 1 ||
                    pos.z > truckBounds.maxZ + 1
                );
                const fellOffBack = truckBounds && pos.z > truckBounds.maxZ + 2; // Fell out the back
                
                if (fellBelow || fellOffSide || fellOffBack) {
                    item.isFallen = true;
                    newlyFallen++;
                    
                    // Trigger callback
                    if (this.onItemFallOut) {
                        this.onItemFallOut(item);
                    }
                }
            }
        });
        
        return newlyFallen;
    }
    
    getFallenCount(items) {
        return items.filter(item => item.isFallen).length;
    }
}
