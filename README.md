# Andrew Solberg

Personal GitHub Website

[book database](library_semantic_search.html)

Library Search runs in your browser and keeps its catalog and embeddings on your device. Import a catalog or ISBNs, review source text, then select **Build embeddings**. Existing saved contents are migrated into **Summary & contents**; changed summaries need to be indexed again. **Bibliography** indexes actual cited-source lists separately.

Expand a book's chapter dropdown to select independently indexed chapters. PDF outlines, contents, and repository chapter metadata can create chapter entries; **Add chapter** also supports manual entry. Chapter text and references remain attached to their parent book in backups and saved applets.

Choose additional ISBN sources in **Add PDF / metadata**. Public options include Library of Congress, HathiTrust, Crossref, OAPEN, DOAB, BnF, and Internet Archive. Google Books, DPLA, and Europeana use API keys; WorldCat uses an institutional OAuth access token. Credentials last only for the current page session and are excluded from exports. Repository coverage and browser cross-origin access vary; failures are reported per source while successful lookups are retained.

For database access through the local helper, open **Start Library Search.cmd** on Windows, or run:

```text
node library_search_server.cjs
```

Use the app at **http://127.0.0.1:8765/library_semantic_search.html** and keep the helper running. It relays supported metadata requests from your computer, avoiding the cross-origin restrictions that affect direct browser lookups. The helper listens only on the local computer, serves only this app, and does not store API credentials. It requires Node.js 20 or newer and no additional packages. A basic static server does not provide this relay.

Browser storage is separate for each website address. Before moving from the hosted site or a saved HTML copy, select **Export data**, then import that JSON backup in the local app. Your original browser catalog remains available at its original address.

Lookup results distinguish **Matched**, **No edition match**, and **Could not query**. An edition miss is normal for repositories with limited coverage. API errors and blocked requests are reported separately instead of being counted as misses.

The local helper resolves browser cross-origin failures; repositories may still refuse a request. Live verification with ISBN `9780262621632` matched Open Library, returned edition misses from the other queried catalogs, and received HTTP 403 from OAPEN and DOAB. Those refusals are shown as access errors. Their repository operators [document bot protection and allowlisting](https://oapen.org/blog/?link=https://oapen.hypotheses.org/2287); the helper does not bypass those controls.

Run regression checks with Node.js 20 or newer:

```text
node --test tests/library_semantic_search.test.cjs
node --test tests/library_search_server.test.cjs
```

XML and interface checks use the bundled runtime in the `local-web-testing` Codex skill. Set `LIBRARY_TEST_SKILL_DIR` if that skill is installed outside its default location. Those checks report a skip when the runtime is unavailable. They simulate browser behavior and do not verify graphical layout or live repository access.
