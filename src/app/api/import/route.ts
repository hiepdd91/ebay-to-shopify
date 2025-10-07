// app/api/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  ebayExtractListingIdentifiers,
  ebayGetItem,
  ebayGetItemByLegacyId,
  ebayGetItemGroup,
  ebayGetItemsByItemGroup,
  parseNumericTail,
  parseGroupIdFromErrorText,
} from "@/lib/ebay";
import { buildShopifyProductInputFromEbay, buildVariantKey, mapEbayItemGroup, mapEbaySingleItem } from "@/lib/map";
import { productCreate, productCreateMedia, productVariantAppendMedia, productVariantsBulkCreate } from "@/lib/shopify";

export type ImportResult = {
  sourceUrl: string;
  legacyItemId?: string; // có thể là "numeric tail" ban đầu
  productId?: string;
  handle?: string;
  title?: string;
  variants?: number;
  status: "created" | "updated" | "failed";
  error?: string;
  shopifyUrl?: string;
};

const importedCache: ImportResult[] = [];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const urls: string[] = (Array.isArray(body?.urls) ? body.urls : (body?.url ? [body.url] : [])).filter(Boolean);
    if (!urls.length) return NextResponse.json({ error: "Missing url/urls" }, { status: 400 });

    const results: ImportResult[] = [];

    for (const sourceUrl of urls) {
      const r: ImportResult = { sourceUrl, status: "failed" };
      try {
        const numeric = parseNumericTail(sourceUrl);
        if (!numeric) throw new Error("Cannot parse numeric id from URL");

        r.legacyItemId = numeric;

        let itemOrGroup: any;
        let isGroup = false;

        // 1) thử như legacy id, sau đó fallback hợp lý
        try {
          itemOrGroup = await ebayGetItemByLegacyId(numeric);
        } catch (err: any) {
          const msg = String(err?.message || err);
          const attemptNotes: string[] = [`legacy(${numeric}): ${msg}`];
          const attemptedGroupIds = new Set<string>();
          const attemptedLegacyIds = new Set<string>([numeric]);
          const attemptedItemIds = new Set<string>();
          let scrapedIds: Awaited<ReturnType<typeof ebayExtractListingIdentifiers>> | null | undefined;

          const ensureScraped = async () => {
            if (scrapedIds !== undefined) return scrapedIds;
            try {
              scrapedIds = await ebayExtractListingIdentifiers(sourceUrl);
              if (!scrapedIds) attemptNotes.push("scrape: no identifiers found in HTML");
            } catch (scrapeErr: any) {
              attemptNotes.push(`scrape: ${scrapeErr?.message || scrapeErr}`);
              scrapedIds = null;
            }
            return scrapedIds;
          };

          const tryLegacyId = async (id?: string) => {
            if (!id || itemOrGroup) return;
            if (attemptedLegacyIds.has(id)) return;
            attemptedLegacyIds.add(id);
            try {
              itemOrGroup = await ebayGetItemByLegacyId(id);
              attemptNotes.push(`legacy(${id}): success`);
            } catch (legacyErr: any) {
              attemptNotes.push(`legacy(${id}): ${legacyErr?.message || legacyErr}`);
            }
          };

          const normalizeGroupResponse = (data: any) => {
            if (!data) return data;
            const items =
              Array.isArray(data.items)
                ? data.items
                : Array.isArray(data.itemSummaries)
                  ? data.itemSummaries
                  : Array.isArray(data.itemSummariesV2)
                    ? data.itemSummariesV2
                    : [];
            const first = items[0] ?? {};
            return {
              ...data,
              items,
              title: data.title || first.title,
              description: data.description || first.description,
            };
          };

          const tryGroupId = async (id?: string) => {
            if (!id || itemOrGroup) return;
            if (attemptedGroupIds.has(id)) return;
            attemptedGroupIds.add(id);
            const attempts: Array<{ label: string; fn: () => Promise<any> }> = [
              { label: "item_group", fn: () => ebayGetItemGroup(id) },
              { label: "get_items_by_item_group", fn: () => ebayGetItemsByItemGroup(id) },
            ];
            for (const attempt of attempts) {
              if (itemOrGroup) break;
              try {
                const raw = await attempt.fn();
                itemOrGroup = normalizeGroupResponse(raw);
                isGroup = true;
                attemptNotes.push(`${attempt.label}(${id}): success`);
              } catch (groupErr: any) {
                attemptNotes.push(`${attempt.label}(${id}): ${groupErr?.message || groupErr}`);
              }
            }
          };

          const tryItemId = async (id?: string) => {
            if (!id || itemOrGroup) return;
            if (attemptedItemIds.has(id)) return;
            attemptedItemIds.add(id);
            try {
              itemOrGroup = await ebayGetItem(id);
              isGroup = false;
              attemptNotes.push(`item(${id}): success`);
            } catch (itemErr: any) {
              attemptNotes.push(`item(${id}): ${itemErr?.message || itemErr}`);
            }
          };

          // hinted group from error text
          const hintedGroup = parseGroupIdFromErrorText(msg);
          await tryGroupId(hintedGroup);

          // try numeric as group
          await tryGroupId(numeric);

          // scrape identifiers from HTML for more options
          if (!itemOrGroup) {
            const scraped = await ensureScraped();
            if (scraped?.legacyItemId && scraped.legacyItemId !== numeric) {
              await tryLegacyId(scraped.legacyItemId);
            }
            if (!itemOrGroup && scraped?.itemGroupId && scraped.itemGroupId !== numeric) {
              await tryGroupId(scraped.itemGroupId);
            }
          }

          // Attempt direct item fetch with the best identifiers we have
          if (!itemOrGroup) {
            const scraped = scrapedIds ?? null;
            const candidateItemIds = Array.from(
              new Set(
                [
                  scraped?.itemId,
                  scraped?.legacyItemId ? `v1|${scraped.legacyItemId}|0` : undefined,
                  `v1|${numeric}|0`,
                  numeric,
                ].filter(Boolean)
              )
            );
            for (const candidate of candidateItemIds) {
              if (itemOrGroup) break;
              await tryItemId(candidate as string);
            }
          }

          if (!itemOrGroup) {
            throw new Error(`Unable to fetch eBay data for ${sourceUrl} after multiple attempts:\n${attemptNotes.join("\n")}`);
          }
        }

        const payload = isGroup
          ? mapEbayItemGroup(itemOrGroup)
          : (itemOrGroup.itemGroupType && itemOrGroup.itemGroupId
              ? mapEbayItemGroup(await ebayGetItemGroup(itemOrGroup.itemGroupId))
              : mapEbaySingleItem(itemOrGroup));

        const { productInput, variantInputs, variantAssets, meta } = buildShopifyProductInputFromEbay(payload as any);
        const created = await productCreate(productInput);

        r.productId = created.id;
        r.handle = created.handle;
        r.title = created.title;

        const orderedImages: string[] = [];
        const seenImages = new Set<string>();
        const pushImage = (url?: string) => {
          if (!url) return;
          if (seenImages.has(url)) return;
          seenImages.add(url);
          orderedImages.push(url);
        };

        for (const asset of variantAssets) {
          if (asset.imageUrls?.length) pushImage(asset.imageUrls[0]);
        }
        for (const url of (payload as any).imageUrls ?? []) pushImage(url);

        const MEDIA_UPLOAD_LIMIT = 100;
        const mediaInputs = orderedImages.slice(0, MEDIA_UPLOAD_LIMIT).map((src: string, idx: number) => ({
          originalSource: src,
          alt: `${productInput.title} (Image ${idx + 1})`,
          mediaContentType: "IMAGE" as const,
        }));
        const mediaIdByUrl = new Map<string, string>();
        if (mediaInputs.length) {
          const createdMedia = await productCreateMedia(created.id, mediaInputs);
          for (let i = 0; i < mediaInputs.length; i += 1) {
            const media = createdMedia[i];
            const input = mediaInputs[i];
            if (media?.id && input?.originalSource) mediaIdByUrl.set(input.originalSource, media.id);
          }
        }

        const createdVariants = await productVariantsBulkCreate(created.id, variantInputs);
        r.variants = createdVariants.length;
        r.shopifyUrl = `https://${process.env.SHOPIFY_SHOP}/admin/products/${created.id?.split("/").pop()}`;

        const variantAssetMap = new Map(variantAssets.map(asset => [asset.key, asset.imageUrls]));
        const variantMediaPayload: Array<{ variantId: string; mediaIds: string[] }> = [];
        for (const variant of createdVariants) {
          const optionValues = (variant.selectedOptions || []).map((opt: any) => ({
            optionName: opt?.name,
            name: opt?.value,
          }));
          const key = buildVariantKey(optionValues, variant.sku);
          const candidateUrls = variantAssetMap.get(key) || [];
          const mediaIds: string[] = [];
          for (const url of candidateUrls) {
            const mediaId = mediaIdByUrl.get(url);
            if (mediaId && !mediaIds.includes(mediaId)) mediaIds.push(mediaId);
          }
          if (mediaIds.length) variantMediaPayload.push({ variantId: variant.id, mediaIds });
        }
        if (variantMediaPayload.length) await productVariantAppendMedia(created.id, variantMediaPayload);

        if (meta?.droppedVariants) {
          const warning = `Skipped ${meta.droppedVariants} variants due to Shopify 100 variant limit`;
          r.error = r.error ? `${r.error}\n${warning}` : warning;
        }

        r.status = "created";
      } catch (e: any) {
        r.error = String(e?.message || e);
        r.status = "failed";
      }

      results.push(r);
      importedCache.unshift(r);
      if (importedCache.length > 50) importedCache.pop();
    }

    return NextResponse.json({ results }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export function _getImportedCache() {
  return importedCache;
}
