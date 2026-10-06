// Per-player preferences, remembered in localStorage when available.

const KEY = 'blockshot-sens'

function load() {
  try {
    const v = Number(localStorage.getItem(KEY))
    return v > 0 ? v : 1
  } catch {
    return 1
  }
}

export const settings = {
  sensitivity: load(),
  setSensitivity(v: number) {
    this.sensitivity = v
    try {
      localStorage.setItem(KEY, String(v))
    } catch {
      /* ignore */
    }
  },
}
