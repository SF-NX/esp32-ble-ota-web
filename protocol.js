export const BLEOTA = Object.freeze({
  OTA_SERVICE: '00008018-0000-1000-8000-00805f9b34fb',
  RECV_CHAR: '00008020-0000-1000-8000-00805f9b34fb',
  CMD_CHAR: '00008022-0000-1000-8000-00805f9b34fb',
  DIS_SERVICE: '0000180a-0000-1000-8000-00805f9b34fb',
  DIS_MODEL: '00002a24-0000-1000-8000-00805f9b34fb',
  DIS_FIRMWARE: '00002a26-0000-1000-8000-00805f9b34fb',
  DIS_HARDWARE: '00002a27-0000-1000-8000-00805f9b34fb',
  DIS_MANUFACTURER: '00002a29-0000-1000-8000-00805f9b34fb',
  CMD_FLASH: 0x0001,
  CMD_STOP: 0x0002,
  CMD_ACK: 0x0003,
  CMD_SPIFFS: 0x0004,
  CMD_SECURE: 0x0005,
  SECTOR_SIZE: 4096,
  MAX_FIRMWARE_PAYLOAD: 507,
  DEFAULT_VALUE_SIZE: 20,
  MAX_RETRIES: 3,
  COMMAND_TIMEOUT: 15000,
  SECTOR_TIMEOUT: 60000
});

export const OTA_PACKAGE = Object.freeze({
  MAGIC: 'JKOTA001',
  HEADER_SIZE: 172,
  FORMAT_VERSION: 1,
  ENCRYPTED_FLAG: 1,
  AUTH_TAG_SIZE: 16
});

export function crc16(data, initial = 0) {
  let crc = initial & 0xffff;
  for (const raw of data) {
    crc ^= (raw & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function buildCommand(command, payload = []) {
  const packet = new Uint8Array(20);
  packet[0] = command & 0xff;
  packet[1] = (command >>> 8) & 0xff;
  Array.from(payload).slice(0, 16).forEach((value, index) => {
    packet[index + 2] = value;
  });
  const checksum = crc16(packet.slice(0, 18));
  packet[18] = checksum & 0xff;
  packet[19] = (checksum >>> 8) & 0xff;
  return packet;
}

export function startPayload(totalBytes) {
  return new Uint8Array([
    totalBytes & 0xff,
    (totalBytes >>> 8) & 0xff,
    (totalBytes >>> 16) & 0xff,
    (totalBytes >>> 24) & 0xff
  ]);
}

export function buildSectorPackets(sectorData, sectorIndex, firmwarePayload) {
  const payloadLimit = Math.max(1, Math.min(BLEOTA.MAX_FIRMWARE_PAYLOAD, firmwarePayload));
  const packets = [];
  let offset = 0;
  let sequence = 0;
  let checksum = 0;

  while (offset < sectorData.length) {
    let count = Math.min(payloadLimit, sectorData.length - offset);
    const tentativeLast = offset + count >= sectorData.length || offset + count >= BLEOTA.SECTOR_SIZE;
    if (tentativeLast && count > Math.max(1, payloadLimit - 2)) {
      count = Math.max(1, payloadLimit - 2);
    }

    const chunk = sectorData.slice(offset, offset + count);
    offset += count;
    const last = offset >= sectorData.length || offset >= BLEOTA.SECTOR_SIZE;
    checksum = crc16(chunk, checksum);

    const packet = new Uint8Array(3 + chunk.length + (last ? 2 : 0));
    packet[0] = sectorIndex & 0xff;
    packet[1] = (sectorIndex >>> 8) & 0xff;
    packet[2] = last ? 0xff : sequence & 0xff;
    packet.set(chunk, 3);
    if (last) {
      packet[packet.length - 2] = checksum & 0xff;
      packet[packet.length - 1] = (checksum >>> 8) & 0xff;
    }
    packets.push(packet);
    sequence += 1;
  }
  return packets;
}

export function parseCommandAck(value, expectedCommand) {
  const bytes = toBytes(value);
  if (bytes.length < 20) return null;
  const receivedCrc = le16(bytes, 18);
  if (crc16(bytes.slice(0, 18)) !== receivedCrc) return null;
  if (le16(bytes, 0) !== BLEOTA.CMD_ACK) return null;
  const command = le16(bytes, 2);
  if (command !== expectedCommand) return null;
  return { command, answer: le16(bytes, 4) };
}

export function parseSectorAck(value, expectedSector) {
  const bytes = toBytes(value);
  if (bytes.length < 4 || le16(bytes, 0) !== expectedSector) return null;
  return {
    sector: expectedSector,
    answer: le16(bytes, 2),
    wantedIndex: bytes.length >= 6 ? le16(bytes, 4) : null
  };
}

export function parseOtaPackage(value) {
  const bytes = toBytes(value);
  const minimumSize = OTA_PACKAGE.HEADER_SIZE + OTA_PACKAGE.AUTH_TAG_SIZE;
  if (bytes.length < minimumSize) throw new Error('升级包过短');
  const magic = new TextDecoder('ascii').decode(bytes.slice(0, 8));
  if (magic !== OTA_PACKAGE.MAGIC) throw new Error('不是有效的 .ota 升级包');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, true) !== OTA_PACKAGE.HEADER_SIZE) throw new Error('不支持的升级包头');
  if (view.getUint16(10, true) !== OTA_PACKAGE.FORMAT_VERSION) throw new Error('不支持的升级包版本');
  if (view.getUint32(12, true) !== OTA_PACKAGE.ENCRYPTED_FLAG) throw new Error('升级包未加密');

  const productId = readAscii(bytes, 16, 16);
  const batchId = readAscii(bytes, 32, 16);
  const firmwareVersion = view.getUint32(48, true);
  const secureVersion = view.getUint32(52, true);
  const firmwareSize = view.getUint32(56, true);
  const cipherSize = view.getUint32(60, true);
  if (firmwareSize !== cipherSize) throw new Error('升级包长度字段无效');
  if (bytes.length !== OTA_PACKAGE.HEADER_SIZE + cipherSize + OTA_PACKAGE.AUTH_TAG_SIZE) throw new Error('升级包不完整');
  return { productId, batchId, firmwareVersion, secureVersion, firmwareSize };
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
}

function le16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readAscii(bytes, offset, length) {
  const field = bytes.slice(offset, offset + length);
  const zero = field.indexOf(0);
  return new TextDecoder('ascii').decode(zero >= 0 ? field.slice(0, zero) : field);
}
