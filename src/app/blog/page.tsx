import Link from "next/link";
import { getAllPosts } from "@/lib/posts";

export const dynamic = "force-static";

export default function BlogIndex() {
  const posts = getAllPosts();

  return (
    <div className="content">
      <ul className="list-none p-0">
        {posts.map((post) => (
          <li key={post.slug} className="flex">
            <time
              dateTime={post.pubDate}
              className="shrink-0 basis-[130px] italic text-muted-foreground"
            >
              {new Date(post.pubDate).toLocaleDateString("en-us", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </time>
            <Link href={`/blog/${post.slug}`}>{post.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
