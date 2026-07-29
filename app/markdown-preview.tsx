"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

function safeMarkdownUrl(url: string) {
  const normalized = url.trim();
  if (!normalized) return "";
  if (/^(?:https?:|mailto:|tel:|#|\/)/i.test(normalized)) {
    return defaultUrlTransform(normalized);
  }
  return "";
}

export function MarkdownPreview({
  value,
  emptyText = "Nothing to preview yet.",
}: {
  value: string;
  emptyText?: string;
}) {
  if (!value.trim()) {
    return (
      <div className="grid min-h-28 place-items-center rounded-xl border border-dashed border-black/[0.1] bg-[#fafbf9] px-4 py-6 text-sm text-[#8a918d]">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="min-h-28 overflow-x-auto rounded-xl border border-black/[0.1] bg-[#fafbf9] px-4 py-3 text-sm leading-6 text-[#303632]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={safeMarkdownUrl}
        components={{
          h1: ({ children }) => <h1 className="mb-3 mt-1 text-2xl font-semibold text-[#202522]">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-5 text-xl font-semibold text-[#202522] first:mt-1">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-[#202522] first:mt-1">{children}</h3>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-3 border-[#8cb6a0] bg-[#eef5f0] px-3 py-1 text-[#4f5752]">{children}</blockquote>,
          hr: () => <hr className="my-5 border-black/[0.08]" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith("#") ? undefined : "_blank"}
              rel={href?.startsWith("#") ? undefined : "noreferrer noopener"}
              className="font-medium text-[#216e4e] underline decoration-[#216e4e]/35 underline-offset-2 hover:decoration-[#216e4e]"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => className ? (
            <code className={`${className} block min-w-max font-mono text-xs`}>{children}</code>
          ) : (
            <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
          ),
          pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-xl bg-[#202522] p-3 text-[#f6f7f5]">{children}</pre>,
          table: ({ children }) => <table className="my-3 min-w-full border-collapse text-left text-xs">{children}</table>,
          th: ({ children }) => <th className="border border-black/[0.1] bg-[#eef0ed] px-2 py-1.5 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-black/[0.1] px-2 py-1.5 align-top">{children}</td>,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
