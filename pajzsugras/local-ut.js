// The owner's own UT2004 files (local-sounds/, local-models/) are used by themselves (no setting) when a dev build (npm run dev) is served from this
// machine, and by nothing else; without the files the game keeps its own sounds and gauntlet. Vite replaces import.meta.env.DEV with false in the production build, so the code behind a DEV check (the local sounds, the UT2004 shield gun, the
// ?vitrin showcase) is dropped from dist/ together with its dynamic import()s.
import { isLocalHost } from './editor/local-maps.js';

const DEV = import.meta.env?.DEV === true;
export const localUTAvailable = () => DEV && typeof location !== 'undefined' && isLocalHost(location.hostname);
