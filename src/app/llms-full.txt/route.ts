import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { getAllPosts, getPostBySlug } from "@/lib/posts";
import { SITE_TITLE, SITE_URL } from "@/lib/config";

export const dynamic = "force-static";

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? value : d.toISOString().slice(0, 10);
}

function readAbout() {
  const filePath = path.join(process.cwd(), "src/content/about.md");
  const file = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(file);
  return {
    title: data.title as string,
    updatedDate: data.updatedDate as string | undefined,
    content: content.trim(),
  };
}

export async function GET() {
  const posts = getAllPosts();
  const about = readAbout();

  const parts: string[] = [
    `# ${SITE_TITLE}`,
    "",
    "> Long-form technical writing by Ian Goforth on security research, low-level systems, and applied machine learning.",
    "",
  ];

  for (const meta of posts) {
    const { content } = getPostBySlug(meta.slug);
    const pub = isoDate(meta.pubDate);
    const updated = isoDate(meta.updatedDate);
    parts.push(
      "---",
      "",
      `# ${meta.title}`,
      "",
      `Source: ${SITE_URL}/blog/${meta.slug}`,
      ...(pub ? [`Published: ${pub}`] : []),
      ...(updated ? [`Updated: ${updated}`] : []),
      "",
      meta.description,
      "",
      content.trim(),
      "",
    );
  }

  const aboutUpdated = isoDate(about.updatedDate);
  parts.push(
    "---",
    "",
    `# ${about.title}`,
    "",
    `Source: ${SITE_URL}/about`,
    ...(aboutUpdated ? [`Updated: ${aboutUpdated}`] : []),
    "",
    about.content,
    "",
  );

  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
