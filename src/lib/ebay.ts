// lib/ebay.ts
import fetch from "cross-fetch";

const EBAY_BASE = process.env.EBAY_BASE_API_URL!;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID!;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET!;
const EBAY_OAUTH_SCOPE = process.env.EBAY_OAUTH_SCOPE || "https://api.ebay.com/oauth/api_scope";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getAppToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expires_at - 60 > now) return cachedToken.access_token;

  const auth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: EBAY_OAUTH_SCOPE });

  const res = await fetch(`${EBAY_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${auth}` },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`eBay OAuth failed: ${res.status} ${await res.text()}`);

  const json = await res.json();
  cachedToken = { access_token: json.access_token, expires_at: Math.floor(Date.now() / 1000) + json.expires_in };
  return cachedToken.access_token;
}

export function parseNumericTail(url: string): string | null {
  try {
    const u = new URL(url);
    // Lấy chuỗi số dài ở cuối pathname
    const tail = u.pathname.match(/(\d{9,})$/)?.[1];
    if (tail) return tail;
    // fallback: /itm/123456789012/anything
    const fromItm = u.pathname.match(/\/itm\/(\d{9,})/);
    if (fromItm) return fromItm[1];
    return null;
  } catch {
    return null;
  }
}

/** Trích item_group_id từ thông báo lỗi 11006 của eBay nếu có */
export function parseGroupIdFromErrorText(text: string): string | null {
  const m = text.match(/item_group_id=(\d{6,})/);
  return m?.[1] || null;
}

export async function ebayGetItemByLegacyId(legacyId: string) {
  const token = await getAppToken();
  const url = `${EBAY_BASE}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" as any });
  if (!res.ok) {
    // ném nguyên văn để route có thể đọc và fallback
    const t = await res.text();
    throw new Error(`EBAY_LEGACY_FAIL ${res.status} ${t}`);
  }
  return res.json();
}

export async function ebayGetItem(itemId: string) {
  const token = await getAppToken();
  const url = `${EBAY_BASE}/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" as any });
  if (!res.ok) throw new Error(`eBay item failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function ebayGetItemGroup(itemGroupId: string) {
  const token = await getAppToken();
  const url = `${EBAY_BASE}/buy/browse/v1/item_group/${encodeURIComponent(itemGroupId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" as any });
  if (!res.ok) throw new Error(`eBay item_group failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function ebayGetItemsByItemGroup(itemGroupId: string) {
  const token = await getAppToken();
  const url = `${EBAY_BASE}/buy/browse/v1/item/get_items_by_item_group?item_group_id=${encodeURIComponent(itemGroupId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" as any });
  if (!res.ok) throw new Error(`eBay get_items_by_item_group failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type EbayListingIdentifiers = {
  itemId?: string;
  itemGroupId?: string;
  legacyItemId?: string;
};

export async function ebayExtractListingIdentifiers(sourceUrl: string): Promise<EbayListingIdentifiers | null> {
  const res = await fetch(sourceUrl, {
    headers: {
      // Provide a browser-like UA so eBay returns the standard HTML payload.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  } as RequestInit);

  if (!res.ok) throw new Error(`eBay HTML fetch failed: ${res.status} ${await res.text()}`);

  const html = await res.text();
  const matchValue = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const m = html.match(pattern);
      if (m?.[1]) return m[1];
    }
    return undefined;
  };

  const identifiers: EbayListingIdentifiers = {
    itemId: matchValue([
      /"itemId"\s*:\s*"([^"]+)"/i,
      /'itemId'\s*:\s*'([^']+)'/i,
    ]),
    itemGroupId: matchValue([
      /"itemGroupId"\s*:\s*"([^"]+)"/i,
      /'itemGroupId'\s*:\s*'([^']+)'/i,
    ]),
    legacyItemId: matchValue([
      /"legacyItemId"\s*:\s*"([^"]+)"/i,
      /'legacyItemId'\s*:\s*'([^']+)'/i,
    ]),
  };

  if (identifiers.itemId || identifiers.itemGroupId || identifiers.legacyItemId) return identifiers;
  return null;
}
