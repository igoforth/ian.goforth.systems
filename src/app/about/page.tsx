import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import type { Metadata } from "next";

export const dynamic = "force-static";

function getAbout() {
  const filePath = path.join(process.cwd(), "src/content/about.md");
  const fileContents = fs.readFileSync(filePath, "utf-8");
  return matter(fileContents);
}

export function generateMetadata(): Metadata {
  const { data } = getAbout();
  return {
    title: data.title as string,
    description: data.description as string,
  };
}

export default function AboutPage() {
  const { data, content } = getAbout();

  return (
    <article className="prose dark:prose-invert max-w-none">
      {data.heroImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          width={720}
          src={data.heroImage as string}
          alt="AI Generated Image of a Hacker with a Heart of Obsidian"
        />
      )}
      <h1>{data.title as string}</h1>
      {data.updatedDate && (
        <div>
          Last updated on <time>{data.updatedDate as string}</time>
        </div>
      )}
      <hr />
      <MDXRemote
        source={content}
        options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
      />
    </article>
  );
}
