import { Feed } from "feed";
import { getAllPosts } from "@/lib/posts";
import { SITE_TITLE, SITE_DESCRIPTION, SITE_URL } from "@/lib/config";

export const dynamic = "force-static";

export async function GET() {
  const posts = getAllPosts();
  const feed = new Feed({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    id: SITE_URL,
    link: SITE_URL,
    copyright: `${new Date().getFullYear()} Ian Goforth`,
  });

  for (const post of posts) {
    feed.addItem({
      title: post.title,
      id: `${SITE_URL}/blog/${post.slug}`,
      link: `${SITE_URL}/blog/${post.slug}`,
      description: post.description,
      date: new Date(post.pubDate),
    });
  }

  return new Response(feed.rss2(), {
    headers: { "Content-Type": "application/xml" },
  });
}
