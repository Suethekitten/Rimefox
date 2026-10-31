# Rimefox Privacy Policy

Last updated: 2026-10-27. Rimefox is a bring-your-own-key browser translation extension. The author operates no translation server, receives no translation requests, and uses no analytics, telemetry or third-party tracking SDKs. Rimefox does not sell data or use it for advertising or creditworthiness decisions. This does not mean that translation data never leaves your device.

## Information sent for translation

Translation requests go directly to the API endpoint you configure. They may include webpage text selected for full-page translation, text you select, text you type or paste into the popup, text you translate in a webpage text box with the shortcut or context menu, YouTube or Bilibili caption text when subtitle translation is enabled, and EPUB body text near the current viewport or the current chapter when you explicitly use the reader's translate action. Full-page translation normally processes text near the viewport; disabling lazy translation can process the whole page. If you enable automatic translation, eligible text can be sent without a separate click on each page. Content scripts also run in subframes, so text in embedded frames is transmitted under the same rules when translated. EPUB files, images, covers, table of contents, footnotes metadata and reading progress are not uploaded.

When the optional local masking feature is enabled, reliably detectable values (email addresses, phone numbers, ID card numbers and bank card numbers, optionally Chinese names in explicit contexts) are replaced with `__PII_<TYPE>_<n>__` placeholders before the request is sent; only the placeholder text is transmitted. See “Optional local masking” below.

Paragraphs whose inline formatting must be preserved carry a few plain-text markers in the text sent (for example `<f1>`, `</f1>`, `<k1></k1>`). `<fN>` marks formatting positions; `<kN>` only marks where non-translated content sits, and that content itself is not sent.

Requests also include the target language, translation instructions including your custom prompt, and matching glossary source terms and specified translations. When you use a custom target language, its name, optional language code and translation note are sent as language preferences. Your API key is sent to the configured endpoint in authentication headers. Connection tests send fixed sample sentences; model-list requests also authenticate to that endpoint. The provider receives normal network metadata such as your IP address. Do not translate sensitive content or put secrets into prompts unless you trust the configured endpoint.

AI-enhanced translation (“AI 精翻”) is off by default. When enabled, full-page translation requests may additionally include the current article title, section headings, explicit abbreviation definitions from the same article, and a limited number of adjacent body paragraphs from the same article container, subject to length and count limits. It does not send the whole page, navigation, comments, ads, hidden content or editor drafts.

The only recipient is the endpoint you configure (for example DeepSeek, an OpenAI-compatible service, Anthropic, Gemini, Ollama, or your own gateway); the author and other third parties do not receive this data. If you enter an `http://` endpoint, data is transmitted in clear text; use HTTPS unless the endpoint is on your own machine.

DeepSeek, OpenAI or OpenAI-compatible services, Anthropic, Gemini and custom gateways handle requests under their own privacy policies and retention practices. A compatible gateway is not necessarily operated by the named model vendor. Review the policy of the actual endpoint operator, including training, logging, retention and deletion terms.

## Optional local masking

Off by default. When enabled in Settings → Privacy, the extension masks sensitive values locally before translation and restores them locally afterwards:

- The placeholder-to-value mapping exists only in memory for the duration of one translation request. It is never written to chrome.storage or the configuration, never exported, never logged, and never sent with any request.
- No permission is added and no WASM, ONNX runtime or remote model is downloaded.
- Paragraphs with inline formatting (bold, links and similar) are masked locally in the same way before sending.
- If the model drops, rewrites or invents a placeholder, the affected segment is treated as a failed translation: the page keeps the source text and retries with the existing backoff, rather than displaying corrupted content or using source text as a translation.
- Scope is limited to fixed-format data. Addresses, organizations, passwords, seed phrases and private keys are not masked. Chinese names are detected only in explicit contexts such as “Name:” or “I am …”, are off by default, and may still be missed or misidentified.
- Translation caching is unchanged: short source/translation pairs may still be stored in the local disk cache under the existing rules; the mapping itself is never cached.
- While masking is on, AI-enhanced translation context (title, headings, abbreviations, adjacent paragraphs) is not sent at all, because the extension cannot guarantee the same masking for that context. That translation falls back to ordinary context and the degraded state is recorded.

## Limited Use

Rimefox's use of user data complies with the user data policy of the Microsoft Edge Add-ons website, including the Limited Use requirements. Data is used only to provide the translation features described in this policy and to maintain, secure and measure those features. It is not sold, not used for personalized advertising or creditworthiness decisions, and is not read by humans except as required for security or legal compliance. The same limited-use commitments apply wherever the extension is distributed.

## Video captions (YouTube / Bilibili)

Subtitle translation is off by default. A packaged MAIN-world script nevertheless loads locally on the listed YouTube / youtube-nocookie pages and on Bilibili video pages to observe subtitle metadata already loaded by the player. Enabling subtitle translation sends caption text near the playback position to your configured translation API; only about the next 90 seconds are sent. When necessary, the extension may request a same-origin YouTube caption URL for an original-language track, or request a Bilibili subtitle file from an allow-listed official HTTPS subtitle CDN. The Bilibili request is made by the extension service worker without cookies, and redirects outside the allow-list are rejected. This is an unofficial compatibility feature, unaffiliated with YouTube, Google or Bilibili, and depends on site interfaces that may change.

## Local storage and retention

| Information | Storage and retention |
|---|---|
| API keys, provider configuration, glossary and custom prompts | chrome.storage.local, retained until edited, removed or the extension is uninstalled. These fields may be transmitted as described above. |
| Interface language and theme | Local settings only; the theme is also cached in the extension page's localStorage to prevent flashing. |
| Appearance, site rules, night-mode site list and custom translation CSS | chrome.storage.local, local settings only and not sent with translation requests; appearance choices are also cached in the extension page's localStorage to prevent flashing. |
| Translation cache containing source and translated text | In-memory cache and chrome.storage.session; session storage is cleared when the browser session ends. A bounded short-text cache persists in chrome.storage.local (512 KB budget; source plus translation at most 160 characters per entry). Capacity eviction applies, with no fixed retention period. Cache keys include site scope, not a browsing-history log. Video caption translations are keyed per video, part and track and are kept only in memory and chrome.storage.session; they are never written to chrome.storage.local. |
| EPUB book file, cover, reading progress and per-book translations | Extension-page IndexedDB database `rimefox-reader`, local only. About 100 MB per book and 500 MB per library; deleting a book removes its file, progress and translations. EPUB body text is not written to the global translation cache. |
| User-uploaded reading font | Extension-page IndexedDB `rimefox-reader` (`fonts`), local only and never uploaded. Removing the font deletes the stored blob. |
| Per-tab translation resume state | chrome.storage.session; removed on tab close. |

The extension restricts local extension storage to trusted extension contexts where supported. Its content scripts receive configuration without API keys. Keys are not encrypted in an exported configuration file; local storage is not a password vault.

## Your controls

Clear translation caches in Settings under the cache/migration section. Edit or remove saved provider keys, glossary terms and custom prompts in Settings; check all saved providers. Uninstalling removes extension-owned local storage. Revoke a key with its provider if a copy has been exposed. Clearing local data does not erase data already retained by your provider; contact that provider for deletion requests.

Diagnostic output is copied locally only when requested and can contain the current page URL and text fragments. Review it before posting. Configuration exports include keys only if you explicitly choose that option. Exported files and clipboard copies are outside extension storage and must be deleted separately.

## Access and excluded uses

Rimefox does not access browser history or browse unopened sites in the background. Page translation skips input and editable controls; text you deliberately submit in the popup, select for translation, or translate in a webpage text box with the shortcut or context menu is processed as described above. It does not read browser cookie or password databases. Same-origin YouTube caption requests may include browser credentials; Bilibili subtitle-CDN requests are sent without cookies. Bilibili subtitle support adds no browser permissions: it reuses the existing broad host permission and scripting permission. The broad host permission supports translation on user-opened pages and requests to user-selected endpoints; the general content script excludes Google Accounts and Chrome Web Store pages. This exclusion is not a network firewall or a guarantee about an endpoint you manually configure.

## Contact

Use the public GitHub Issues page at https://github.com/Suethekitten/Rimefox/issues for privacy questions. Never post API keys, private page text or unredacted diagnostic output. Use the repository's private vulnerability-reporting channel for security reports, as described in SECURITY.md. The repository and its Issues page are public and require no login to read.
