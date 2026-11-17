const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPetDragFeedback } = require('../src/pet-drag-feedback.cjs');
const { createPetBodyCoordinator } = require('../src/pet-body-coordinator.cjs');

test('pressing and tiny pointer movement retain the pet appearance until a real drag', () => {
  const drag = createPetDragFeedback();
  drag.start(100, 100);
  assert.equal(drag.move(100, 100), null);
  assert.equal(drag.move(103, 100), null);
  assert.equal(drag.move(104, 100), null);
  assert.equal(drag.stop(), false, 'a normal click is not suppressed as a drag');
  assert.equal(drag.move(120, 100), null, 'release discards the pointer origin');
});

test('horizontal and vertical drags cross the same threshold and retain feedback until release', () => {
  const drag = createPetDragFeedback();
  drag.start(100, 100);
  assert.equal(drag.move(95, 100), 'run-left');
  assert.equal(drag.move(95, 105), 'run-left', 'vertical motion retains the last horizontal direction');
  assert.equal(drag.move(101, 100), 'run-right', 'crossing back inside the original threshold remains an active drag');
  assert.equal(drag.stop(), true);
  drag.start(100, 100);
  assert.equal(drag.move(100, 104), null);
  assert.equal(drag.move(100, 105), 'run-right', 'pure vertical drag receives feedback too');
  assert.equal(drag.stop(), true);
  drag.start(100, 100);
  assert.equal(drag.move(100, 100), null, 'a new press never inherits the previous drag');
  drag.stop();
  drag.start(100, 100);
  assert.equal(drag.stop(100, 110), true, 'release coordinates still suppress a drag click when native movement consumed mousemove');
});

function classicFixture(context) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let rest = false;
  let revision = 0;
  const coordinator = createPetBodyCoordinator({
    player: { stop() {}, clear() {}, dispose() {} },
    now: Date.now,
    random: () => 0,
    setTimeout,
    clearTimeout,
    canPlayClassicIdle: () => true,
    canPresentClassicBusy: () => true,
    onClassicRest: value => { rest = value; },
  });
  const drag = createPetDragFeedback({
    onDirectionChange: direction => coordinator.setDragDirection(direction),
  });
  const update = patch => coordinator.update({ input: {
    epoch: 'document', revision: ++revision, context: 'idle', paused: false, suspended: false, ...patch,
  }, motion: null });
  update();
  context.after(() => coordinator.dispose());
  return { coordinator, drag, update, get rest() { return rest; } };
}

test('matching recovery cancellation restores idle offers without clearing a newer pointer drag', context => {
  const f = classicFixture(context);
  f.drag.start(100, 100, 'first-drag');
  f.drag.move(110, 100);
  f.coordinator.setMotionState('idle');
  f.update({ epoch: 'resumed-document', suspended: true });
  f.update({ epoch: 'resumed-document' });
  assert.equal(f.coordinator.offerClassicIdleVariation(), false, 'host idle snapshots cannot release local drag ownership');
  assert.equal(f.drag.cancel('first-drag'), true);
  assert.equal(f.coordinator.offerClassicIdleVariation(), true, 'the renderer can admit quiet gestures after cancellation');

  f.drag.start(100, 100, 'new-drag');
  f.drag.move(110, 100);
  assert.equal(f.drag.cancel('first-drag'), false);
  assert.equal(f.coordinator.offerClassicIdleVariation(), false, 'an old cancellation cannot unlock the newer drag');
  assert.equal(f.drag.cancel('new-drag'), true);
  assert.equal(f.drag.move(120, 100), null, 'cancellation discards the old pointer origin');
  assert.equal(f.coordinator.offerClassicIdleVariation(), true);
});

test('recovery cancellation resumes the three-cycle busy budget held by a lost mouse-up', context => {
  const f = classicFixture(context);
  f.drag.start(100, 100, 'held-drag');
  f.drag.move(110, 100);
  f.update({ context: 'thinking', classic: { reaction: 'thinking', spriteState: 'review', cycleDurationMs: 1030 } });
  context.mock.timers.tick(10_000);
  assert.equal(f.rest, false);
  f.drag.cancel('held-drag');
  context.mock.timers.tick(3090);
  assert.equal(f.rest, true, 'clearing the renderer drag lets busy artwork return to idle');
});
