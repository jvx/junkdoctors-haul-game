import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/SceneManager.js', import.meta.url), 'utf8');

function fixture({ idleSupported = true, tileCost = 2 } = {}) {
    let now = 0;
    const callbacks = [];
    const created = [];
    const context = {
        performance: { now: () => now },
        setTimeout: (run, delay) => callbacks.push({ run, delay })
    };
    if (idleSupported) {
        context.requestIdleCallback = (run, options) => callbacks.push({ run, timeout: options.timeout });
    }
    const SceneManager = vm.runInNewContext(source + '\nSceneManager;', context);
    const manager = Object.create(SceneManager.prototype);
    Object.assign(manager, {
        houseStreamingEnabled: true,
        pendingHouseTiles: ['0_0', '1_0', '2_0'],
        pendingHouseTileSet: new Set(['0_0', '1_0', '2_0']),
        hasLiveHouses: () => false,
        createHousesForTile: (x, z) => { created.push(`${x}_${z}`); now += tileCost; }
    });
    const needed = new Set(manager.pendingHouseTiles);
    const schedule = () => manager.scheduleHouseWork(needed, 0, 0);
    const run = (remaining = 10, didTimeout = false) => callbacks.shift().run({
        didTimeout, timeRemaining: () => remaining - now
    });
    return { manager, needed, callbacks, created, schedule, run };
}

test('busy frames defer generation until idle time is available', () => {
    const f = fixture();
    f.schedule();
    f.schedule();
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.callbacks[0].timeout, 100);
    f.run(0);
    assert.equal(f.created.length, 0);
    assert.equal(f.manager.pendingHouseTiles.length, 3);
    assert.equal(f.callbacks.length, 1);
    f.run();
    assert.deepEqual(f.created, ['0_0', '1_0']);
    assert.deepEqual(f.manager.pendingHouseTiles, ['2_0']);
});

test('starvation timeout builds only one tile even when tiles are cheap', () => {
    const f = fixture({ tileCost: 0.1 });
    f.schedule();
    f.run(0, true);
    assert.deepEqual(f.created, ['0_0']);
    assert.equal(f.callbacks.length, 1);
});

test('a costly tile ends the current batch', () => {
    const f = fixture({ tileCost: 8 });
    f.schedule();
    f.run();
    assert.deepEqual(f.created, ['0_0']);
});

test('fallback yields between tiles and eventually drains the queue', () => {
    const f = fixture({ idleSupported: false });
    f.schedule();
    for (let i = 0; i < 3; i++) {
        assert.equal(f.callbacks[0].delay, 16);
        f.run();
        assert.equal(f.created.length, i + 1);
    }
    assert.equal(f.callbacks.length, 0);
    assert.equal(f.manager.pendingHouseTileSet.size, 0);
    assert.equal(f.manager._houseWorkScheduled, false);
    f.schedule();
    assert.equal(f.callbacks.length, 0);
});

test('disabling streaming also stops already queued work', () => {
    const f = fixture();
    f.schedule();
    f.manager.houseStreamingEnabled = false;
    f.run();
    f.schedule();
    assert.equal(f.created.length, 0);
    assert.equal(f.callbacks.length, 0);
    assert.equal(f.manager._houseWorkScheduled, false);
    f.manager.houseStreamingEnabled = true;
    f.schedule();
    f.run();
    assert.equal(f.created.length, 2);
});

test('tiles outside the current range and already built tiles are skipped', () => {
    const f = fixture();
    f.needed.delete('0_0');
    f.manager.hasLiveHouses = key => key === '1_0';
    f.schedule();
    f.run();
    assert.deepEqual(f.created, ['2_0']);
    assert.equal(f.callbacks.length, 0);
    assert.equal(f.manager.pendingHouseTileSet.size, 0);
});

test('streaming prioritizes tiles nearest the truck', () => {
    const f = fixture();
    Object.assign(f.manager, {
        groundTileSize: 50,
        groundTilesPerSide: 0,
        groundTiles: [{ gridX: 0, gridZ: 0, position: {} }],
        lastTileUpdatePos: { x: -1, z: -1 },
        _neededTiles: new Set(),
        _houseNeededTiles: new Set(),
        pendingHouseTiles: [],
        pendingHouseTileSet: new Set()
    });
    f.manager.updateInfiniteGround(500, 100);
    assert.equal(f.manager.pendingHouseTiles[0], '10_2');
    const distances = f.manager.pendingHouseTiles.map(key => {
        const [x, z] = key.split('_').map(Number);
        return (x - 10) ** 2 + (z - 2) ** 2;
    });
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
    assert.equal(f.callbacks.length, 1);
});
