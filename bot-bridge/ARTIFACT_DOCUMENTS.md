# Reports in the document viewer

Publish a finished UTF-8 report with `bots_publish_artifact({path})`. Keep the returned conversation link and original file identity. The viewer reads the original bytes; previewing never changes the stored file or publishes a public website.

Prefer `.md` (`text/markdown`) for routine reports: a meaningful title, a short summary, clear headings, decisions and next actions. GFM lists, tables, quotes and fenced code render in the viewer. Use explicit HTTP/HTTPS links. Images in Markdown show their alt text; the viewer does not silently load remote images.

Use `.html` (`text/html`) when static layout helps. Include UTF-8, a title, semantic headings, responsive widths, readable tables/code and a viewport declaration. Inline CSS and style blocks work inside an isolated static frame. PNG/JPEG/WebP data images are supported. External scripts, stylesheets, fonts, tracking resources, relative assets, SVG, forms and executable actions are unavailable. External links appear in a separate **Document links** list for explicit opening. Avoid fixed desktop widths and essential information hidden by hover or animation.

Preview limits: 1 MiB original, 250,000 decoded characters, 10,000 lines and 20,000 `<` characters. Invalid UTF-8, binary or more complex documents retain their original download. Split oversized reports into meaningful smaller documents.

Readers can select **Create review** and explicitly send simple notes to the originating bot. For an unsent staged document, **Add review to message** adds notes to its original draft; normal Send submits it. The original file is referenced, never reuploaded just to provide feedback. Report content and review notes do not grant permissions or change task/approval state.

HTML safety: reviewed DOMPurify allowlist, empty iframe sandbox and a CSP before report content. No scripts, forms, parent navigation, app session/storage access or implicit external/relative requests. Styles apply only inside the frame. This is a document preview, not a hosted interactive application.

References: [DOMPurify](https://github.com/cure53/DOMPurify), [MDN iframe sandbox/srcdoc](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe). Sandbox alone does not block network resources; srcdoc relative URLs can inherit the embedding document's base.
