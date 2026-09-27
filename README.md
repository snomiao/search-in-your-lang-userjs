# Search in Your Language (userscript)

Press **Tab** in any search box to reach a small translate button, then **Space** to cycle your keyword through your browser languages and **Enter** to keep one. It feels like the site gained a button right after its search box.

Works on Google, YouTube, Wikipedia, Bing, Amazon, DuckDuckGo, and most other sites. It finds search boxes by `type="search"`, `role="searchbox"`/`[role=search]`, common query names (`q`, `search_query`, `wd`, …), and search-like ids, placeholders, and form actions.

## Usage

1. Install a userscript manager (Tampermonkey or Violentmonkey), then install it from [Greasy Fork](https://greasyfork.org/scripts/597648-search-in-your-language).
2. Type in a search box. A small chip appears, for example `Tab ⇥ Français Vidéos de chat`.
3. Press **Tab** to focus it. It opens a language bar, `orig [fr] ja zh-CN ru`, and the search box updates as you move:

   | Key on the button | Does | Focus |
   |---|---|---|
   | **Space** / **→** | next language (after the last one: back to the original) | stays |
   | **←** | previous language | stays |
   | **0**–**9** | jump to the N-th language (0 = original) | stays |
   | **Enter** / **Shift+Tab** | keep the current text | back to the box, so Enter searches |
   | **Esc** | undo this round: restore the text from before you entered the button | back to the box |
   | **Tab** | keep the current text and move on to whatever followed the search box | leaves |

   - **Esc** in the box hides the chip, so Tab behaves as usual.
   - **Click** a language in the bar (shown on hover) to jump to it.

## Languages

- The script cycles through your browser languages (`navigator.languages`), then English, skipping the language you typed in.
- A language whose translation comes back unchanged (like "iPhone") or fails is crossed out and skipped.
- Every language is translated from your original text, never from the previous translation, so meaning doesn't drift.
- To cycle fewer languages, set a comma list like `ja,en,zh-CN` from the userscript menu with **Set languages…**.

## Translation

It uses Chrome's built-in on-device `Translator` + `LanguageDetector` APIs when the language pair is available (Chrome 138+). Otherwise it falls back to Google Translate's public endpoints through `GM_xmlhttpRequest`. Results are cached per query.

Based on [google-bilingual-search-enja](https://gist.github.com/snomiao/ecee0271ac7599d526aaa210293e3f43).

## Slack Translate Draft

[`slack-translate-draft.user.js`](./slack-translate-draft.user.js) is a separate script for Slack's message box. Install it from [Greasy Fork](https://greasyfork.org/scripts/597657-slack-translate-draft).

- **Tab** in the message box focuses the translate button. The keys are the same as the search script's: **Space**/**←**/**→**/digits cycle, **Enter** keeps the draft and returns to it without sending, and **Esc** undoes.
- While Slack's :emoji:/@mention autocomplete is open, or inside a list or code block, Tab keeps doing what Slack uses it for.
- **Esc** in the message box hides the chip.
- **Formatting is kept.** Bold, italic, strike, lists and quotes stay as they are. Inline code, code blocks, links, @mentions, #channels and emoji are passed through untouched.
- **Languages**: the language bar lists the channel's languages first, then yours, separated by `|`, for example `orig [ja] en | fr zh-CN ru`. Channel languages are the ones making up at least a quarter of the last visible messages, detected on-device. Your draft's own language is left out. **Set languages…** in the userscript menu replaces the list with your own.
