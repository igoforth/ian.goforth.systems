import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import rehypePrismPlus from "rehype-prism-plus";
import { getAllSlugs, getPostBySlug } from "@/lib/posts";
import type { Metadata } from "next";

export const dynamic = "force-static";

export async function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { meta } = getPostBySlug(slug);
    return {
      title: meta.title,
      description: meta.description,
      openGraph: {
        title: meta.title,
        description: meta.description,
        images: meta.heroImage ? [meta.heroImage] : undefined,
      },
    };
  } catch {
    return {};
  }
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let post;
  try {
    post = getPostBySlug(slug);
  } catch {
    notFound();
  }

  const { meta, content } = post;

  return (
    <article className="prose dark:prose-invert max-w-none">
      {meta.heroImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img width={720} src={meta.heroImage} alt="" />
      )}
      <h1>{meta.title}</h1>
      {meta.pubDate && <time>{meta.pubDate}</time>}
      {meta.updatedDate && (
        <div>
          Last updated on <time>{meta.updatedDate}</time>
        </div>
      )}
      <hr />
      <MDXRemote
        source={content}
        options={{
          mdxOptions: {
            remarkPlugins: [remarkGfm],
            rehypePlugins: [[rehypePrismPlus, { ignoreMissing: true }]],
          },
        }}
      />
    </article>
  );
}
