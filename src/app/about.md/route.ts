import fs from "fs";
import path from "path";

export const dynamic = "force-static";

export async function GET() {
  const filePath = path.join(process.cwd(), "src/content/about.md");
  const source = fs.readFileSync(filePath, "utf-8");
  return new Response(source, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
