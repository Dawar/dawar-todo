import createDOMPurify from "dompurify";
export type DocumentLink = { href: string; label: string };
export function safeDocumentLink(value: string) {
  try {
    // No relative/app-host URLs (including other ports), credentials, javascript,
    // data, blob or local files. Host-only app cookies must not cross a port.
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hostname === window.location.hostname) return null;
    return url.href;
  } catch { return null; }
}
export function staticHtml(text: string): { srcDoc: string; links: DocumentLink[] } {
  const purifier = createDOMPurify(window), links: DocumentLink[] = [];
  purifier.addHook("afterSanitizeAttributes", node => {
    if (node.nodeName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(src)) node.removeAttribute("src");
    }
    if (node.nodeName === "A") {
      const href = node.getAttribute("href") ?? "", safe = safeDocumentLink(href);
      if (safe && links.length < 100 && !links.some(link => link.href === safe)) links.push({ href: safe, label: (node.textContent?.trim() || safe).slice(0, 200) });
      // Even explicit frame navigation could load an app URL. Only inert text
      // remains here; reviewed links open from the enclosing application UI.
      node.removeAttribute("href");
    }
  });
  const content = purifier.sanitize(text, {
    ALLOWED_TAGS: ["style", "main", "article", "section", "header", "footer", "aside", "nav", "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "u", "s", "small", "mark", "sub", "sup", "blockquote", "pre", "code", "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "img", "a", "details", "summary"],
    ALLOWED_ATTR: ["style", "class", "id", "title", "alt", "src", "href", "width", "height", "colspan", "rowspan", "scope", "open", "start", "reversed"],
    ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true, FORCE_BODY: true,
  });
  // Policy precedes untrusted content. Sandbox has NO lifted restrictions.
  // CSS may style this opaque-origin frame only. CSP blocks CSS imports/URLs
  // as well as every other implicit remote or relative resource request.
  const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'";
  return { links, srcDoc: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}<style>html{color-scheme:light;background:#fff;color:#27332c;font:16px/1.65 system-ui,sans-serif}body{margin:0;padding:24px;overflow-wrap:anywhere}*,*::before,*::after{box-sizing:border-box;animation:none!important;transition:none!important}img{max-width:100%;height:auto}pre,table{display:block;max-width:100%;overflow:auto}pre{white-space:pre}a{color:#286b45}body>*,main,article,section{max-width:100%}@media(max-width:500px){body{padding:16px}body,main,article,section{min-width:0!important;width:auto!important}}</style></body></html>` };
}
