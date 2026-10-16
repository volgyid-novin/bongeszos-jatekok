// Stand-in for the `trystero` package (see loader-hooks.mjs): same shape as the real API net.js uses
// (joinRoom -> { makeAction(type) -> { send, onMessage }, onPeerJoin, onPeerLeave, leave }), but nothing leaves the process.
//   sent    every message the product code sent: { type, data (deep copy), target }
//   rooms   every room that was joined; tests drive it: room.onPeerJoin(id), room.onPeerLeave(id), room.actions[type].onMessage(data, { peerId })
export const selfId = 'mmmm';
export const sent = [];
export const rooms = [];

export function reset() { sent.length = 0; rooms.length = 0; }

export function joinRoom(cfg, id) {
  const room = { id, cfg, left: false, onPeerJoin: null, onPeerLeave: null, actions: {} };
  room.makeAction = (type) => {
    const action = {
      onMessage: null,
      send(data, opts) { sent.push({ type, data: JSON.parse(JSON.stringify(data)), target: opts && opts.target }); return Promise.resolve(); },
    };
    room.actions[type] = action;
    return action;
  };
  room.leave = () => { room.left = true; return Promise.resolve(); };
  rooms.push(room);
  return room;
}
