import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.TEST_ARTIFACT_DIR || 'output/contact';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto((process.env.GAME_URL || 'http://127.0.0.1:8000') + '/?lvl=2&pickup=truck&test=1');
    await page.waitForFunction(() => window.game?.isRunning, null, { timeout: 60000 });
    const metrics = await page.evaluate(() => {
        const t = game.truck, m = game.itemManager, scene = game.scene;
        game.engine.stopRenderLoop();
        game.scene.physicsEnabled = false;
        const reset = () => {
            game.resetLevel();
            m.itemDefinitions = [];
            game.isRunning = true;
            game.isPaused = false;
            game.physicsEnabled = true;
            game.uiManager.hideMenu();
            t.checkMeshCollision = () => false;
            scene._physicsTimeAccumulator = 0;
        };
        const advance = seconds => {
            for (let i = 0; i < seconds * 120; i++) {
                scene._advancePhysicsEngineStep(1000 / 120);
                game.update();
            }
        };
        const place = (type, size, x = 0, z = 0) => {
            const def = { ...game.levelManager.itemTemplates.find(d => d.type === type), id: 'contact-' + m.placedItems.length };
            if (size) { def.size = size; def.weight = 8; }
            m.itemDefinitions.push(def);
            m.selectItem(def.id);
            const p = m._truckLocalToWorldXZ(x, z);
            m.updatePreview(p.x, p.z, 0);
            const item = m.placeItem(p.x, p.z, 0);
            if (!item) throw new Error('Could not place ' + type);
            return item;
        };
        const orient = (item, rotation) => {
            const mesh = item.mesh, body = mesh.physicsAggregate.body;
            mesh.rotationQuaternion = rotation;
            mesh.position.y = 0;
            const matrix = mesh.computeWorldMatrix(true);
            const minimumY = Math.min(...mesh.collisionParts.flatMap(part => PhysicsSystem.partCorners(part))
                .map(p => BABYLON.Vector3.TransformCoordinates(p, matrix).y));
            mesh.position.y = t.floorTopY - minimumY + 0.005;
            body.setPrestepType(BABYLON.PhysicsPrestepType.TELEPORT);
            body.setLinearVelocity(BABYLON.Vector3.Zero());
            body.setAngularVelocity(BABYLON.Vector3.Zero());
            mesh.computeWorldMatrix(true);
            advance(2 / 120);
            body.setPrestepType(BABYLON.PhysicsPrestepType.DISABLED);
            advance(2);
        };
        const result = { table: [], sliding: [] };
        for (const upsideDown of [false, true]) {
            reset();
            const item = place('table');
            orient(item, BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, upsideDown ? Math.PI : 0));
            result.table.push({ upsideDown, area: item.floorContactArea, friction: item._contactFriction,
                parts: item.mesh.collisionParts.length, upY: BABYLON.Vector3.Up().applyRotationQuaternion(item.mesh.rotationQuaternion).y,
                fallen: item.isFallen });
        }
        for (const wide of [false, true]) {
            reset();
            const item = place('box', { x: wide ? 0.8 : 0.2, y: 0.1, z: 0.4 });
            advance(1);
            const area = item.floorContactArea, friction = item._contactFriction;
            const body = item.mesh.physicsAggregate.body;
            const start = item.mesh.position.clone();
            body.applyImpulse(new BABYLON.Vector3(0, 0, body.getMassProperties().mass * 2), PhysicsSystem.centerOfMass(item.mesh));
            advance(0.5);
            result.sliding.push({ wide, area, friction, distance: BABYLON.Vector3.Distance(start, item.mesh.position), fallen: item.isFallen });
        }
        reset();
        const chair = place('chair');
        advance(1);
        const box = place('box', { x: 0.1, y: 0.1, z: 0.1 });
        const boxStart = box.mesh.position.y;
        advance(3);
        const chairMatrix = chair.mesh.computeWorldMatrix(true);
        const seatTop = Math.max(...chair.mesh.collisionParts.filter(part => part.max.x - part.min.x > 0.25 && part.max.z - part.min.z > 0.3)
            .flatMap(part => PhysicsSystem.partCorners(part)).map(p => BABYLON.Vector3.TransformCoordinates(p, chairMatrix).y));
        result.openBack = { drop: boxStart - box.mesh.position.y, gapAboveSeat: box.mesh.position.y - 0.05 - seatTop };

        reset();
        const ledge = place('table');
        orient(ledge, BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, Math.PI));
        const perched = place('chair', null, -0.43, 0.44);
        const perchedY = perched.mesh.position.y;
        let maxTilt = 0;
        for (let i = 0; i < 240; i++) {
            advance(1 / 60);
            const upY = BABYLON.Vector3.Up().applyRotationQuaternion(perched.mesh.rotationQuaternion).y;
            maxTilt = Math.max(maxTilt, Math.acos(Math.max(-1, Math.min(1, upY))) * 180 / Math.PI);
        }
        result.oneLeg = { drop: perchedY - perched.mesh.position.y, maxTilt };

        reset();
        const table = place('table');
        orient(table, BABYLON.Quaternion.RotationAxis(BABYLON.Axis.X, Math.PI));
        const upper = place('chair');
        const initialY = upper.mesh.position.y;
        advance(4);
        const visibleBottom = Math.min(...upper.mesh.collisionParts.flatMap(part => PhysicsSystem.partCorners(part))
            .map(p => BABYLON.Vector3.TransformCoordinates(p, upper.mesh.computeWorldMatrix(true)).y));
        const tabletop = table.mesh.collisionParts.find(part => part.max.x - part.min.x > 0.8 && part.max.z - part.min.z > 1.6);
        const topY = Math.max(...PhysicsSystem.partCorners(tabletop).map(p => BABYLON.Vector3.TransformCoordinates(p, table.mesh.computeWorldMatrix(true)).y));
        result.openTable = { drop: initialY - upper.mesh.position.y, gap: visibleBottom - topY,
            tableParts: table.mesh.collisionParts.length, chairParts: upper.mesh.collisionParts.length, fallen: upper.isFallen };

        // Area is clipped to the bed, and cannot come from a broad face in mid-air.
        const originalPosition = upper.mesh.position.clone();
        upper.mesh.position.y += 3;
        result.airArea = PhysicsSystem.floorContactArea(upper, t);
        upper.mesh.position.copyFrom(originalPosition);
        const originalTableX = table.mesh.position.x;
        const fullArea = PhysicsSystem.floorContactArea(table, t);
        table.mesh.position.x = t.cargoWidth / 2;
        const edgeArea = PhysicsSystem.floorContactArea(table, t);
        table.mesh.position.x = originalTableX;
        result.bedEdge = { fullArea, edgeArea };

        game.scene.stopAnimation(game.sceneManager.camera);
        game.sceneManager.cameraFollowEnabled = false;
        game.sceneManager.camera.setTarget(new BABYLON.Vector3(0, 1.3, 0));
        game.sceneManager.camera.alpha = Math.PI / 2;
        game.sceneManager.camera.beta = 0.35;
        game.sceneManager.camera.lowerRadiusLimit = 3;
        game.sceneManager.camera.radius = 6;
        scene.render();
        return result;
    });
    await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
    await page.screenshot({ path: path.join(output, 'furniture-support.png') });
    console.log(JSON.stringify(metrics, null, 2));
    assert.equal(errors.length, 0, errors.join('\n'));
    assert(metrics.openTable.tableParts >= 5 && metrics.openTable.chairParts >= 6);
    assert(metrics.openTable.drop > 0.45 && Math.abs(metrics.openTable.gap) < 0.035 && !metrics.openTable.fallen);
    assert(metrics.openBack.drop > 0.3 && Math.abs(metrics.openBack.gapAboveSeat) < 0.035);
    assert(metrics.oneLeg.drop > 0.2 && metrics.oneLeg.maxTilt > 15, 'Off-center chair cannot balance on one table leg');
    assert(metrics.table[1].area > metrics.table[0].area * 10);
    assert(metrics.table[0].upY > 0.99 && metrics.table[1].upY < -0.99);
    assert(metrics.table[1].friction > metrics.table[0].friction * 1.5);
    assert(metrics.table.every(item => item.area > 0 && !item.fallen));
    assert(metrics.sliding[1].area > metrics.sliding[0].area * 3);
    assert(metrics.sliding[1].friction > metrics.sliding[0].friction);
    assert(metrics.sliding[1].distance < metrics.sliding[0].distance * 0.85);
    assert(metrics.sliding.every(item => !item.fallen && item.distance > 0.01));
    assert.equal(metrics.airArea, 0);
    assert(metrics.bedEdge.edgeArea > 0 && metrics.bedEdge.edgeArea < metrics.bedEdge.fullArea * 0.6);
    console.log('Furniture support and contact-area friction checks passed.');
} finally {
    await browser.close();
}
