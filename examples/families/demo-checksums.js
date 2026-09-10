// Synthetic BFAM v1 only. This file is a function body loaded by Families.
// The host supplies bin.crc16; the final return is the module contract.
const familyId = 'demo-bfam';
const size = 128;
const storedAt = size - 2;

function applies(bytes) {
  return bytes.length === size && bytes[4] === 1 &&
    bytes[0] === 0x42 && bytes[1] === 0x46 && bytes[2] === 0x41 && bytes[3] === 0x4d;
}

function identify(bytes) {
  return applies(bytes) ? { familyId, calId: String(bytes[5]) } : undefined;
}

function verify(bytes) {
  const report = { familyId, applies: applies(bytes), blocks: [], valid: false,
    skipped: [], notes: ['Synthetic BFAM v1 example.'] };
  if (!report.applies) return report;
  const stored = bytes[storedAt] | (bytes[storedAt + 1] << 8);
  const computed = bin.crc16(bytes.subarray(0, storedAt), 0);
  report.blocks.push({ id: 'image', label: 'Demo image CRC',
    covers: [{ start: 0, end: storedAt }], storedAt, stored, computed,
    ok: stored === computed, correctable: true });
  report.valid = stored === computed;
  return report;
}

function correct(input) {
  const bytes = new Uint8Array(input);
  const report = verify(input);
  const changed = [];
  if (!report.applies) return { bytes, report, changed };
  const computed = report.blocks[0].computed;
  const replacement = [computed & 0xff, computed >>> 8];
  for (let i = 0; i < replacement.length; i++) {
    const offset = storedAt + i;
    if (bytes[offset] === replacement[i]) continue;
    changed.push({ offset, from: bytes[offset], to: replacement[i] });
    bytes[offset] = replacement[i];
  }
  return { bytes, report: verify(bytes), changed };
}

return { familyId, applies, identify, verify, correct };
