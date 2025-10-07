// lib/map.ts
type EbayItem = any; // keep flexible for brevity

type ShopifyProductPayload = {
  productInput: {
    title: string;
    descriptionHtml?: string;
    vendor?: string;
    tags?: string[];
    status: "ACTIVE" | "DRAFT";
    productOptions?: Array<{
      name: string;
      position: number;
      values: Array<{ name: string }>;
    }>;
  };
  variantInputs: Array<{
    price?: string;
    inventoryPolicy?: "DENY" | "CONTINUE";
    inventoryItem?: { sku?: string };
    optionValues?: Array<{ optionName?: string; name: string }>;
    mediaSrc?: string[];
  }>;
  variantAssets: Array<{ key: string; imageUrls: string[] }>;
  meta?: {
    droppedVariants?: number;
  };
};

function getAspect(item: EbayItem, name: string): string | undefined {
  const a = item.localizedAspects || item.additionalAspects;
  if (!Array.isArray(a)) return;
  const found = a.find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return found?.value?.toString();
}

const DEFAULT_OPTION_NAME = "Title";
const DEFAULT_OPTION_VALUE = "Default Title";
const MAX_SHOPIFY_VARIANTS = 100;

function fallbackOptionValue(optionName: string) {
  return optionName === DEFAULT_OPTION_NAME ? DEFAULT_OPTION_VALUE : "Default";
}

type VariantOptionValue = { optionName?: string; name: string };

function normalizeKeyPart(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

export function buildVariantKey(optionValues: VariantOptionValue[], sku?: string | null) {
  const parts = optionValues.map(opt => {
    const name = normalizeKeyPart(opt.optionName || DEFAULT_OPTION_NAME);
    const value = normalizeKeyPart(opt.name);
    return `${name}=${value}`;
  });
  if (sku) parts.push(`sku=${normalizeKeyPart(sku)}`);
  return parts.join("|");
}

export function buildShopifyProductInputFromEbay(singleOrGroup: {
  title: string;
  description?: string;
  imageUrls: string[];
  tags: string[];
  vendor?: string;
  variants: Array<{ sku: string; price: string; currencyCode: string; options: Record<string, string>; imageUrl?: string; imageUrls?: string[] }>;
  optionsOrder: string[];
}): ShopifyProductPayload {
  const uniqueTags = Array.from(new Set(singleOrGroup.tags.map(tag => tag.trim()).filter(Boolean)));

  const inferredOptions = singleOrGroup.optionsOrder.map((name, index) => {
    const values = new Set(
      singleOrGroup.variants
        .map(v => v.options[name])
        .filter((value): value is string => Boolean(value))
    );
    if (!values.size) values.add(fallbackOptionValue(name));
    return {
      name,
      position: index + 1,
      values: Array.from(values).map(value => ({ name: value })),
    };
  });

  const hasDefinedOptions = inferredOptions.length > 0;
  const productOptions = hasDefinedOptions
    ? inferredOptions
    : [{
        name: DEFAULT_OPTION_NAME,
        position: 1,
        values: [{ name: DEFAULT_OPTION_VALUE }],
      }];

  const seenVariantKeys = new Set<string>();

  const rawVariantPayloads: Array<{ key: string; input: ShopifyProductPayload["variantInputs"][number]; imageUrls: string[] }> = [];

  singleOrGroup.variants.forEach(variant => {
    const optionValues = hasDefinedOptions
      ? productOptions.map(option => {
          const value = variant.options[option.name] ?? fallbackOptionValue(option.name);
          return { optionName: option.name, name: value };
        })
      : [{ optionName: DEFAULT_OPTION_NAME, name: DEFAULT_OPTION_VALUE }];

    const variantKey = buildVariantKey(optionValues, variant.sku);
    if (seenVariantKeys.has(variantKey)) return;
    seenVariantKeys.add(variantKey);

    const imageSources = Array.from(
      new Set(
        [
          ...(variant.imageUrls || []),
          variant.imageUrl,
        ].filter((src): src is string => Boolean(src))
      )
    );

    const mediaSrc = imageSources.length ? [imageSources[0]] : undefined;

    rawVariantPayloads.push({
      key: variantKey,
      imageUrls: imageSources,
      input: {
        price: variant.price,
        inventoryPolicy: "DENY" as const,
        inventoryItem: { sku: variant.sku },
        optionValues,
        mediaSrc,
      },
    });
  });

  const variantPayloads = rawVariantPayloads.slice(0, MAX_SHOPIFY_VARIANTS);
  const droppedVariants = rawVariantPayloads.length - variantPayloads.length;

  return {
    productInput: {
      title: singleOrGroup.title,
      descriptionHtml: singleOrGroup.description || "",
      vendor: singleOrGroup.vendor || undefined,
      tags: uniqueTags,
      status: "ACTIVE",
      productOptions,
    },
    variantInputs: variantPayloads.map(v => v.input),
    variantAssets: variantPayloads.map(v => ({ key: v.key, imageUrls: v.imageUrls })),
    meta: droppedVariants > 0 ? { droppedVariants } : undefined,
  };
}

export function mapEbaySingleItem(item: EbayItem) {
  const title = item.title;
  const description = item.description || item.shortDescription || "";
  const vendor = getAspect(item, "Brand");
  const tags: string[] = [];
  if (item.categoryPath) tags.push(...String(item.categoryPath).split("/").map((s: string) => s.trim()).filter(Boolean));
  if (vendor) tags.push(vendor);
  const imageSourceSet = new Set<string>(
    [
      item.image?.imageUrl,
      ...(item.additionalImages || []).map((x: any) => x.imageUrl),
    ].filter(Boolean)
  );
  const imageUrls = Array.from(imageSourceSet);

  const price = String(item.price?.value ?? "0.00");
  const currencyCode = item.price?.currency ?? "USD";

  const sku = item.mpn || item.epid || item.legacyItemId || item.itemId || `EBAY-${Date.now()}`;
  return {
    title,
    description,
    vendor,
    tags,
    imageUrls,
    variants: [{
      sku,
      price,
      currencyCode,
      options: {}, // single variant
      imageUrl: imageUrls[0],
      imageUrls,
    }],
    optionsOrder: [], // no options
  };
}

function collectEbayItems(group: any) {
  if (Array.isArray(group?.items) && group.items.length) return group.items;
  if (Array.isArray(group?.itemSummaries) && group.itemSummaries.length) return group.itemSummaries;
  if (Array.isArray(group?.itemSummariesV2) && group.itemSummariesV2.length) return group.itemSummariesV2;
  return [];
}

function normAspectValue(value: any): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const joined = value.map(v => (typeof v === "string" ? v.trim() : String(v).trim())).filter(Boolean).join(" / ");
    return joined || undefined;
  }
  return String(value).trim() || undefined;
}

export function mapEbayItemGroup(group: any) {
  const items = collectEbayItems(group);
  if (!items.length) throw new Error("eBay group payload missing items");

  const first = items[0];
  const title = group.title || first?.title || "Imported from eBay";
  const description =
    group.description ||
    first?.description ||
    group.commonDescriptions?.[0]?.description ||
    "";
  const vendor = getAspect(first, "Brand");

  const tags: string[] = [];
  if (first?.categoryPath) {
    tags.push(
      ...String(first.categoryPath)
        .split("/")
        .map((s: string) => s.trim())
        .filter(Boolean)
    );
  }
  if (vendor) tags.push(vendor);

  const aspectMeta = new Map<
    string,
    { originalName: string; values: Set<string>; order: number }
  >();
  let aspectOrderCounter = 0;

  const addAspect = (nameRaw: string | undefined, valueRaw: any) => {
    const name = nameRaw?.trim();
    const value = normAspectValue(valueRaw);
    if (!name || !value) return;
    const key = name.toLowerCase();
    if (!aspectMeta.has(key)) {
      aspectMeta.set(key, { originalName: name, values: new Set(), order: aspectOrderCounter++ });
    }
    aspectMeta.get(key)!.values.add(value);
  };

  for (const item of items) {
    const localized = Array.isArray(item.localizedAspects) ? item.localizedAspects : [];
    const additional = Array.isArray(item.additionalAspects) ? item.additionalAspects : [];
    [...localized, ...additional].forEach((aspect: any) => addAspect(aspect?.name, aspect?.value));
  }

  const optionNames = Array.from(aspectMeta.values())
    .filter(meta => meta.values.size > 1)
    .filter(meta => meta.originalName.length <= 30 && meta.values.size <= 50)
    .filter(meta => !["brand", "model", "type", "unit type", "unit quantity", "features", "style", "connectivity", "contract", "lock status", "operating system"].includes(meta.originalName.toLowerCase()))
    .sort((a, b) => {
      const diff = b.values.size - a.values.size;
      if (diff !== 0) return diff;
      return a.order - b.order;
    })
    .slice(0, 3)
    .map(meta => meta.originalName);

  const optionsOrder = optionNames;

  const productImageSet = new Set<string>();

  const variants = items.map((it: any) => {
    const options: Record<string, string> = {};
    for (const name of optionNames) {
      const fromAspect =
        [...(it.localizedAspects || []), ...(it.additionalAspects || [])].find((a: any) => (a?.name || "").trim().toLowerCase() === name.toLowerCase());
      const value = normAspectValue(fromAspect?.value);
      if (value) options[name] = value;
    }

    const price = String(it.price?.value ?? first?.price?.value ?? "0.00");
    const currencyCode = it.price?.currency ?? first?.price?.currency ?? "USD";
    const sku = it.mpn || it.epid || it.legacyItemId || it.itemId;

    const imageCandidates = [
      it.image?.imageUrl,
      ...(it.additionalImages || []).map((x: any) => x.imageUrl),
    ].filter(Boolean);
    imageCandidates.forEach((url: string) => productImageSet.add(url));

    return {
      sku,
      price,
      currencyCode,
      options,
      imageUrl: imageCandidates[0],
      imageUrls: imageCandidates,
    };
  });

  const imageUrls = Array.from(productImageSet);

  return {
    title,
    description,
    vendor,
    tags,
    imageUrls,
    variants,
    optionsOrder,
  };
}
