/** Pure inputs and observations for the native Windows pet rendering gate. */
export function parseRenderingArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if ((args.length !== 3 && args.length !== 4) || args[1] !== '--output' || !args[0] || !args[2]
    || (args.length === 4 && args[3] !== '--with-public-yukino')
    || args[0].startsWith('--') || args[2].startsWith('--')) {
    throw new Error('Usage: node internal/validate-windows-pet-rendering.mjs <packaged-app-directory> --output <report-directory> [--with-public-yukino]');
  }
  return { appDirectory: args[0], outputDirectory: args[2], help: false, withPublicYukino: args.length === 4 };
}

export function summarizeFrameIntervals(intervals) {
  const values = intervals.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] : null;
  return {
    intervalCount: values.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    longestMs: values.at(-1) ?? null,
    over100ms: values.filter((value) => value > 100).length,
  };
}

/** Chromium expands background-position into X/Y in computed keyframes. */
export function keyframeBackgroundPosition(frame) {
  if (typeof frame.backgroundPosition === 'string') return frame.backgroundPosition;
  if (typeof frame.backgroundPositionX === 'string' && typeof frame.backgroundPositionY === 'string') {
    return `${frame.backgroundPositionX} ${frame.backgroundPositionY}`;
  }
  return null;
}

export function animationClockAdvanced(first, last) {
  if (!sameDocumentAndSprite(first, last)) return false;
  return first.animations.some((before) => last.animations.some((after) => {
    return sameAnimation(before, after) && before.state === 'running' && after.state === 'running'
      && !before.pending && !after.pending && Number.isFinite(before.time) && Number.isFinite(after.time)
      && after.time > before.time + 100;
  }));
}

export function sharesAnimationClock(first, last, name) {
  return sameDocumentAndSprite(first, last) && first.animations.some((before) => before.name === name
    && last.animations.some((after) => sameAnimation(before, after)
      && before.state === 'running' && after.state === 'running' && !before.pending && !after.pending
      && Number.isFinite(before.time) && Number.isFinite(after.time) && after.time >= before.time));
}

function sameDocumentAndSprite(first, last) {
  return Number.isFinite(first.documentTimeOrigin) && first.documentTimeOrigin === last.documentTimeOrigin
    && first.documentIdentity !== undefined && first.documentIdentity === last.documentIdentity
    && first.semanticEpoch === last.semanticEpoch
    && first.sprite?.identity !== undefined && first.sprite.identity === last.sprite?.identity;
}

function sameAnimation(before, after) {
  return before.identity !== undefined && before.identity === after.identity && before.name === after.name
    && Number.isFinite(before.startTime) && before.startTime === after.startTime
    && Number.isFinite(before.playbackRate) && before.playbackRate > 0 && before.playbackRate === after.playbackRate;
}

/** A startup greeting may interrupt idle; only an uninterrupted natural clock proves idle playback. */
export function findStableIdleWindow(observations, durationMs = 8000) {
  let first;
  let previous;
  let selected;
  for (const current of observations) {
    const idle = current.visibility === 'visible' && current.reaction === 'idle' && current.motion === 'idle'
      && current.paused === 'false' && !current.reducedMotion && !current.idleAnimation;
    const active = idle ? current.animations.filter((animation) => animation.changesBackgroundPosition
      && animation.state === 'running' && !animation.pending && Number.isFinite(animation.time)
      && Number.isFinite(animation.startTime) && Number.isFinite(animation.playbackRate) && animation.playbackRate > 0) : [];
    const animation = active.find((candidate) => selected && sameAnimation(selected, candidate)) ?? active[0];
    if (!animation) {
      first = previous = selected = undefined;
      continue;
    }
    if (!first || !sameDocumentAndSprite(first, current) || !sameAnimation(selected, animation)
      || current.observedAt < previous.observedAt || animation.time < selected.time - 1) {
      first = current;
    }
    previous = current;
    selected = animation;
    const firstAnimation = first.animations.find((candidate) => sameAnimation(candidate, animation));
    const elapsedMs = current.observedAt - first.observedAt;
    const advanceMs = animation.time - firstAnimation.time;
    if (elapsedMs >= durationMs && advanceMs >= elapsedMs * animation.playbackRate * 0.8) {
      return { first, last: current, elapsedMs, advanceMs, playbackRate: animation.playbackRate };
    }
  }
  return null;
}

export function makeSyntheticV1Pixels() {
  const width = 1536;
  const height = 1872;
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < 9; row++) {
    for (let column = 0; column < 8; column++) {
      const left = column * 192 + 32 + column * 3;
      for (let y = row * 208 + 28; y < row * 208 + 180; y++) {
        for (let x = left; x < left + 108; x++) {
          const offset = (y * width + x) * 4;
          pixels[offset] = (row * 29 + column * 31 + 40) % 256;
          pixels[offset + 1] = (row * 43 + column * 17 + 90) % 256;
          pixels[offset + 2] = (row * 11 + column * 47 + 150) % 256;
          pixels[offset + 3] = 255;
        }
      }
    }
  }
  return { pixels, width, height, channels: 4 };
}
