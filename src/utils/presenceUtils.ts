import { User, PresenceStatus } from '../types/chat';

/**
 * Calculates effective real-time presence for a user.
 * Guarantees that users who have been inactive for more than a few minutes,
 * or whose lastSeen indicates past activity (e.g. "Active 15m ago", "Active 2h ago", "Active yesterday"),
 * are strictly marked as 'offline' so that stale yellow dots NEVER linger!
 */
export function getEffectiveUserPresence(user?: User | null): PresenceStatus {
  if (!user) return 'offline';

  // Explicitly marked offline
  if (user.online === false) return 'offline';
  if (user.presence === 'offline') return 'offline';

  // Inspect lastSeen string for past relative times
  const lastSeenStr = (user.lastSeen || '').toLowerCase().trim();
  if (
    lastSeenStr.includes('ago') ||
    lastSeenStr.includes('yesterday') ||
    lastSeenStr.includes('মিনিট আগে') ||
    lastSeenStr.includes('ঘণ্টা আগে') ||
    lastSeenStr.includes('গতকাল') ||
    lastSeenStr.includes('অফলাইন') ||
    lastSeenStr.includes('offline')
  ) {
    return 'offline';
  }

  // If user has an explicit active timestamp
  const anyUser = user as any;
  if (anyUser.lastActiveTimestamp && typeof anyUser.lastActiveTimestamp === 'number') {
    const elapsed = Date.now() - anyUser.lastActiveTimestamp;
    if (elapsed > 5 * 60 * 1000) {
      // Inactive for more than 5 minutes -> completely offline (no yellow dot)
      return 'offline';
    }
    if (elapsed > 1.5 * 60 * 1000) {
      // 1.5 to 5 minutes -> away (yellow dot)
      return 'away';
    }
    return 'online';
  }

  // Presence derives only from the real presence data on the user record
  // (server registry: presence/online flags + lastActive timestamp above).
  // No identity-based fabrication: unknown users fall through to 'offline'.
  if (user.presence === 'online' || user.online) {
    return 'online';
  }

  if (user.presence === 'away') {
    return 'away';
  }

  return 'offline';
}

/**
 * Helper to check if a presence status should display an avatar dot
 * 'online' -> green
 * 'away' -> yellow
 * 'offline' -> no dot (hidden)
 */
export function getPresenceDotClass(presence: PresenceStatus): string | null {
  if (presence === 'online') {
    return 'bg-emerald-500';
  }
  if (presence === 'away') {
    return 'bg-amber-500';
  }
  return null;
}
