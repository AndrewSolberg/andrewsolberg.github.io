# Andrew Solberg

Personal GitHub Website

[book database](library_semantic_search.html)

Library Search runs in your browser and keeps its catalog and embeddings on your device. Import a catalog or ISBNs, review source text, then select **Build embeddings**. Existing saved contents are migrated into **Summary & contents**; changed summaries need to be indexed again. **Bibliography** indexes actual cited-source lists separately.

Expand a book's chapter dropdown to select independently indexed chapters. PDF outlines, contents, and repository chapter metadata can create chapter entries; **Add chapter** also supports manual entry. Chapter text and references remain attached to their parent book in backups and saved applets.

Choose additional ISBN sources in **Add PDF / metadata**. Public options include Library of Congress, HathiTrust, Crossref, OAPEN, DOAB, BnF, and Internet Archive. Google Books, DPLA, and Europeana use API keys; WorldCat uses an institutional OAuth access token. Credentials last only for the current page session and are excluded from exports. Repository coverage and browser cross-origin access vary; failures are reported per source while successful lookups are retained.

Run regression checks with Node.js 20 or newer:

```text
node --test tests/library_semantic_search.test.cjs
```

XML and interface checks use the bundled runtime in the `local-web-testing` Codex skill. Set `LIBRARY_TEST_SKILL_DIR` if that skill is installed outside its default location. Those checks report a skip when the runtime is unavailable. They simulate browser behavior and do not verify graphical layout or live repository access.
