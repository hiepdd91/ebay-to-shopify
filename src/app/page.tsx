"use client";

import { useState } from "react";

type ImportRow = {
  sourceUrl: string;
  legacyItemId?: string;
  productId?: string;
  handle?: string;
  title?: string;
  variants?: number;
  status: "created" | "updated" | "failed";
  error?: string;
  shopifyUrl?: string;
};

export default function Page() {
  const [urls, setUrls] = useState(
    [
      "https://www.ebay.com/itm/30-Calotropis-Procera-Leave-Sodom-Apple-Dead-Sea-Apple-Dried-Leaf-Herb-Ceylon-/317074302407",
      "https://www.ebay.com/itm/356227859677",
      "https://www.ebay.com/itm/262742221410",
    ].join("\n")
  );
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function onImport() {
    setLoading(true);
    try {
      const list = urls.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: list }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Import failed");
      setRows(prev => [...json.results, ...prev]);
    } catch (e: any) {
      alert(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshHistory() {
    const res = await fetch("/api/history", { cache: "no-store" });
    const json = await res.json();
    setRows(json.items);
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold mb-4">Import eBay ➝ Shopify (App Router)</h1>

      <div className="mb-4">
        <label className="block font-medium mb-1">eBay URLs (mỗi dòng một URL)</label>
        <textarea
          className="w-full border rounded p-3 h-40"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          placeholder="https://www.ebay.com/itm/..."
        />
      </div>

      <div className="flex gap-3 mb-6">
        <button
          onClick={onImport}
          disabled={loading}
          className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
        >
          {loading ? "Importing..." : "Import"}
        </button>
        <button onClick={refreshHistory} className="px-4 py-2 rounded border">
          Refresh History
        </button>
      </div>

      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left border-b">
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Title</th>
            <th className="py-2 pr-3">Variants</th>
            <th className="py-2 pr-3">eBay</th>
            <th className="py-2 pr-3">Shopify</th>
            <th className="py-2">Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b">
              <td className="py-2 pr-3">
                <span className={r.status === "failed" ? "text-red-600" : "text-green-700"}>
                  {r.status}
                </span>
              </td>
              <td className="py-2 pr-3">{r.title || "-"}</td>
              <td className="py-2 pr-3">{r.variants ?? "-"}</td>
              <td className="py-2 pr-3">
                <a href={r.sourceUrl} className="text-blue-600 underline" target="_blank">eBay</a>
              </td>
              <td className="py-2 pr-3">
                {r.shopifyUrl ? <a href={r.shopifyUrl} className="text-blue-600 underline" target="_blank" rel="noreferrer">Admin</a> : "-"}
              </td>
              <td className="py-2">
                {r.error ? (
                  <details>
                    <summary className="cursor-pointer text-red-600">error</summary>
                    <pre className="whitespace-pre-wrap text-xs">{r.error}</pre>
                  </details>
                ) : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
