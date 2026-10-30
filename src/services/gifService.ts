// GIF search service (Phase 1.6). Provider + key come from build-time env:
//   VITE_GIF_PROVIDER = 'klipy' | 'giphy'
//   VITE_GIF_API_KEY  = <provider API key>
// When either is missing the GIF picker shows a designed "not configured"
// empty state — there is deliberately NO fake/demo feed. All functions
// never throw: network/parse failures resolve to an empty list.

export type GifProvider = 'klipy' | 'giphy';

export interface GifResult {
  id: string;
  /** Full GIF URL — inserted as a real image media message. */
  url: string;
  /** Smaller preview for the picker grid. */
  previewUrl: string;
  title: string;
}

export interface GifConfig {
  provider: GifProvider;
  apiKey: string;
}

export function gifConfig(): GifConfig | null {
  const provider = (import.meta.env.VITE_GIF_PROVIDER || '') as string;
  const apiKey = (import.meta.env.VITE_GIF_API_KEY || '') as string;
  if ((provider === 'klipy' || provider === 'giphy') && apiKey.trim()) {
    return { provider, apiKey: apiKey.trim() };
  }
  return null;
}

export function isGifConfigured(): boolean {
  return gifConfig() !== null;
}

const PER_PAGE = 24;

function parseGiphy(json: any): GifResult[] {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const out: GifResult[] = [];
  for (const row of rows) {
    const url = row?.images?.original?.url;
    if (typeof url !== 'string' || !url) continue;
    out.push({
      id: String(row.id || url),
      url,
      previewUrl: row?.images?.fixed_width?.url || row?.images?.downsized?.url || url,
      title: typeof row.title === 'string' ? row.title : 'GIF',
    });
  }
  return out;
}

function parseKlipy(json: any): GifResult[] {
  // Klipy responses nest results under data.data[] with several rendition
  // shapes across API versions — walk defensively and take the first
  // http(s) GIF URL found per item.
  const rows = Array.isArray(json?.data?.data)
    ? json.data.data
    : Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.results)
        ? json.results
        : [];
  const out: GifResult[] = [];
  const pickUrl = (node: any, depth: number): string | null => {
    if (!node || depth > 4) return null;
    if (typeof node === 'string') return /^https?:\/\//.test(node) ? node : null;
    if (typeof node === 'object') {
      for (const key of ['url', 'gif', 'webp', 'jpg']) {
        const v = pickUrl(node[key], depth + 1);
        if (v) return v;
      }
      for (const v of Object.values(node)) {
        const found = pickUrl(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  for (const row of rows) {
    const url =
      pickUrl(row?.file?.hd?.gif, 0) ||
      pickUrl(row?.file?.md?.gif, 0) ||
      pickUrl(row?.file, 0) ||
      pickUrl(row?.media_formats, 0) ||
      pickUrl(row?.images, 0);
    if (!url) continue;
    out.push({
      id: String(row?.id || row?.slug || url),
      url,
      previewUrl: pickUrl(row?.file?.sm?.gif, 0) || pickUrl(row?.file?.xs?.gif, 0) || url,
      title: typeof row?.title === 'string' ? row.title : 'GIF',
    });
  }
  return out;
}

async function fetchGifs(mode: 'search' | 'trending', query: string): Promise<GifResult[]> {
  const cfg = gifConfig();
  if (!cfg) return [];
  try {
    let url: string;
    if (cfg.provider === 'giphy') {
      const base = mode === 'search' ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending';
      const params = new URLSearchParams({ api_key: cfg.apiKey, limit: String(PER_PAGE), rating: 'pg-13' });
      if (mode === 'search') params.set('q', query);
      url = `${base}?${params.toString()}`;
    } else {
      const base = `https://api.klipy.com/api/v1/${encodeURIComponent(cfg.apiKey)}/gifs/${mode === 'search' ? 'search' : 'trending'}`;
      const params = new URLSearchParams({ per_page: String(PER_PAGE), rating: 'pg-13' });
      if (mode === 'search') params.set('q', query);
      url = `${base}?${params.toString()}`;
    }
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return cfg.provider === 'giphy' ? parseGiphy(json) : parseKlipy(json);
  } catch {
    return [];
  }
}

export function searchGifs(query: string): Promise<GifResult[]> {
  const q = query.trim();
  return q ? fetchGifs('search', q) : fetchGifs('trending', '');
}

export function trendingGifs(): Promise<GifResult[]> {
  return fetchGifs('trending', '');
}
