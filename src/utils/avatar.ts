/**
 * Shared initials-avatar generator (Phase 4 consolidation: this is the single
 * canonical copy — ChatViewScreen, ChatsScreen and UserProfileModal each used
 * to carry a local variant, and the copies had drifted: different gradient
 * fallbacks and, in UserProfileModal, a different text fill).
 *
 * The gradient stops ARE the design tokens (--c-grad-from / --c-grad-to),
 * read as computed values at runtime: an <img> data-URL SVG is an isolated
 * document that cannot resolve page CSS variables itself, so the token
 * values are inlined instead of hard-coding colour literals.
 */
function cssToken(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export function initialsAvatarDataUrl(displayName: string): string {
  const initials =
    (displayName || '')
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${cssToken('--c-grad-from', 'blue')}'/><stop offset='1' stop-color='${cssToken('--c-grad-to', 'purple')}'/></linearGradient></defs><rect width='512' height='512' fill='url(#g)'/><text x='50%' y='50%' dy='0.36em' text-anchor='middle' font-family='Arial, sans-serif' font-size='200' font-weight='700' fill='white'>${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
