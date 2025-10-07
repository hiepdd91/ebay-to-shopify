// lib/shopify.ts
import fetch from "cross-fetch";

const SHOP = process.env.SHOPIFY_SHOP!;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!;

async function gql<T>(query: string, variables?: Record<string, any>): Promise<T> {
  const res = await fetch(`https://${SHOP}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

type ShopifyProductOption = {
  id: string;
  name: string;
  values: string[];
};

type ShopifyProduct = {
  id: string;
  handle: string;
  title: string;
  options?: ShopifyProductOption[];
};

export async function productCreate(input: Record<string, any>) {
  const query = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          handle
          title
          options {
            id
            name
            values
          }
        }
        userErrors { field message }
      }
    }
  `;
  const data = await gql<{
    productCreate: { product: ShopifyProduct; userErrors: { field: string[]; message: string }[] };
  }>(query, { input });
  const { product, userErrors } = data.productCreate;
  if (userErrors?.length) throw new Error(`productCreate errors: ${JSON.stringify(userErrors)}`);
  return product;
}

/** Upload by URL flow (no binary upload): stagedUploadsCreate -> productCreateMedia(originalSource:url) */
export async function stagedUploadsCreate(params: { filename: string; mimeType: string; httpMethod?: string }) {
  const query = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `;
  // For remote URL media, Shopify lets you skip direct uploads and pass originalSource directly.
  // We'll still keep this helper if you later switch to binary uploads.
  const data = await gql<{
    stagedUploadsCreate: { stagedTargets: any[]; userErrors: any[] };
  }>(query, { input: [{ filename: params.filename, mimeType: params.mimeType, httpMethod: params.httpMethod || "POST", resource: "IMAGE" }] });
  return data.stagedUploadsCreate;
}

export async function productCreateMedia(
  productId: string,
  media: { originalSource: string; alt?: string; mediaContentType: "IMAGE" | "VIDEO" | "MODEL_3D" }[]
) {
  const query = `
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { alt status preview { image { url } } }
        mediaUserErrors { field message }
      }
    }
  `;
  const data = await gql<{ productCreateMedia: { media: any[]; mediaUserErrors: any[] } }>(query, {
    productId,
    media,
  });
  const { media: created, mediaUserErrors } = data.productCreateMedia;
  if (mediaUserErrors?.length) throw new Error(`productCreateMedia errors: ${JSON.stringify(mediaUserErrors)}`);
  return created;
}

export async function productVariantsBulkCreate(productId: string, variants: Record<string, any>[]) {
  if (!variants.length) return [];
  const query = `
    mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
        productVariants { id title sku selectedOptions { name value } }
        userErrors { field message }
      }
    }
  `;
  const data = await gql<{
    productVariantsBulkCreate: { productVariants: any[]; userErrors: { field: string[]; message: string }[] };
  }>(query, { productId, variants });
  const { productVariants, userErrors } = data.productVariantsBulkCreate;
  if (userErrors?.length) throw new Error(`productVariantsBulkCreate errors: ${JSON.stringify(userErrors)}`);
  return productVariants;
}

export async function productVariantAppendMedia(
  productId: string,
  variantMedia: Array<{ variantId: string; mediaIds: string[] }>
) {
  if (!variantMedia.length) return [];
  const query = `
    mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
      productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
        productVariants { id }
        userErrors { field message }
      }
    }
  `;
  const data = await gql<{
    productVariantAppendMedia: { productVariants: any[]; userErrors: { field: string[]; message: string }[] };
  }>(query, { productId, variantMedia });
  const { productVariants, userErrors } = data.productVariantAppendMedia;
  if (userErrors?.length) throw new Error(`productVariantAppendMedia errors: ${JSON.stringify(userErrors)}`);
  return productVariants;
}
