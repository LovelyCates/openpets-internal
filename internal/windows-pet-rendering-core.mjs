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

export function animationClockAdvanced(first, last) {
  return first.animations.some((before) => last.animations.some((after) => {
    return before.name === after.name && Number.isFinite(before.time) && Number.isFinite(after.time)
      && after.time > before.time + 100;
  }));
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
