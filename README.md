# Search in Your Language (userscript)

Press **Tab** in any search box to reach a small translate button, then **Enter** or **Space** to translate your keyword into your browser's primary language. It feels like the site gained a button right after its search box.

Works on Google, YouTube, Wikipedia, Bing, Amazon, DuckDuckGo, and most other sites. It finds search boxes by `type="search"`, `role="searchbox"`/`[role=search]`, common query names (`q`, `search_query`, `wd`, …), and search-like ids, placeholders, and form actions.

## Usage

1. Install a userscript manager (Tampermonkey or Violentmonkey), then install it from [Greasy Fork](https://greasyfork.org/scripts/597648-search-in-your-language).
2. Type in a search box. A small chip appears, for example `Tab ⇥ 日本語 猫のビデオ`.
3. Keys:
   - **Tab** in the search box: focus the translate button.
   - **Enter** or **Space** on the button: apply the translation and return to the box, so another Enter runs the search. The button then offers **↩ original**.
   - **Tab** on the button: move on to whatever followed the search box. **Shift+Tab** or **Esc**: back to the box.
   - **Esc** in the box: hide the button so Tab behaves as usual.
   - **Click the button**: same as Enter.

## Target language

- The target is `navigator.languages[0]`, your browser's primary language.
- If you already typed in that language, the script offers your next browser language instead. When there is no next language, it offers English.
- You can override the target from the userscript menu with **Set target language…**.

## Translation

It uses Chrome's built-in on-device `Translator` + `LanguageDetector` APIs when the language pair is available (Chrome 138+). Otherwise it falls back to Google Translate's public endpoints through `GM_xmlhttpRequest`. Results are cached per query.

Based on [google-bilingual-search-enja](https://gist.github.com/snomiao/ecee0271ac7599d526aaa210293e3f43).

## Slack Translate Draft

[`slack-translate-draft.user.js`](./slack-translate-draft.user.js) is a separate script for Slack's message box. Install it from [Greasy Fork](https://greasyfork.org/scripts/597657-slack-translate-draft).

- **Tab** in the message box focuses a translate button; **Enter** or **Space** applies it and returns you to the draft. **Alt+T** does the same in one key. Use either again to restore the original.
- While Slack's :emoji:/@mention autocomplete is open, or inside a list or code block, Tab keeps doing what Slack uses it for.
- **Esc**: hide the preview chip.
- **Formatting is kept.** Bold, italic, strike, lists and quotes stay as they are. Inline code, code blocks, links, @mentions, #channels and emoji are passed through untouched.
- **Target language**: the most common language among the channel's visible messages that differs from your draft, detected on-device. If the channel is all in your draft's language, the target is your own browser language instead. You can override it from the userscript menu.
