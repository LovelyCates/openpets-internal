const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPetDragFeedback } = require('../src/pet-drag-feedback.cjs');

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
