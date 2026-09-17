/**
 * Main Entry Point
 */
document.addEventListener('DOMContentLoaded', () => {
    window.game = new Game();
    window.game.init();

    window.render_game_to_text = () => {
        const game = window.game;
        const truck = game.truck;
        return JSON.stringify({
            coordinates: 'meters; +X east, +Y up, +Z north; truck initially faces -Z',
            mode: !game.isRunning ? 'start' : game.isPaused || game.uiManager.modalBlocking ? 'paused' : 'playing',
            level: game.currentLevel,
            physics: game.physicsEnabled,
            truck: truck && {
                position: truck.position.asArray(),
                speedMph: truck.speed,
                accelerationMps2: truck.currentAcceleration * 0.44704,
                yawRate: truck.turnRate,
                pitch: truck.suspensionPitch,
                roll: truck.suspensionRoll
            },
            cargo: (truck?.loadedItems || []).map(item => ({
                id: item.id,
                localPosition: [item.localX, item.localY, item.localZ],
                fallen: item.isFallen,
                velocity: item.mesh.physicsAggregate?.body.getLinearVelocity().asArray()
            })),
            score: game.score
        });
    };

    // Opt-in playtesting hook; ordinary gameplay keeps the normal render loop.
    if (new URLSearchParams(window.location.search).get('test') === '1') {
        window.advanceTime = (ms) => {
            const game = window.game;
            if (!game.scene || !game.isRunning) return;
            game.isUrlLevelOverrideActive = true; // Never submit automated test scores.
            game.engine.stopRenderLoop();
            if (!game.isPaused && !game.uiManager.modalBlocking) {
                game.scene._advancePhysicsEngineStep(Math.max(0, Math.min(ms, 1000)));
                game.update();
            }
            game.scene.physicsEnabled = false;
            game.scene.render();
        };
    }
});
