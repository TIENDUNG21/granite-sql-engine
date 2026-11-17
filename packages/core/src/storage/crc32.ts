/** CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), table driven. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Continue a CRC over more bytes; start with `crc = 0`. */
export function crc32(bytes: Uint8Array, crc = 0, start = 0, end = bytes.length): number {
  let c = ~crc >>> 0;
  for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
