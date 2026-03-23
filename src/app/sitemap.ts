import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/posts";
import { SITE_URL } from "@/lib/config";

export const dynamic = "force-static";
export const revalidate = 86400;

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  const blogEntries = posts.map((post) => ({
    url: `${SITE_URL}/blog/${post.slug}`,
    lastModified: new Date(post.pubDate),
  }));

  return [
    { url: SITE_URL, lastModified: new Date() },
    { url: `${SITE_URL}/blog`, lastModified: new Date() },
    { url: `${SITE_URL}/about`, lastModified: new Date() },
    ...blogEntries,
  ];
}
