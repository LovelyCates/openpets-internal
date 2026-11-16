/** Pointer drag feedback shares the existing drag transaction, after its 4px threshold. */
function createPetDragFeedback() {
  let start = null;
  let previousX = null;
  let direction = null;
  return {
    start(x, y) {
      start = { x, y };
      previousX = x;
      direction = null;
    },
    move(x, y) {
      if (!start) return null;
      const deltaX = x - previousX;
      previousX = x;
      if (direction === null && Math.hypot(x - start.x, y - start.y) <= 4) return null;
      if (deltaX !== 0) direction = deltaX < 0 ? 'run-left' : 'run-right';
      else direction ??= 'run-right';
      return direction;
    },
    stop(x, y) {
      const moved = direction !== null || Boolean(start && Number.isFinite(x) && Number.isFinite(y)
        && Math.hypot(x - start.x, y - start.y) > 4);
      start = null;
      previousX = null;
      direction = null;
      return moved;
    },
  };
}

module.exports = { createPetDragFeedback };
