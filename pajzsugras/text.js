// Text that comes from outside (a map file, a room peer, a Nostr relay) and is shown in the UI or, for the name of a map, written into a
// file by tools/add-map.mjs. stripText removes what has no place in a name:
//   - the C0 / DEL / C1 controls U+0000-001F, U+007F-009F (U+0085 NEL among them),
//   - the line and paragraph separators U+2028 / U+2029 (line terminators of JavaScript, they end a // comment),
//   - the bidi embeddings, overrides and isolates U+202A-202E, U+2066-2069 (they reorder the text around them),
//   - < and > (markup).
export const stripText = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]/g, '');
