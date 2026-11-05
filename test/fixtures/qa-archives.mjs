// Compact, synthetic reproducer for external QA E2. No private book content.
import { zipSync } from '../../lib/vendor/fflate.browser.mjs';
export function spoofedEpubZip() {
  const archive = zipSync({ 'payload.bin': new Uint8Array(32 * 1024 * 1024).fill(65) });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let i = 0; i + 46 <= archive.length; i++) {
    if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, 1, true);
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true);
  }
  return archive;
}
