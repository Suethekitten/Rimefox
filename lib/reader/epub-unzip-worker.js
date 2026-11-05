import { unpackEpub } from './epub-zip.js';
self.onmessage = ({ data }) => {
  try {
    const files = unpackEpub(data);
    self.postMessage({ files }, Object.values(files).map((bytes) => bytes.buffer));
  } catch (err) { self.postMessage({ error: { code: err.code || 'not_epub', message: err.message } }); }
};
