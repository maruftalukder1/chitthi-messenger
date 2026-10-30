/**
 * Real-time dynamic timestamp and relative time formatter
 * Supports English and Bengali localization
 */

const BENGALI_NUMERALS: Record<string, string> = {
  '0': '০',
  '1': '১',
  '2': '২',
  '3': '৩',
  '4': '৪',
  '5': '৫',
  '6': '৬',
  '7': '৭',
  '8': '৮',
  '9': '৯'
};

export const toBengaliDigits = (val: number | string): string => {
  return String(val).replace(/[0-9]/g, (digit) => BENGALI_NUMERALS[digit] || digit);
};

export const formatRelativeTime = (
  timestamp?: number | string,
  lang: 'bn' | 'en' = 'en',
  fallback?: string
): string => {
  let tsNum: number | undefined;

  if (typeof timestamp === 'number' && !isNaN(timestamp) && timestamp > 0) {
    tsNum = timestamp;
  } else if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (!isNaN(parsed) && parsed > 0) {
      tsNum = parsed;
    } else {
      const num = Number(timestamp);
      if (!isNaN(num) && num > 0) {
        tsNum = num;
      }
    }
  }

  if (!tsNum) {
    if (fallback) {
      const fbLower = fallback.toLowerCase().trim();
      if (fbLower === 'just now') {
        return lang === 'bn' ? 'এইমাত্র' : 'Just now';
      }
      if (fbLower === 'yesterday') {
        return lang === 'bn' ? 'গতকাল' : 'Yesterday';
      }
      return fallback;
    }
    // Return a realistic formatted past time or "Recently" instead of repeating "Just now"
    return lang === 'bn' ? 'সম্প্রতি' : 'Recently';
  }

  const now = Date.now();
  const diffMs = now - tsNum;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  // If time is within the last 45 seconds
  if (diffSec < 45 && diffSec >= -5) {
    return lang === 'bn' ? 'এইমাত্র' : 'Just now';
  }

  // If time is within the last hour: show minutes ago
  if (diffMin < 60 && diffMin >= 1) {
    if (lang === 'bn') {
      return `${toBengaliDigits(diffMin)} মি আগে`;
    }
    return `${diffMin}m ago`;
  }

  const targetDate = new Date(tsNum);
  const nowDate = new Date(now);

  const isToday =
    targetDate.getDate() === nowDate.getDate() &&
    targetDate.getMonth() === nowDate.getMonth() &&
    targetDate.getFullYear() === nowDate.getFullYear();

  // If today: display clock time
  if (isToday) {
    let hours = targetDate.getHours();
    const minutes = targetDate.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;

    if (lang === 'bn') {
      return `${toBengaliDigits(hours)}:${toBengaliDigits(minutes)} ${ampm}`;
    }
    return `${hours}:${minutes} ${ampm}`;
  }

  const yesterdayDate = new Date(now - 24 * 60 * 60 * 1000);
  const isYesterday =
    targetDate.getDate() === yesterdayDate.getDate() &&
    targetDate.getMonth() === yesterdayDate.getMonth() &&
    targetDate.getFullYear() === yesterdayDate.getFullYear();

  if (isYesterday) {
    return lang === 'bn' ? 'গতকাল' : 'Yesterday';
  }

  if (diffDay < 7 && diffDay >= 1) {
    const daysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daysBn = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
    const dayIdx = targetDate.getDay();
    return lang === 'bn' ? daysBn[dayIdx] : daysEn[dayIdx];
  }

  // Month & Day
  const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthsBn = ['জানু', 'ফেব্রু', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টে', 'অক্টো', 'নভে', 'ডিসে'];
  const month = targetDate.getMonth();
  const dateNum = targetDate.getDate();

  if (lang === 'bn') {
    return `${toBengaliDigits(dateNum)} ${monthsBn[month]}`;
  }
  return `${monthsEn[month]} ${dateNum}`;
};

export const formatClockTime = (timestamp: number | string, lang: 'bn' | 'en' = 'en'): string => {
  const tsNum = typeof timestamp === 'string' ? Number(timestamp) || Date.parse(timestamp) : timestamp;
  const d = new Date(tsNum || Date.now());
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;

  if (lang === 'bn') {
    return `${toBengaliDigits(hours)}:${toBengaliDigits(minutes)} ${ampm}`;
  }
  return `${hours}:${minutes} ${ampm}`;
};

export const formatFullDateTime = (timestamp: number | string, lang: 'bn' | 'en' = 'en'): string => {
  const tsNum = typeof timestamp === 'string' ? Number(timestamp) || Date.parse(timestamp) : timestamp;
  const d = new Date(tsNum || Date.now());
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? (lang === 'bn' ? 'বিকাল' : 'PM') : (lang === 'bn' ? 'সকাল' : 'AM');
  hours = hours % 12;
  hours = hours ? hours : 12;

  const monthsEn = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthsBn = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
  const month = d.getMonth();
  const day = d.getDate();
  const year = d.getFullYear();

  if (lang === 'bn') {
    return `${toBengaliDigits(day)} ${monthsBn[month]} ${toBengaliDigits(year)}, ${ampm} ${toBengaliDigits(hours)}:${toBengaliDigits(minutes)}`;
  }
  return `${monthsEn[month]} ${day}, ${year} at ${hours}:${minutes} ${ampm}`;
};
