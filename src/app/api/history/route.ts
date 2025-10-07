import { NextResponse } from "next/server";
import { _getImportedCache } from "../import/route";

export async function GET() {
  return NextResponse.json({ items: _getImportedCache() });
}
