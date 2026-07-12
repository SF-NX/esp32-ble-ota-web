import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLEOTA,
  buildCommand,
  buildSectorPackets,
  crc16,
  parseCommandAck,
  parseOtaPackage,
  parseSectorAck,
  startPayload
} from '../protocol.js';

test('CRC16-CCITT uses the BLEOTA initial value', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x31c3);
});

test('encrypted .ota package header matches the Android parser', () => {
  const payloadSize = 32;
  const packageBytes = new Uint8Array(172 + payloadSize + 16);
  packageBytes.set(new TextEncoder().encode('JKOTA001'), 0);
  const view = new DataView(packageBytes.buffer);
  view.setUint16(8, 172, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, 1, true);
  packageBytes.set(new TextEncoder().encode('JK-BMS-LCD'), 16);
  packageBytes.set(new TextEncoder().encode('BATCH-2026'), 32);
  view.setUint32(48, 106, true);
  view.setUint32(52, 7, true);
  view.setUint32(56, payloadSize, true);
  view.setUint32(60, payloadSize, true);

  assert.deepEqual(parseOtaPackage(packageBytes), {
    productId: 'JK-BMS-LCD', batchId: 'BATCH-2026', firmwareVersion: 106, secureVersion: 7, firmwareSize: payloadSize
  });
  packageBytes[12] = 0;
  assert.throws(() => parseOtaPackage(packageBytes), /未加密/);
});

test('START command contains little-endian size and valid CRC', () => {
  const command = buildCommand(BLEOTA.CMD_SECURE, startPayload(0x12345678));
  assert.deepEqual(Array.from(command.slice(0, 6)), [5, 0, 0x78, 0x56, 0x34, 0x12]);
  assert.equal(command[18] | (command[19] << 8), crc16(command.slice(0, 18)));
});

test('sector packets preserve data and append the running CRC', () => {
  const firmware = Uint8Array.from({ length: 613 }, (_, index) => index & 0xff);
  const packets = buildSectorPackets(firmware, 7, 61);
  assert.ok(packets.length > 1);
  assert.equal(packets[0][0], 7);
  assert.equal(packets.at(-1)[2], 0xff);
  assert.ok(packets.every((packet) => packet.length <= 64));

  const rebuilt = [];
  for (const packet of packets) {
    const end = packet[2] === 0xff ? packet.length - 2 : packet.length;
    rebuilt.push(...packet.slice(3, end));
  }
  assert.deepEqual(rebuilt, Array.from(firmware));
  const last = packets.at(-1);
  assert.equal(last.at(-2) | (last.at(-1) << 8), crc16(firmware));
});

test('ACK parsers ignore unrelated responses', () => {
  const payload = new Uint8Array([BLEOTA.CMD_FLASH, 0, 0, 0]);
  const ack = buildCommand(BLEOTA.CMD_ACK, payload);
  assert.deepEqual(parseCommandAck(ack, BLEOTA.CMD_FLASH), { command: BLEOTA.CMD_FLASH, answer: 0 });
  assert.equal(parseCommandAck(ack, BLEOTA.CMD_SPIFFS), null);

  const sectorAck = new Uint8Array([4, 0, 1, 0, 5, 0]);
  assert.deepEqual(parseSectorAck(sectorAck, 4), { sector: 4, answer: 1, wantedIndex: 5 });
  assert.equal(parseSectorAck(sectorAck, 3), null);
});
