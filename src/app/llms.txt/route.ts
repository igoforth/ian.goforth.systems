import { getAllPosts } from "@/lib/posts";
import { SITE_TITLE, SITE_URL } from "@/lib/config";

export const dynamic = "force-static";

function isoDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? value : d.toISOString().slice(0, 10);
}

export async function GET() {
  const posts = getAllPosts();
  const lines: string[] = [
    `# ${SITE_TITLE}`,
    "",
    "> Long-form technical writing by Ian Goforth on security research, low-level systems, and applied machine learning.",
    "",
    "## Blog",
    "",
    ...posts.map(
      (p) =>
        `- [${p.title}](${SITE_URL}/blog/${p.slug}.md) (${isoDate(p.pubDate)}): ${p.description}`,
    ),
    "",
    "## About",
    "",
    `- [About the author](${SITE_URL}/about.md)`,
    "",
    "## Optional",
    "",
    `- [Full text of every post](${SITE_URL}/llms-full.txt): single-file concatenation of all blog posts in raw markdown.`,
    `- [RSS feed](${SITE_URL}/rss.xml)`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
