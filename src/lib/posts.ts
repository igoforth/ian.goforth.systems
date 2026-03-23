import "server-only";
import fs from "fs";
import path from "path";
import matter from "gray-matter";

const postsDirectory = path.join(process.cwd(), "src/content/blog");

export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  heroImage?: string | undefined;
  updatedDate?: string | undefined;
}

export function getAllPosts(): PostMeta[] {
  const filenames = fs.readdirSync(postsDirectory);
  const posts = filenames
    .filter((f) => f.endsWith(".md"))
    .map((filename) => {
      const slug = filename.replace(/\.md$/, "");
      const filePath = path.join(postsDirectory, filename);
      const fileContents = fs.readFileSync(filePath, "utf-8");
      const { data } = matter(fileContents);
      return {
        slug,
        title: data.title as string,
        description: data.description as string,
        pubDate: data.pubDate as string,
        heroImage: data.heroImage as string | undefined,
        updatedDate: data.updatedDate as string | undefined,
      };
    });
  return posts.sort(
    (a, b) => new Date(b.pubDate).valueOf() - new Date(a.pubDate).valueOf()
  );
}

export function getPostBySlug(slug: string) {
  const filePath = path.join(postsDirectory, `${slug}.md`);
  const fileContents = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(fileContents);
  return {
    meta: {
      slug,
      title: data.title as string,
      description: data.description as string,
      pubDate: data.pubDate as string,
      heroImage: data.heroImage as string | undefined,
      updatedDate: data.updatedDate as string | undefined,
    } satisfies PostMeta,
    content,
  };
}

export function getAllSlugs(): string[] {
  return fs
    .readdirSync(postsDirectory)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
