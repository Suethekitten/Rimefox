# Rimefox Privacy Policy

This policy describes Rimefox 0.8.2 (last updated: 2026-10-18). Rimefox is a bring-your-own-key browser translation extension. The author operates no translation server, receives no translation requests, and uses no analytics, telemetry or third-party tracking SDKs. Rimefox does not sell data or use it for advertising or creditworthiness decisions. This does not mean that translation data never leaves your device.

## Information sent for translation

Translation requests go directly to the API endpoint you configure. They may include webpage text selected for full-page translation, text you select, text you type or paste into the popup, and YouTube caption text when subtitle translation is enabled. Full-page translation normally processes text near the viewport; disabling lazy translation can process the whole page. If you enable automatic translation, eligible text can be sent without a separate click on each page. Content scripts also run in subframes, so text in embedded frames is transmitted under the same rules when translated.

When the optional local masking feature is enabled, reliably detectable values (email addresses, phone numbers, ID card numbers and bank card numbers, optionally Chinese names in explicit contexts) are replaced with `__PII_<TYPE>_<n>__` placeholders before the request is sent; only the placeholder text is transmitted. See “Optional local masking” below.

Requests also include the target language, translation instructions including your custom prompt, and matching glossary source terms and specified translations. Your API key is sent to the configured endpoint in authentication headers. Connection tests send fixed sample sentences; model-list requests also authenticate to that endpoint. The provider receives normal network metadata such as your IP address. Do not translate sensitive content or put secrets into prompts unless you trust the configured endpoint.

The only recipient is the endpoint you configure (for example DeepSeek, an OpenAI-compatible service, Anthropic, Gemini, Ollama, or your own gateway); the author and other third parties do not receive this data. If you enter an `http://` endpoint, data is transmitted in clear text; use HTTPS unless the endpoint is on your own machine.

DeepSeek, OpenAI or OpenAI-compatible services, Anthropic, Gemini and custom gateways handle requests under their own privacy policies and retention practices. A compatible gateway is not necessarily operated by the named model vendor. Review the policy of the actual endpoint operator, including training, logging, retention and deletion terms.

## Optional local masking

Off by default. When enabled in Settings → Privacy, the extension masks sensitive values locally before translation and restores them locally afterwards:

- The placeholder-to-value mapping exists only in memory for the duration of one translation request. It is never written to chrome.storage or the configuration, never exported, never logged, and never sent with any request.
- No permission is added and no WASM, ONNX runtime or remote model is downloaded.
- If the model drops, rewrites or invents a placeholder, the affected segment is treated as a failed translation: the page keeps the source text and retries with the existing backoff, rather than displaying corrupted content or using source text as a translation.
- Scope is limited to fixed-format data. Addresses, organizations, passwords, seed phrases and private keys are not masked. Chinese names are detected only in explicit contexts such as “Name:” or “I am …”, are off by default, and may still be missed or misidentified.
- Translation caching is unchanged: short source/translation pairs may still be stored in the local disk cache under the existing rules; the mapping itself is never cached.

## Limited Use

Rimefox's use of user data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the translation features described in this policy and to maintain, secure and measure those features. It is not sold, not used for personalized advertising or creditworthiness decisions, and is not read by humans except as required for security or legal compliance.

## YouTube captions

Subtitle translation is off by default. A packaged MAIN-world script nevertheless loads locally on www.youtube.com, m.youtube.com and www.youtube-nocookie.com to observe caption responses already loaded by the player and pass text to the extension. When necessary, the extension may request a same-origin YouTube caption URL to retrieve an original-language track. Enabling subtitle translation sends relevant caption text near the playback position to your configured translation API. It does not upload video or audio to that API. This is an unofficial feature, unaffiliated with YouTube or Google, and depends on interfaces that may change.

## Local storage and retention

| Information | Storage and retention |
|---|---|
| API keys, provider configuration, glossary and custom prompts | chrome.storage.local, retained until edited, removed or the extension is uninstalled. These fields may be transmitted as described above. |
| Interface language and theme | Local settings only; the theme is also cached in the extension page's localStorage to prevent flashing. |
| Appearance, site rules, night-mode site list and custom translation CSS | chrome.storage.local, local settings only and not sent with translation requests; appearance choices are also cached in the extension page's localStorage to prevent flashing. |
| Translation cache containing source and translated text | In-memory cache and chrome.storage.session; session storage is cleared when the browser session ends. A bounded short-text cache persists in chrome.storage.local (512 KB budget; source plus translation at most 160 characters per entry). Capacity eviction applies, with no fixed retention period. Cache keys include site scope, not a browsing-history log. |
| Per-tab translation resume state | chrome.storage.session; removed on tab close. |

The extension restricts local extension storage to trusted extension contexts where supported. Its content scripts receive configuration without API keys. Keys are not encrypted in an exported configuration file; local storage is not a password vault.

## Your controls

Clear translation caches in Settings under the cache/migration section. Edit or remove saved provider keys, glossary terms and custom prompts in Settings; check all saved providers. Uninstalling removes extension-owned local storage. Revoke a key with its provider if a copy has been exposed. Clearing local data does not erase data already retained by your provider; contact that provider for deletion requests.

Diagnostic output is copied locally only when requested and can contain the current page URL and text fragments. Review it before posting. Configuration exports include keys only if you explicitly choose that option. Exported files and clipboard copies are outside extension storage and must be deleted separately.

## Access and excluded uses

Rimefox does not access browser history or browse unopened sites in the background. Page translation skips input and editable controls; text you deliberately submit in the popup or select for translation is processed as described above. It does not read browser cookie or password databases. Same-origin YouTube caption requests may include browser credentials. The broad host permission supports translation on user-opened pages and requests to user-selected endpoints; the general content script excludes Google Accounts and Chrome Web Store pages. This exclusion is not a network firewall or a guarantee about an endpoint you manually configure.

## Contact

Use the public GitHub Issues page at https://github.com/Suethekitten/Rimefox/issues for privacy questions. Never post API keys, private page text or unredacted diagnostic output. Use the repository's private vulnerability-reporting channel for security reports, as described in SECURITY.md. The repository and its Issues page are public and require no login to read.
