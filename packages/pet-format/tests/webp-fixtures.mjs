// Header-only fixtures for decoder-independent policy tests. Their compressed
// payload intentionally needs a decoder stub; real decoding is covered by desktop.
export function webpHeader(width, height, { pages = 1, trailingBytes = 0, tag } = {}) {
  const chunk = (type, payload) => {
    const result = Buffer.alloc(8 + payload.length + payload.length % 2);
    result.write(type, 0, 4, "ascii");
    result.writeUInt32LE(payload.length, 4);
    payload.copy(result, 8);
    return result;
  };
  const bitstream = Buffer.alloc(5);
  bitstream[0] = 0x2f;
  bitstream.writeUInt32LE((width - 1) + (height - 1) * 16384, 1);
  const image = chunk("VP8L", bitstream);
  const parts = [];
  if (pages === 1) parts.push(image);
  else {
    const extended = Buffer.alloc(10);
    extended[0] = 2;
    extended.writeUIntLE(width - 1, 4, 3);
    extended.writeUIntLE(height - 1, 7, 3);
    parts.push(chunk("VP8X", extended), chunk("ANIM", Buffer.alloc(6)));
    for (let page = 0; page < pages; page++) {
      const frame = Buffer.alloc(16);
      frame.writeUIntLE(width - 1, 6, 3);
      frame.writeUIntLE(height - 1, 9, 3);
      parts.push(chunk("ANMF", Buffer.concat([frame, image])));
    }
  }
  if (trailingBytes) parts.push(chunk("JUNK", Buffer.alloc(trailingBytes)));
  if (tag) parts.push(chunk("JUNK", Buffer.from(tag)));
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0);
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8);
  return Buffer.concat([header, body]);
}
