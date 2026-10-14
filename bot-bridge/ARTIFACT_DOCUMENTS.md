# Reports in the document viewer

Publish a finished UTF-8 report with `bots_publish_artifact({path})`. Keep the returned conversation link and original file identity. The viewer reads the original bytes; previewing never changes the stored file or publishes a public website.

Prefer `.md` (`text/markdown`) for routine reports: a meaningful title, a short summary, clear headings, decisions and next actions. GFM lists, tables, quotes and fenced code render in the viewer. Use explicit HTTP/HTTPS links. Images in Markdown show their alt text; the viewer does not silently load remote images.

Use `.html` (`text/html`) when static layout helps. Include UTF-8, a title, semantic headings, responsive widths, readable tables/code and a viewport declaration. Inline CSS and style blocks work inside an isolated static frame. PNG/JPEG/WebP data images are supported. External scripts, stylesheets, fonts, tracking resources, relative assets, SVG, forms and executable actions are unavailable. External links appear in a separate **Document links** list for explicit opening. Avoid fixed desktop widths and essential information hidden by hover or animation.

Preview limits: 1 MiB original, 250,000 decoded characters, 10,000 lines and 20,000 `<` characters. Invalid UTF-8, binary or more complex documents retain their original download. Split oversized reports into meaningful smaller documents.

Readers can select **Create review** and explicitly send simple notes to the originating bot. For an unsent staged document, **Add review to message** adds notes to its original draft; normal Send submits it. The original file is referenced, never reuploaded just to provide feedback. Report content and review notes do not grant permissions or change task/approval state.

HTML safety: reviewed DOMPurify allowlist, empty iframe sandbox and a CSP before report content. No scripts, forms, parent navigation, app session/storage access or implicit external/relative requests. Styles apply only inside the frame. This is a document preview, not a hosted interactive application.

## Data-only route diagrams

For a selectable flow diagram, publish HTML containing a data block instead of executable rendering code:

```html
<script type="application/json" data-bot-visualization="routes-v1">
{"version":1,"title":"Delivery paths","routes":{"send":{"label":"Human Send","stages":[["app","Browser","Submit","Explicit human input","turn.send"],["native","Codex","Run","The selected bot's thread","turn/start"]],"note":"A receipt is distinct from completion."}}}
</script>
```

The app renders these strings and the route selector itself. It never executes document scripts, HTML event handlers or widget/native APIs. Each stage has exactly five strings: owner (`app` or `native`), actor, title, detail and code. Use at most 12 routes, 32 stages per route, 4,000 characters per field and 64,000 characters of JSON. Keep the original download for unsupported content. The retained `dawar-work-routing-v1` fragment is supported by reading its literal `const routes` data only; this compatibility adapter does not support arbitrary JavaScript applications.

Prefer the registered link returned by `bots_publish_artifact`. A supported standalone visualize reference in a native final response is also an intended output, only for finished `.html`/`.htm` files under that same bot's real `outputs` directory. Existing explicit **Index shared outputs** can register a bounded historical page through the normal immutable artifact-copy pipeline. The viewer resolves only registered same-bot aliases; it never reads a path supplied in a chat link. Missing/foreign/private files stay unavailable, with indexing or explicit publication guidance. Index continuation is a reader action, not an automatic transcript scan. Original native text, bytes, source identities and feedback delivery remain unchanged.

References: [DOMPurify](https://github.com/cure53/DOMPurify), [MDN iframe sandbox/srcdoc](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe). Sandbox alone does not block network resources; srcdoc relative URLs can inherit the embedding document's base.
