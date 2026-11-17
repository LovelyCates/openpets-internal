/** Pointer drag feedback shares the existing drag transaction, after its 4px threshold. */
function createPetDragFeedback({ onDirectionChange = () => {} } = {}) {
  let start = null;
  let previousX = null;
  let direction = null;
  let token = null;
  function stop(x, y) {
    const moved = direction !== null || Boolean(start && Number.isFinite(x) && Number.isFinite(y)
      && Math.hypot(x - start.x, y - start.y) > 4);
    start = null;
    previousX = null;
    direction = null;
    token = null;
    onDirectionChange(null);
    return moved;
  }
  return {
    get token() { return token; },
    start(x, y, nextToken = null) {
      if (direction !== null) onDirectionChange(null);
      start = { x, y };
      previousX = x;
      direction = null;
      token = nextToken;
    },
    move(x, y) {
      if (!start) return null;
      const deltaX = x - previousX;
      previousX = x;
      if (direction === null && Math.hypot(x - start.x, y - start.y) <= 4) return null;
      if (deltaX !== 0) direction = deltaX < 0 ? 'run-left' : 'run-right';
      else direction ??= 'run-right';
      onDirectionChange(direction);
      return direction;
    },
    stop,
    cancel(expectedToken) {
      if (typeof expectedToken !== 'string' || expectedToken !== token) return false;
      stop();
      return true;
    },
  };
}

module.exports = { createPetDragFeedback };
