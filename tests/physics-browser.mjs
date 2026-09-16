import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.GAME_URL || 'http://127.0.0.1:8000';
const output = process.env.TEST_ARTIFACT_DIR || 'output/physics';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
    await page.goto(baseUrl + '/?lvl=2&physics=1&pickup=truck&test=1');
    await page.waitForFunction(() => window.game?.isRunning, null, { timeout: 60000 });
    await page.waitForTimeout(1800);
    const metrics = await page.evaluate(() => {
        const game = window.game;
        const truck = game.truck;
        const manager = game.itemManager;
        game.engine.stopRenderLoop();
        game.enablePerfStats = false;
        game.scene.physicsEnabled = false;
        // Dynamics scenarios use an open road; collision response is tested separately.
        game.sceneManager.housesByTile = {};
        game.sceneManager.pickupHouse = null;
        game.sceneManager.destinationWalls = [];
        const originalCheck = truck.checkMeshCollision.bind(truck);
        const reset = () => {
            game.uiManager.hideMenu();
            game.uiManager.hideResults();
            game.resetLevel();
            manager.itemDefinitions = [];
            game.isRunning = true;
            game.isPaused = false;
            game.physicsEnabled = true;
            truck.checkMeshCollision = () => false;
            game.scene._physicsTimeAccumulator = 0;
        };
        const place = (type = 'chair', x = 0, z = 0, rotation = 0) => {
            const template = game.levelManager.itemTemplates.find(item => item.type === type);
            const definition = { ...template, id: 'test-' + manager.placedItems.length };
            manager.itemDefinitions.push(definition);
            manager.selectItem(definition.id);
            const world = manager._truckLocalToWorldXZ(x, z);
            manager.updatePreview(world.x, world.z, rotation);
            const item = manager.placeItem(world.x, world.z, rotation + truck.rotation);
            if (!item) throw new Error('Placement failed: ' + type);
            return item;
        };
        const sample = item => {
            const q = item.mesh.rotationQuaternion || BABYLON.Quaternion.Identity();
            const localQ = BABYLON.Quaternion.Inverse(truck.getTruckBodyQuaternion()).multiply(q);
            const up = BABYLON.Vector3.Up().applyRotationQuaternion(localQ);
            return {
                x: item.localX, y: item.localY, z: item.localZ,
                tilt: Math.acos(Math.max(-1, Math.min(1, up.y))) * 180 / Math.PI,
                vy: item.mesh.physicsAggregate?.body.getLinearVelocity().y || 0,
                fallen: item.isFallen
            };
        };
        const advance = (seconds, keys = {}, fps = 60, item = null) => {
            Object.assign(truck.keys, { w: false, a: false, s: false, d: false, space: false }, keys);
            const samples = [];
            for (let frame = 0; frame < Math.round(seconds * fps); frame++) {
                if (!game.isPaused && !game.uiManager.modalBlocking) {
                    game.scene._advancePhysicsEngineStep(1000 / fps);
                    game.update();
                }
                if (item) samples.push(sample(item));
            }
            return samples;
        };
        const result = {};
        reset();
        let chair = place();
        const idle = advance(3, {}, 60, chair);
        result.idle = {
            travel: Math.hypot(idle.at(-1).x - idle[0].x, idle.at(-1).z - idle[0].z),
            maxTilt: Math.max(...idle.map(s => s.tilt)),
            bounce: Math.max(...idle.map(s => s.y)) - Math.min(...idle.map(s => s.y)),
            dynamic: chair.mesh.physicsAggregate.body.getMotionType() === BABYLON.PhysicsMotionType.DYNAMIC
        };
        const drive = advance(6, { w: true }, 60, chair);
        result.acceleration = {
            mph: -truck.speed,
            distance: -truck.position.z,
            slide: Math.hypot(drive.at(-1).x - drive[0].x, drive.at(-1).z - drive[0].z),
            maxTilt: Math.max(...drive.map(s => s.tilt)),
            maxUpwardSpeed: Math.max(...drive.map(s => s.vy)),
            fallen: chair.isFallen,
            pitch: truck.suspensionPitch
        };
        const coastStart = truck.speed;
        advance(2);
        result.coasting = { beforeMph: -coastStart, afterMph: -truck.speed };
        const stopStart = truck.position.z;
        const cargoStopStart = sample(chair);
        const brake = advance(3, { space: true }, 60, chair);
        result.braking = {
            distance: Math.abs(truck.position.z - stopStart),
            cargoTravel: Math.hypot(brake.at(-1).x - cargoStopStart.x, brake.at(-1).z - cargoStopStart.z),
            stopped: truck.speed === 0,
            maxTilt: Math.max(...brake.map(s => s.tilt)),
            maxUpwardSpeed: Math.max(...brake.map(s => s.vy)),
            fallen: chair.isFallen
        };
        reset();
        advance(5, { w: true });
        chair = place('chair', 0, 1.5);
        const movingPlacement = advance(2, { w: true }, 60, chair);
        result.movingPlacement = {
            maxTilt: Math.max(...movingPlacement.map(s => s.tilt)),
            maxUpwardSpeed: Math.max(...movingPlacement.map(s => s.vy)),
            fallen: chair.isFallen
        };
        reset();
        advance(4, { w: true });
        const emptySpeed = truck.speed;
        reset();
        truck.loadedItems.push({ weight: 1000, isFallen: false });
        advance(4, { w: true });
        result.payload = { emptySpeed: -emptySpeed, loadedSpeed: -truck.speed };
        result.frameRates = [];
        for (const fps of [30, 60, 144]) {
            reset();
            chair = place();
            advance(1, {}, fps);
            advance(4, { w: true }, fps);
            advance(1, { w: true, a: true }, fps);
            result.frameRates.push({ fps, speed: truck.speed, x: truck.position.x, z: truck.position.z, cargo: sample(chair) });
        }
        result.steering = [];
        for (const reverse of [false, true]) {
            for (const key of ['a', 'd']) {
                reset();
                const camera = game.sceneManager.camera;
                game.scene.stopAnimation(camera);
                camera.setTarget(truck.position.clone());
                camera.alpha = Math.PI / 2;
                camera.beta = 0.6;
                const view = camera.getViewMatrix(true).clone();
                advance(1, { [reverse ? 's' : 'w']: true, [key]: true });
                const nose = new BABYLON.Vector3(-Math.sin(truck.rotation), 0, -Math.cos(truck.rotation));
                result.steering.push({
                    key, reverse,
                    screenDirection: BABYLON.Vector3.TransformNormal(nose, view).x,
                    roll: truck.suspensionRoll,
                    steerAngle: truck.currentSteerAngle
                });
            }
        }
        reset();
        advance(1, { w: true });
        result.quickAcceleration = -truck.speed;
        reset();
        truck.speed = -21;
        advance(0.6, { space: true, a: true });
        result.quickStop = { speed: truck.speed, distance: truck.position.length(), yaw: truck.rotation };
        reset();
        advance(3, { s: true });
        result.reverse = { speed: truck.speed, z: truck.position.z };
        advance(1, { s: true, a: true });
        result.reverse.yaw = truck.rotation;
        reset();
        truck.speed = -50;
        advance(1, { a: true });
        result.cornering = Math.abs(truck.speed * 0.44704 * truck.turnRate);
        reset();
        advance(100, { w: true }, 30);
        result.highway = { speed: -truck.speed, gear: truck.currentGear };
        reset();
        chair = place();
        advance(1);
        advance(2, { w: true });
        game.uiManager.showMenu();
        const paused = { position: truck.position.clone(), cargo: chair.mesh.position.clone() };
        advance(2, { w: true });
        result.pause = { truck: BABYLON.Vector3.Distance(paused.position, truck.position), cargo: BABYLON.Vector3.Distance(paused.cargo, chair.mesh.position) };
        game.uiManager.hideMenu();
        advance(0.5, { w: true });
        result.resume = truck.position.z < paused.position.z;
        reset();
        result.reset = { pitch: truck.suspensionPitch, roll: truck.suspensionRoll, yawRate: truck.turnRate, velocity: truck.getPointVelocity(truck.position).length() };
        game.physicsEnabled = false;
        chair = place();
        advance(2, { w: true, d: true });
        result.arcade = { parented: chair.mesh.parent === truck.root, fallen: chair.isFallen };
        reset();
        chair = place();
        advance(1);
        truck.checkMeshCollision = originalCheck;
        const obstacle = BABYLON.MeshBuilder.CreateBox('testObstacle', { width: 10, height: 5, depth: 0.3 }, game.scene);
        obstacle.position.set(0, 2, -15);
        obstacle.computeWorldMatrix(true);
        game.sceneManager.destinationWalls = [obstacle];
        advance(5, { w: true }, 60, chair);
        result.collision = { speed: truck.speed, z: truck.position.z, velocity: truck.getPointVelocity(truck.position).length() };
        obstacle.dispose();
        game.sceneManager.destinationWalls = [];
        reset();
        chair = place();
        advance(1);
        const body = chair.mesh.physicsAggregate.body;
        body.applyImpulse(new BABYLON.Vector3(12, 0, 0), chair.mesh.position.add(new BABYLON.Vector3(0, 0.45, 0)));
        const tip = advance(2, {}, 60, chair);
        result.tipping = { maxTilt: Math.max(...tip.map(s => s.tilt)), fallen: chair.isFallen };
        reset();
        chair = place();
        const stacked = place('box');
        advance(3);
        result.stack = { chair: sample(chair), box: sample(stacked) };
        reset();
        const table = place('table', 0, 0, Math.PI / 2);
        advance(2);
        advance(3, { w: true });
        result.table = sample(table);
        game.scene.stopAnimation(game.sceneManager.camera);
        game.sceneManager.camera.beta = 0.6;
        game.sceneManager.camera.alpha = Math.PI / 2;
        game.sceneManager.updateCameraFollow();
        game.scene.render();
        return result;
    });
    await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    console.log(JSON.stringify(metrics, null, 2));
    assert.equal(errors.length, 0, errors.join('\n'));
    assert(metrics.idle.dynamic);
    assert(metrics.idle.travel < 0.05);
    assert(metrics.idle.maxTilt < 3);
    assert(metrics.idle.bounce < 0.03);
    assert(metrics.acceleration.mph > 40 && metrics.acceleration.mph < 55);
    assert(metrics.acceleration.pitch > 0); // Nose rises under throttle.
    assert(metrics.acceleration.slide > 0.2 && metrics.acceleration.slide < 1);
    assert(metrics.acceleration.maxTilt > 45); // Unsecured tall cargo can tip under hard throttle.
    assert(metrics.acceleration.maxUpwardSpeed < 2);
    assert(!metrics.acceleration.fallen);
    assert(metrics.coasting.afterMph > metrics.coasting.beforeMph * 0.85);
    assert(metrics.braking.stopped);
    assert(metrics.braking.distance > 2 && metrics.braking.distance < 15);
    assert(metrics.braking.cargoTravel > 0.2);
    assert(metrics.braking.maxUpwardSpeed < 3);
    assert(metrics.braking.maxTilt > 45);
    assert(!metrics.braking.fallen);
    assert(!metrics.movingPlacement.fallen);
    assert(metrics.movingPlacement.maxTilt < 5);
    assert(metrics.movingPlacement.maxUpwardSpeed < 1);
    assert(metrics.payload.loadedSpeed < metrics.payload.emptySpeed * 0.85);
    const baseline = metrics.frameRates[0];
    for (const state of metrics.frameRates.slice(1)) {
        assert(Math.hypot(state.x - baseline.x, state.z - baseline.z) < 0.2);
        assert(Math.abs(state.speed - baseline.speed) < 0.1);
        assert(Math.hypot(state.cargo.x - baseline.cargo.x, state.cargo.z - baseline.cargo.z) < 0.05);
        assert(Math.abs(state.cargo.tilt - baseline.cargo.tilt) < 1);
    }
    for (const turn of metrics.steering) {
        const expectedSign = (turn.key === 'a' ? -1 : 1) * (turn.reverse ? -1 : 1);
        assert(turn.screenDirection * expectedSign > 0.05, JSON.stringify(turn));
        assert(turn.steerAngle * (turn.key === 'a' ? -1 : 1) > 0);
        if (!turn.reverse) assert(turn.roll * (turn.key === 'a' ? 1 : -1) > 0);
    }
    assert(metrics.quickAcceleration > 11 && metrics.quickAcceleration < 12);
    assert.equal(metrics.quickStop.speed, 0);
    assert(metrics.quickStop.distance < 3);
    assert(metrics.quickStop.yaw < -0.05); // Braking must not cancel left steering.
    assert(metrics.reverse.speed > 0 && metrics.reverse.speed <= 12);
    assert(metrics.reverse.z > 0 && metrics.reverse.yaw > 0);
    assert(metrics.cornering <= 0.7 * 9.81 + 0.1);
    assert(metrics.highway.speed > 64 && metrics.highway.speed <= 65);
    assert.equal(metrics.highway.gear, 5);
    assert.equal(metrics.pause.truck, 0);
    assert.equal(metrics.pause.cargo, 0);
    assert(metrics.resume);
    assert(Object.values(metrics.reset).every(value => value === 0));
    assert(metrics.arcade.parented && !metrics.arcade.fallen);
    assert.equal(metrics.collision.speed, 0);
    assert.equal(metrics.collision.velocity, 0);
    assert(metrics.collision.z > -12);
    assert(metrics.tipping.maxTilt > 45 && !metrics.tipping.fallen);
    assert(!metrics.stack.chair.fallen && !metrics.stack.box.fallen);
    assert(!metrics.table.fallen && metrics.table.tilt < 5);
    console.log('Physics regression checks passed.');

    // Exercise the real UI and keyboard handlers on a fresh level.
    await page.goto(baseUrl + '/?lvl=2&pickup=truck&test=1');
    await page.waitForFunction(() => window.game?.isRunning, null, { timeout: 60000 });
    assert(await page.evaluate(() => game.physicsEnabled), 'Cargo physics must default to enabled');
    await page.waitForTimeout(1800);
    await page.evaluate(() => {
        window.advanceTime(0);
        game.scene.stopAnimation(game.sceneManager.camera);
        game.sceneManager.camera.beta = 0.6;
        game.enablePerfStats = false;
        game.perfOverlay.style.display = 'none';
        game.scene.render();
    });
    await page.locator('.queue-item').filter({ hasText: 'Chair' }).click();
    const bed = await page.evaluate(() => {
        const point = BABYLON.Vector3.Project(
            new BABYLON.Vector3(0, game.truck.floorTopY, 0),
            BABYLON.Matrix.Identity(), game.scene.getTransformMatrix(),
            game.sceneManager.camera.viewport.toGlobal(game.engine.getRenderWidth(), game.engine.getRenderHeight())
        );
        return {
            x: point.x * game.canvas.clientWidth / game.engine.getRenderWidth(),
            y: point.y * game.canvas.clientHeight / game.engine.getRenderHeight()
        };
    });
    await page.mouse.move(bed.x, bed.y);
    await page.mouse.click(bed.x, bed.y);
    assert.equal(await page.evaluate(() => game.truck.loadedItems.length), 1);
    await page.evaluate(() => window.advanceTime(1000));
    await page.screenshot({ path: path.join(output, 'desktop-loading.png') });
    const pixelCount = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        context.drawImage(game.canvas, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) colors.add(pixels.slice(i, i + 3).join(','));
        return colors.size;
    });
    assert(pixelCount > 100, 'Rendered canvas must contain a nonblank scene');
    await page.keyboard.down('w');
    await page.evaluate(() => { for (let i = 0; i < 4; i++) window.advanceTime(1000); });
    await page.keyboard.up('w');
    assert(await page.evaluate(() => game.truck.speed < -10));
    await page.keyboard.down('Space');
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.advanceTime(1000); });
    await page.keyboard.up('Space');
    assert.equal(await page.evaluate(() => game.truck.speed), 0);
    assert.equal(await page.evaluate(() => game.truck.loadedItems[0].isFallen), false);
    await page.screenshot({ path: path.join(output, 'desktop-braking.png') });
    await page.locator('#btn-menu').click();
    assert(await page.locator('#menu-modal').isVisible());
    await page.locator('#menu-physics').click();
    assert.equal(await page.evaluate(() => game.physicsEnabled), false);
    await page.locator('#menu-physics').click();
    await page.mouse.click(5, 300);
    assert.equal(await page.locator('#menu-modal').isVisible(), false);
    await page.locator('#btn-menu').click();
    await page.locator('#menu-restart').click();
    assert.equal(await page.evaluate(() => game.truck.loadedItems.length), 0);
    assert.equal(await page.evaluate(() => game.truck.speed), 0);

    for (const key of ['a', 'd']) {
        const view = await page.evaluate(() => {
            game.resetLevel();
            // Render newly generated restart geometry before advancing a full second.
            window.advanceTime(0);
            const camera = game.sceneManager.camera;
            game.scene.stopAnimation(camera);
            camera.setTarget(game.truck.position.clone());
            camera.alpha = Math.PI / 2;
            return camera.getViewMatrix(true).asArray();
        });
        await page.keyboard.down('w');
        await page.keyboard.down(key);
        assert(await page.evaluate(key => game.truck.keys.w && game.truck.keys[key], key));
        await page.evaluate(() => window.advanceTime(1000));
        const direction = await page.evaluate(matrix => {
            const yaw = game.truck.rotation;
            return BABYLON.Vector3.TransformNormal(
                new BABYLON.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)),
                BABYLON.Matrix.FromArray(matrix)
            ).x;
        }, view);
        assert(direction * (key === 'a' ? -1 : 1) > 0.05,
            `Keyboard ${key} must steer correctly on screen: ${direction}; ${await page.evaluate(() => window.render_game_to_text())}`);
        await page.keyboard.up(key);
        await page.keyboard.up('w');
        assert.equal(await page.evaluate(() => game.truck.keys.a || game.truck.keys.d || game.truck.keys.w), false);
        await page.screenshot({ path: path.join(output, `desktop-steer-${key}.png`) });
    }
    await page.evaluate(() => game.resetLevel());

    // Mobile uses the same driving model through the existing touch joystick.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => game.handleResize(true));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.advanceTime(0));
    const joystick = page.locator('#joystick-move .joystick-base');
    const joystickRect = await joystick.boundingBox();
    assert(joystickRect);
    await page.mouse.move(joystickRect.x + joystickRect.width / 2, joystickRect.y + 10);
    await page.mouse.down();
    await page.evaluate(() => window.advanceTime(1000));
    assert(await page.evaluate(() => game.truck.speed < 0));
    await page.mouse.up();
    assert.equal(await page.evaluate(() => game.truck.keys.w), false);
    for (const key of ['a', 'd']) {
        await page.evaluate(() => game.resetLevel());
        const x = joystickRect.x + joystickRect.width * (key === 'a' ? 0.15 : 0.85);
        await page.mouse.move(x, joystickRect.y + joystickRect.height * 0.15);
        await page.mouse.down();
        assert(await page.evaluate(key => game.truck.keys[key] && game.truck.keys.w, key));
        await page.evaluate(() => window.advanceTime(1000));
        assert(await page.evaluate(key => game.truck.currentSteerAngle * (key === 'a' ? -1 : 1) > 0, key));
        await page.mouse.up();
        assert.equal(await page.evaluate(() => game.truck.keys.a || game.truck.keys.d || game.truck.keys.w), false);
    }
    await page.screenshot({ path: path.join(output, 'mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    const delivery = await page.evaluate(() => {
        game.resetLevel();
        game.itemManager.itemDefinitions = [];
        // An already loaded delivery isolates braking/completion from packing.
        game.itemManager.areAllItemsPlaced = () => true;
        game.destination = { x: 0, z: -10 };
        game.truck.speed = -10;
        for (let i = 0; i < 3; i++) window.advanceTime(1000);
        return { arrived: game.hasArrivedAtDestination, speed: game.truck.speed, results: game.uiManager.resultsVisible };
    });
    assert(delivery.arrived && delivery.results && Math.abs(delivery.speed) <= 0.1);
    const loss = await page.evaluate(() => {
        game.uiManager.hideResults();
        game.resetLevel();
        const definition = { ...game.levelManager.itemTemplates.find(item => item.type === 'chair'), id: 'loss-test' };
        game.itemManager.itemDefinitions = [definition];
        game.itemManager.selectItem(definition.id);
        game.itemManager.updatePreview(0, 0, 0);
        const item = game.itemManager.placeItem(0, 0, 0);
        const body = item.mesh.physicsAggregate.body;
        item.mesh.position.set(10, 0.5, 0);
        item.mesh.computeWorldMatrix(true);
        body.setPrestepType(BABYLON.PhysicsPrestepType.TELEPORT);
        game.scene.getPhysicsEngine().getPhysicsPlugin().setPhysicsBodyTransformation(body, item.mesh);
        body.setPrestepType(BABYLON.PhysicsPrestepType.DISABLED);
        game.destination = { x: 500, z: 500 };
        window.advanceTime(1000 / 60);
        return item.isFallen && game.fallOutTriggered;
    });
    assert(loss, 'Cargo fully outside the bed must trigger a loss');
    await page.waitForTimeout(900);
    assert(await page.evaluate(() => game.isPaused));
    assert(await page.locator('#gameover-modal').isVisible());

    // Verify real requestAnimationFrame/Havok integration without manual stepping.
    for (const physics of [true, false]) {
        await page.goto(baseUrl + '/?lvl=1&pickup=truck' + (physics ? '' : '&physics=0'));
        await page.waitForFunction(() => window.game?.isRunning, null, { timeout: 60000 });
        assert.equal(await page.evaluate(() => game.physicsEnabled), physics);
        await page.keyboard.down('w');
        await page.waitForFunction(() => game.truck.position.z < -0.1, null, { timeout: 15000 });
        await page.keyboard.up('w');
        assert(await page.evaluate(() => game.truck.speed < 0));
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('UI, keyboard, mobile joystick, rendering, delivery/loss, and normal render-loop checks passed.');
} finally {
    await browser.close();
}
