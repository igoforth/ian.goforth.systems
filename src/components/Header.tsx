"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SITE_TITLE } from "@/lib/config";

const navLinks = [
  { href: "/" as const, label: "Home" },
  { href: "/blog" as const, label: "Blog" },
  { href: "/about" as const, label: "About" },
];

const externalLinks = [
  { href: "https://twitter.com/GoForthUntoGlor", label: "Twitter" },
  { href: "https://github.com/igoforth", label: "GitHub" },
  { href: "https://www.linkedin.com/in/igoforth/", label: "LinkedIn" },
];

export default function Header() {
  const pathname = usePathname();

  return (
    <header className="mb-8 font-sans">
      <h2 className="my-2 text-foreground">{SITE_TITLE}</h2>
      <nav className="flex flex-wrap gap-x-3">
        {navLinks.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`text-accent no-underline hover:underline ${
              pathname === href ? "font-bold underline!" : ""
            }`}
          >
            {label}
          </Link>
        ))}
        {externalLinks.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent no-underline hover:underline"
          >
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}
