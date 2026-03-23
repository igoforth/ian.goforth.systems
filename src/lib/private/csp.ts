import "server-only";

type CSPOptions = {
  isDev?: boolean | undefined;
};

class CSPBuilder {
  private staticDirectives: Map<string, Set<string>> = new Map();
  private options: CSPOptions;
  private isSealed = false;

  constructor(options: CSPOptions = {}) {
    this.options = {
      isDev: options.isDev ?? process.env.NODE_ENV === "development",
    };
  }

  seal(): this {
    this.isSealed = true;
    return this;
  }

  private addToDirective(
    directivesMap: Map<string, Set<string>>,
    directive: string,
    ...values: string[]
  ): void {
    if (!directivesMap.has(directive))
      directivesMap.set(directive, new Set());
    const directiveSet = directivesMap.get(directive)!;
    values.forEach((value) => value.trim() && directiveSet.add(value));
  }

  private addStaticDirective(directive: string, ...values: string[]): this {
    if (this.isSealed)
      throw new Error(
        "Cannot modify static directives after seal() has been called",
      );

    if (!this.staticDirectives.has(directive))
      this.staticDirectives.set(directive, new Set());

    const directiveSet = this.staticDirectives.get(directive)!;
    values.forEach((value) => {
      if (value.trim()) directiveSet.add(value.trim());
    });

    return this;
  }

  defaultSrc(...sources: string[]): this {
    return this.addStaticDirective("default-src", ...sources);
  }
  scriptSrc(...sources: string[]): this {
    return this.addStaticDirective("script-src", ...sources);
  }
  scriptSrcElem(...sources: string[]): this {
    return this.addStaticDirective("script-src-elem", ...sources);
  }
  scriptSrcAttr(...sources: string[]): this {
    return this.addStaticDirective("script-src-attr", ...sources);
  }
  styleSrc(...sources: string[]): this {
    return this.addStaticDirective("style-src", ...sources);
  }
  imgSrc(...sources: string[]): this {
    return this.addStaticDirective("img-src", ...sources);
  }
  connectSrc(...sources: string[]): this {
    return this.addStaticDirective("connect-src", ...sources);
  }
  fontSrc(...sources: string[]): this {
    return this.addStaticDirective("font-src", ...sources);
  }
  frameSrc(...sources: string[]): this {
    return this.addStaticDirective("frame-src", ...sources);
  }
  mediaSrc(...sources: string[]): this {
    return this.addStaticDirective("media-src", ...sources);
  }
  objectSrc(...sources: string[]): this {
    return this.addStaticDirective("object-src", ...sources);
  }
  baseUri(...sources: string[]): this {
    return this.addStaticDirective("base-uri", ...sources);
  }
  formAction(...sources: string[]): this {
    return this.addStaticDirective("form-action", ...sources);
  }
  frameAncestors(...sources: string[]): this {
    return this.addStaticDirective("frame-ancestors", ...sources);
  }
  upgradeInsecureRequests(): this {
    return this.addStaticDirective("upgrade-insecure-requests");
  }

  build(requestOptions: { nonce?: string | undefined } = {}): string {
    const requestDirectives = new Map<string, Set<string>>();

    for (const [directive, values] of this.staticDirectives.entries())
      requestDirectives.set(
        directive,
        new Set(
          Array.from(values).filter((value) => !value.startsWith("'nonce-")),
        ),
      );

    const nonce = requestOptions.nonce;
    if (nonce)
      this.addToDirective(
        requestDirectives,
        "script-src",
        `'nonce-${nonce}'`,
      );

    return Array.from(requestDirectives.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([directive, values]) =>
          `${directive} ${Array.from(values)
            .filter((v) => v)
            .join(" ")}`,
      )
      .join(";")
      .replace(/\s+/g, " ")
      .trim()
      .concat(";");
  }

  static createDefault(options: CSPOptions = {}): CSPBuilder {
    return new CSPBuilder(options)
      .defaultSrc("'none'")
      .connectSrc("'self'", "https://cloudflareinsights.com")
      .scriptSrc(
        "'strict-dynamic'",
        options.isDev ? "'unsafe-eval'" : "",
        "'unsafe-inline'",
        "https:",
      )
      .scriptSrcElem(
        "'self'",
        "'unsafe-inline'",
        "https://static.cloudflareinsights.com",
      )
      .scriptSrcAttr("'none'")
      .styleSrc("'self'", "'unsafe-inline'")
      .imgSrc("'self'", "data:")
      .mediaSrc("'self'")
      .fontSrc("'self'")
      .frameSrc("'none'")
      .objectSrc("'none'")
      .baseUri("'none'")
      .formAction("'self'")
      .frameAncestors("'none'")
      .upgradeInsecureRequests()
      .seal();
  }
}

export { CSPBuilder };
