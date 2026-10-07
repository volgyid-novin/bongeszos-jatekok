// Bakes the sky lookup tables off the main thread (gfx/skylut.js).
import { bakeSky } from './skylut.js';

self.onmessage = (e) => {
  const r = bakeSky(e.data);
  self.postMessage(r, [r.trans.buffer, r.ms.buffer, r.sky.buffer]);
};
