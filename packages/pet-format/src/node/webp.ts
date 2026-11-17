interface Dimensions {
  readonly width: number;
  readonly height: number;
}

export interface WebpHeader extends Dimensions {
  readonly pages: number;
  readonly animated: boolean;
}

interface Chunk {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Inspect bounded RIFF/WebP structure before allowing a native image loader to
 * sniff the input. This reads dimensions and frame counts, never pixel data.
 * A strict decoder must still verify the complete compressed bitstream.
 */
export function inspectWebp(bytes: Uint8Array, label: string): WebpHeader {
  if (bytes.length < 12 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") {
    throw new Error(`${label} must be WebP.`);
  }
  const invalid: () => never = () => { throw new Error(`${label} WebP metadata is invalid.`); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let canvas: Dimensions | undefined;
  let staticImage: Dimensions | undefined;
  let animated = false;
  let animationHeader = false;
  let pages = 0;
  for (const chunk of chunks(bytes, view, 12, bytes.length, invalid)) {
    if (chunk.type === "VP8X") {
      if (canvas || chunk.start !== 20 || chunk.end - chunk.start !== 10) invalid();
      canvas = { width: uint24(bytes, chunk.start + 4) + 1, height: uint24(bytes, chunk.start + 7) + 1 };
      animated = (bytes[chunk.start]! & 2) !== 0;
    } else if (chunk.type === "ANIM") {
      if (!animated || animationHeader || pages || chunk.end - chunk.start !== 6) invalid();
      animationHeader = true;
    } else if (chunk.type === "ANMF") {
      if (!animated || !animationHeader || !canvas || chunk.end - chunk.start < 16 || staticImage) invalid();
      const frame = { width: uint24(bytes, chunk.start + 6) + 1, height: uint24(bytes, chunk.start + 9) + 1 };
      const left = uint24(bytes, chunk.start) * 2;
      const top = uint24(bytes, chunk.start + 3) * 2;
      if (left + frame.width > canvas.width || top + frame.height > canvas.height) invalid();
      let bitstream: Dimensions | undefined;
      for (const subchunk of chunks(bytes, view, chunk.start + 16, chunk.end, invalid)) {
        if (subchunk.type === "VP8 " || subchunk.type === "VP8L") {
          if (bitstream) invalid();
          bitstream = imageDimensions(bytes, view, subchunk, invalid);
        } else if (["VP8X", "ANIM", "ANMF"].includes(subchunk.type)) invalid();
      }
      if (!bitstream || bitstream.width !== frame.width || bitstream.height !== frame.height) invalid();
      pages += 1;
    } else if (chunk.type === "VP8 " || chunk.type === "VP8L") {
      if (animated || staticImage) invalid();
      staticImage = imageDimensions(bytes, view, chunk, invalid);
    }
  }
  if (animated) {
    if (!canvas || !animationHeader || !pages) invalid();
    return { ...canvas, pages, animated };
  }
  if (!staticImage || (canvas && (canvas.width !== staticImage.width || canvas.height !== staticImage.height))) invalid();
  return { ...staticImage, pages: 1, animated: false };
}

function* chunks(bytes: Uint8Array, view: DataView, start: number, end: number, invalid: () => never): Generator<Chunk> {
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) invalid();
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    const next = payload + size + (size % 2);
    if (next > end || (size % 2 && bytes[next - 1] !== 0)) invalid();
    yield { type: fourcc(bytes, offset), start: payload, end: payload + size };
    offset = next;
  }
}

function imageDimensions(bytes: Uint8Array, view: DataView, chunk: Chunk, invalid: () => never): Dimensions {
  const start = chunk.start;
  if (chunk.type === "VP8L") {
    if (chunk.end - start < 5 || bytes[start] !== 0x2f || (bytes[start + 4]! & 0xe0) !== 0) invalid();
    const bits = view.getUint32(start + 1, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk.end - start < 10 || (bytes[start]! & 1) !== 0
    || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) invalid();
  const width = view.getUint16(start + 6, true) & 0x3fff;
  const height = view.getUint16(start + 8, true) & 0x3fff;
  if (!width || !height) invalid();
  return { width, height };
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
}
