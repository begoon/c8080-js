export function wrapRks(payload: Uint8Array): Uint8Array {
  if (payload.length === 0) return new Uint8Array(0);

  const end = payload.length - 1;

  let sum = 0;
  for (let i = 0; i < payload.length - 1; i++) sum = (sum + payload[i]! * 257) & 0xffff;
  const crc = ((sum & 0xff00) + ((sum + payload[payload.length - 1]!) & 0xff)) & 0xffff;

  const out = new Uint8Array(payload.length + 6);
  out[0] = 0;
  out[1] = 0;
  out[2] = end & 0xff;
  out[3] = (end >> 8) & 0xff;
  out.set(payload, 4);
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = (crc >> 8) & 0xff;
  return out;
}
