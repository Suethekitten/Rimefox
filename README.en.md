<p align="center">
  <img src="icons/source.png" width="96" height="96" alt="Rimefox" />
</p>

<h1 align="center">Rimefox · Bilingual Translation</h1>

<p align="center"><a href="README.md" hreflang="zh-CN">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/manifest-v3-6f42c1" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Chrome%20%2F%20Edge-114%2B-4285F4" alt="Chrome / Edge 114+" />
</p>

<p align="center">Read the original and translation together using your own API key.</p>

Rimefox is a Manifest V3 extension for Chrome and Edge. Translation requests go directly to the endpoint you configure. Load the extension as-is, with no build step.

## Features

- **Bilingual web pages.** Read the original and translation together, or switch to translation-only mode. Supported inline formatting and links can be preserved.
- **Your choice of provider.** Use an OpenAI-compatible endpoint, Anthropic Claude, or Google Gemini. Presets include DeepSeek, Zhipu GLM, Qwen, Kimi, SiliconFlow, and OpenRouter. You can also connect to Ollama, LM Studio, or a custom gateway.
- **On-demand translation.** By default, Rimefox translates content near the viewport. It batches requests, limits concurrency, caches results, and retries rate limits and server errors. While translation is active, new content on dynamic pages is picked up automatically.
- **Reading tools.** Compare translations on hover, translate selected text or text in an input field, translate a snippet in the popup, or pin a translation in a separate window.
- **Bilingual video subtitles.** Enable **Bilingual video subtitles** in Settings, then turn on subtitles in the YouTube or Bilibili player. This unofficial feature is off by default. See [subtitle support and limitations](docs/VIDEO-SUBTITLES.md).
- **Local documents.** Import DRM-free, reflowable EPUB 2/3 files, PDF, TXT, Markdown, or LOG. Read in bilingual, translation-only, or side-by-side view where available. PDF translation is in beta. Scanned pages can use an [optional local OCR connector](native/ocr-host/README.md).
- **Glossary and translation preferences.** Set preferred translations with context and exceptions, add custom instructions and target languages, or choose a style. Optional AI-enhanced translation can include limited article context. An optional medical profile prioritizes reviewed terminology.
- **Privacy and appearance.** Optional local masking replaces supported sensitive values before transmission. The popup, Settings, and welcome guide support Chinese and English. Adjust the theme, translation typography, and site rules in Settings.

## Install

Download `Rimefox-v<version>.zip` from [GitHub Releases](https://github.com/Suethekitten/Rimefox/releases/latest), extract it, and load the `Rimefox` folder. You can also load the repository directory containing `manifest.json`.

| Step | Chrome | Edge |
|---|---|---|
| Open the extensions page | `chrome://extensions/` | `edge://extensions/` |
| Enable Developer mode | Turn on **Developer mode** | Turn on **Developer mode** |
| Load the extension | Click **Load unpacked** and select the `Rimefox` folder | Click **Load unpacked** and select the `Rimefox` folder |

To upgrade an unpacked installation, replace the files in the same folder and click **Reload** on the extensions page. Keeping the same folder preserves your settings and device-remembered keys. Session keys need to be entered again after reloading. For older DualTrans installations and configuration migration, see the [upgrade guide](docs/UPGRADING.md).

## Quick start

1. Click **Open settings** in the first-run welcome guide. Choose a provider or add a custom one, then enter the API URL and key.
2. Click **Fetch models** and select a model, or enter a model name manually. **Test connection** saves the current form before it sends a test request.
3. Open a regular web page. Click the Rimefox toolbar icon, then **Translate this page**, or use the default shortcut `Alt+A` (`Option+A` on Mac). Press the shortcut again to restore the original. The default shortcut for translating text inside an input field is `Alt+I` (`Option+I` on Mac).
4. If the shortcut does not work, check **Browser shortcut** under **Shortcuts** in Settings. If it is unset, click **Set in browser** and assign a shortcut.

Pin Rimefox from your browser’s extensions menu for quick access. To translate local `file://` pages, enable **Allow access to file URLs** in the extension’s details. You can reopen the **User guide** from the Settings sidebar at any time. To read a local document, choose **Documents** at the bottom of the popup.

## Privacy and compatibility

- Chrome and Edge 114 or later are supported. Browser-internal pages and extension store pages cannot be translated.
- API keys are kept for the current browser session by default. To keep a key across browser restarts, enable **Remember the key on this device**. See the [English privacy policy](docs/privacy.en.md) for details on what is sent and what is stored.
- Subtitle translation requires an accessible subtitle track. Burned-in captions are outside its scope. YouTube live captions are experimental.
- EPUB support covers reflowable books without DRM. The [reader guide](docs/READER-ARCHITECTURE.md) describes supported formats, and the [PDF guide](docs/PDF-HANDOFF.md) covers PDF layout and scanning limits.
- Inline formatting is preserved where it can be mapped reliably. Complex page layouts or links may keep the original text.

## Reporting a problem

1. Update to the [latest release](https://github.com/Suethekitten/Rimefox/releases) and check that the problem still happens.
2. If a web page is translated incorrectly or the layout breaks, open **Settings → Advanced → Page diagnostics**, choose the affected page, and click **Run diagnostics**. The diagnostic JSON is copied to your clipboard. No translation requests are sent.
3. Open a [new issue](https://github.com/Suethekitten/Rimefox/issues/new/choose) and choose the bug report form. The form is in Chinese, but you can answer in English. Include the version, browser, steps to reproduce, and the diagnostics. The diagnostics contain the page address and some page text, so remove anything private first. Never include an API key.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Project documentation

Most technical guides are in Chinese.

| Document | What it covers |
|---|---|
| [Changelog](CHANGELOG.md) | Changes in each release |
| [Roadmap](docs/ROADMAP.md) | Priorities, planned work, and known limitations |
| [Support and validation](docs/SUPPORT.md) | Platform and feature acceptance criteria |
| [Maintainer handoff](HANDOFF.md) | Architecture, testing, debugging, and release workflow |
| [Translation engine](docs/TRANSLATION-ENGINE-HANDOFF.md) | Translation units, rendering, and restoration |
| [Glossary guide](docs/GLOSSARY.md) | Preferred terms, notes, and exceptions |
| [Security](SECURITY.md) | How to report a security issue privately |

## License and credits

Rimefox is licensed under [MIT](LICENSE). Third-party sources and licenses, including the bundled PDF.js, are listed in [third-party notices](THIRD-PARTY-NOTICES.md). The popup’s glass dock adapts [Sak’s Liquid Glass Slider](https://github.com/Saknutella/liquid-glass-slider).

Rimefox is an independent project. Its subtitle integrations are unofficial and are not affiliated with YouTube, Google, or Bilibili.
