// @ts-check
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as cheerio from "cheerio";
import { glob } from "glob";

/**
 * Convert Next.js URL-encoded path to file system path
 * @param {string} url - URL from src attribute
 * @returns {string|null} - File system path or null if not a local resource
 */
function urlToFilePath(url) {
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("//") ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  ) {
    return null;
  }

  let filePath = url.startsWith("/") ? url.slice(1) : url;
  filePath = decodeURIComponent(filePath);

  if (filePath.startsWith("_next/")) {
    filePath = "." + filePath.slice(1);
  }

  return filePath;
}

/**
 * Calculate integrity hash for a file
 * @param {string} filePath - Path to the file
 * @returns {string|null} - Integrity hash or null if file doesn't exist
 */
function calculateFileIntegrity(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(content).digest("base64");
    return `sha256-${hash}`;
  } catch {
    console.warn(`Could not read file: ${filePath}`);
    return null;
  }
}

/**
 * Calculate integrity hash for content
 * @param {string} content - Content to hash
 * @returns {string} - Integrity hash
 */
function calculateContentHash(content) {
  const hash = crypto.createHash("sha256").update(content).digest("base64");
  return `sha256-${hash}`;
}

/**
 * Add integrity attributes to external resources (scripts/stylesheets)
 * @param {cheerio.CheerioAPI} $ - Cheerio instance
 * @param {string} baseDir - Base directory for resolving relative paths
 * @param {Object} config - Configuration object
 * @param {string} config.selector - CSS selector for elements
 * @param {string} config.urlAttr - Attribute name for URL (e.g., 'src' or 'href')
 * @param {string} config.resourceType - Type name for logging
 * @returns {Set<string>} - Set of integrity hashes present
 */
function addIntegrityToExternalResources(
  $,
  baseDir,
  { selector, urlAttr, resourceType },
) {
  const elements = $(selector);
  const hashes = new Set();

  elements.each((index, element) => {
    const $el = $(element);
    const url = $el.attr(urlAttr);

    if ($el.attr("integrity")) {
      hashes.add(`'${$el.attr("integrity")}'`);
      return;
    }

    if (!url) return;

    const filePath = urlToFilePath(url);
    if (!filePath) return;

    const fullPath = path.join(baseDir, filePath);
    const integrity = calculateFileIntegrity(fullPath);

    if (integrity) {
      $el.attr("integrity", integrity);
      hashes.add(`'${integrity}'`);
      console.debug(`Added integrity to ${resourceType}: ${url}`);
      console.debug(`→ ${integrity.substring(0, 30)}...`);
    }
  });

  return hashes;
}

/**
 * Get integrity hashes from internal content elements
 * @param {cheerio.CheerioAPI} $ - Cheerio instance
 * @param {Object} config - Configuration object
 * @param {string} config.selector - CSS selector for elements
 * @param {string} config.resourceType - Type name for logging
 * @param {Function} [config.getContent] - Optional function to extract content
 * @returns {Set<string>} - Set of integrity hashes
 */
function getIntegrityFromInternalContent(
  $,
  { selector, resourceType, getContent },
) {
  const elements = $(selector);
  const hashes = new Set();

  elements.each((index, element) => {
    const $el = $(element);
    const content = getContent ? getContent($el, element) : $el.html() || "";

    if (content.trim()) {
      const hash = calculateContentHash(content);
      hashes.add(`'${hash}'`);
      console.debug(
        `${resourceType} ${index + 1}: ${hash.substring(0, 27)}...`,
      );
    }
  });

  return hashes;
}

function addIntegrityToExternalScripts($, baseDir) {
  return addIntegrityToExternalResources($, baseDir, {
    selector: "script[src]",
    urlAttr: "src",
    resourceType: "script",
  });
}

function addIntegrityToExternalStyles($, baseDir) {
  return addIntegrityToExternalResources($, baseDir, {
    selector: 'link[rel="stylesheet"][href]',
    urlAttr: "href",
    resourceType: "stylesheet",
  });
}

function getIntegrityFromInternalScripts($) {
  return getIntegrityFromInternalContent($, {
    selector: "script:not([src])",
    resourceType: "Script",
  });
}

function getIntegrityFromInternalStyles($) {
  return getIntegrityFromInternalContent($, {
    selector: "style:not([src])",
    resourceType: "Style",
  });
}

function getIntegrityFromInlineStyleAttributes($) {
  return getIntegrityFromInternalContent($, {
    selector: "[style]",
    resourceType: "Inline style attribute",
    getContent: ($el) => {
      const styleContent = $el.attr("style");
      return styleContent ? styleContent.trim() : "";
    },
  });
}

function addIntegrityToPreloadScripts($, baseDir) {
  return addIntegrityToExternalResources($, baseDir, {
    selector:
      'link[rel="preload"][as="script"][href], link[rel="modulepreload"][href]',
    urlAttr: "href",
    resourceType: "preload script",
  });
}

function addIntegrityToPreloadStyles($, baseDir) {
  return addIntegrityToExternalResources($, baseDir, {
    selector: 'link[rel="preload"][as="style"][href]',
    urlAttr: "href",
    resourceType: "preload style",
  });
}

/**
 * Process HTML content: add SRI integrity attributes and inject CSP meta tag
 * @param {string} html - HTML content
 * @param {string} baseDir - Base directory for resolving relative paths
 * @returns {{ modifiedHtml: string, inlineHashCount: number, externalHashCount: number }}
 */
function processHTML(html, baseDir) {
  const $ = cheerio.load(html);

  console.group("Processing resources");

  const externalScriptHashes = addIntegrityToExternalScripts($, baseDir);
  const preloadScriptHashes = addIntegrityToPreloadScripts($, baseDir);
  const internalScriptHashes = getIntegrityFromInternalScripts($);
  const externalStyleHashes = addIntegrityToExternalStyles($, baseDir);
  const preloadStyleHashes = addIntegrityToPreloadStyles($, baseDir);
  const internalStyleHashes = getIntegrityFromInternalStyles($);
  const inlineStyleAttributeHashes = getIntegrityFromInlineStyleAttributes($);

  console.groupEnd();

  if (
    internalScriptHashes.size === 0 &&
    internalStyleHashes.size === 0 &&
    inlineStyleAttributeHashes.size === 0 &&
    externalScriptHashes.size === 0 &&
    externalStyleHashes.size === 0 &&
    preloadScriptHashes.size === 0 &&
    preloadStyleHashes.size === 0
  ) {
    return { modifiedHtml: html, inlineHashCount: 0, externalHashCount: 0 };
  }

  // CSP meta tag injection disabled — CSP is handled by the middleware header.
  // Adding a meta tag CSP creates a second policy that conflicts with the
  // nonce-based header CSP (browser enforces both, scripts must pass both).
  //
  // const existingCSP = $('meta[http-equiv="Content-Security-Policy"]');
  // if (existingCSP.length > 0) {
  //   console.warn("CSP meta tag already exists, skipping...");
  //   return {
  //     modifiedHtml: html,
  //     inlineHashCount:
  //       internalScriptHashes.size +
  //       internalStyleHashes.size +
  //       inlineStyleAttributeHashes.size,
  //     externalHashCount: externalScriptHashes.size + externalStyleHashes.size,
  //   };
  // }
  //
  // let cspContent = "default-src 'self'";
  //
  // if (
  //   internalScriptHashes.size ||
  //   externalScriptHashes.size ||
  //   preloadScriptHashes.size
  // ) {
  //   cspContent += ";script-src-elem 'strict-dynamic' ";
  //   const allScriptHashes = new Set([
  //     ...internalScriptHashes,
  //     ...externalScriptHashes,
  //     ...preloadScriptHashes,
  //   ]);
  //   cspContent += [...allScriptHashes.values()].join(" ");
  // }
  //
  // if (
  //   internalStyleHashes.size ||
  //   externalStyleHashes.size ||
  //   preloadStyleHashes.size
  // ) {
  //   cspContent += ";style-src-elem 'self' ";
  //   const styleElementHashes = new Set([
  //     ...internalStyleHashes,
  //     ...externalStyleHashes,
  //     ...preloadStyleHashes,
  //   ]);
  //   cspContent += [...styleElementHashes.values()].join(" ");
  // }
  //
  // if (inlineStyleAttributeHashes.size) {
  //   cspContent += ";style-src-attr 'unsafe-hashes' ";
  //   cspContent += [...inlineStyleAttributeHashes.values()].join(" ");
  // }
  //
  // cspContent += ";img-src 'self' data:;";
  //
  // const metaTag = `<meta http-equiv="Content-Security-Policy" content="${cspContent}">`;
  // $("head").prepend(metaTag);

  return {
    modifiedHtml: $.html(),
    inlineHashCount: internalScriptHashes.size + internalStyleHashes.size,
    externalHashCount:
      externalScriptHashes.size +
      externalStyleHashes.size +
      preloadScriptHashes.size +
      preloadStyleHashes.size,
  };
}

/**
 * Process an HTML file
 * @param {string} filePath - Path to the HTML file
 */
function injectCSPMetaTagInHtml(filePath) {
  console.group(`Processing HTML: ${filePath}`);

  const html = fs.readFileSync(filePath, "utf-8");
  const baseDir = process.cwd();
  const { modifiedHtml, inlineHashCount, externalHashCount } = processHTML(
    html,
    baseDir,
  );

  if (inlineHashCount > 0 || externalHashCount > 0) {
    fs.writeFileSync(filePath, modifiedHtml);
    const messages = [];
    if (inlineHashCount > 0) messages.push(`${inlineHashCount} CSP hash(es)`);
    if (externalHashCount > 0)
      messages.push(`${externalHashCount} integrity attribute(s)`);
    console.info(
      `Added ${messages.join(" and ")} in ${path.basename(filePath)}`,
    );
    console.groupEnd();
    return { inlineHashCount, externalHashCount };
  } else {
    console.warn("No changes made");
    console.groupEnd();
    return { inlineHashCount: 0, externalHashCount: 0 };
  }
}

/**
 * Process an OpenNext cache file
 * @param {string} filePath - Path to the cache file
 */
function injectCSPMetaTagInCache(filePath) {
  console.group(`Processing Cache: ${filePath}`);

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const cacheData = JSON.parse(content);

    if (!cacheData.html || typeof cacheData.html !== "string") {
      console.warn("No HTML content found in cache file");
      console.groupEnd();
      return { inlineHashCount: 0, externalHashCount: 0 };
    }

    const baseDir = process.cwd();
    const { modifiedHtml, inlineHashCount, externalHashCount } = processHTML(
      cacheData.html,
      baseDir,
    );

    if (inlineHashCount > 0 || externalHashCount > 0) {
      cacheData.html = modifiedHtml;
      fs.writeFileSync(filePath, JSON.stringify(cacheData));
      const messages = [];
      if (inlineHashCount > 0) messages.push(`${inlineHashCount} CSP hash(es)`);
      if (externalHashCount > 0)
        messages.push(`${externalHashCount} integrity attribute(s)`);
      console.info(
        `Added ${messages.join(" and ")} in ${path.basename(filePath)}`,
      );
      console.groupEnd();
      return { inlineHashCount, externalHashCount };
    } else {
      console.warn("No changes made");
      console.groupEnd();
      return { inlineHashCount: 0, externalHashCount: 0 };
    }
  } catch (error) {
    console.error(`Error processing cache file: ${error.message}`);
    console.groupEnd();
    return { inlineHashCount: 0, externalHashCount: 0 };
  }
}

console.info("Starting CSP meta tag injection...\n");

const htmlPatterns = [
  "out/**/*.html",
  ".next/server/app/**/*.html",
  ".next/static/**/*.html",
  ".next/server/pages/**/*.html",
  ".next/standalone/.next/server/app/**/*.html",
  ".next/standalone/.next/server/pages/**/*.html",
];

const cachePatterns = [".open-next/cache/*/*.cache"];

let allHtmlFiles = [];
let allCacheFiles = [];

console.group("Scanning for files");

for (const pattern of htmlPatterns) {
  const files = glob.sync(pattern);
  console.info(`HTML Pattern "${pattern}": found ${files.length} file(s)`);
  allHtmlFiles = allHtmlFiles.concat(files);
}

for (const pattern of cachePatterns) {
  const files = glob.sync(pattern);
  console.info(`Cache Pattern "${pattern}": found ${files.length} file(s)`);
  allCacheFiles = allCacheFiles.concat(files);
}

console.groupEnd();

allHtmlFiles = [...new Set(allHtmlFiles)];
allCacheFiles = [...new Set(allCacheFiles)];

const totalFiles = allHtmlFiles.length + allCacheFiles.length;

console.info(
  `\nFound ${allHtmlFiles.length} HTML file(s) and ${allCacheFiles.length} cache file(s) to process`,
);

if (totalFiles === 0) {
  console.warn(
    "No files found. Make sure to run this after `next build` or deployment preparation",
  );
  process.exit(0);
}

let totalInlineHashes = 0;
let totalExternalHashes = 0;
let filesModified = 0;

console.group("\nProcessing HTML files");
allHtmlFiles.forEach((file) => {
  const { inlineHashCount, externalHashCount } = injectCSPMetaTagInHtml(file);
  if (inlineHashCount > 0 || externalHashCount > 0) {
    totalInlineHashes += inlineHashCount;
    totalExternalHashes += externalHashCount;
    filesModified++;
  }
});
console.groupEnd();

console.group("\nProcessing OpenNext cache files");
allCacheFiles.forEach((file) => {
  const { inlineHashCount, externalHashCount } = injectCSPMetaTagInCache(file);
  if (inlineHashCount > 0 || externalHashCount > 0) {
    totalInlineHashes += inlineHashCount;
    totalExternalHashes += externalHashCount;
    filesModified++;
  }
});
console.groupEnd();

console.info(
  `\nComplete! Added ${totalInlineHashes} CSP hash(es) and ${totalExternalHashes} integrity attribute(s) across ${filesModified} file(s)\n`,
);
