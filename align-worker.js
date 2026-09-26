// Rechnet die Ausrichtung im Hintergrund, damit die Seite dabei nicht einfriert
import { align } from './align.js';

self.onmessage = (e) => {
  const { V, N } = e.data;
  self.postMessage(align(V.gray, V.gw, V.gh, N.gray, N.gw, N.gh));
};
