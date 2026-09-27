// ==UserScript==
// @name               Slack Translate Draft
// @name:zh            Slack 草稿翻译
// @name:ja            Slack 下書き翻訳
// @namespace          snomiao@gmail.com
// @author             snomiao@gmail.com
// @version            0.2.0
// @description        [snolab] In Slack's message box, press Tab to reach a translate button and Enter/Space (or just Alt+T) to translate your draft into the channel's language, keeping bold/italic/code/links/mentions/emoji. Alt+T again to switch back. Uses Chrome's on-device Translator as fallback.
// @description:zh     [snolab] 在 Slack 输入框按 Tab 聚焦翻译按钮再按 Enter/空格（或直接 Alt+T），把草稿翻译成频道所用语言，保留粗体/代码/链接/提及/表情；再按 Alt+T 切回原文。
// @description:ja     [snolab] Slack の入力欄で Tab → 翻訳ボタンで Enter/スペース（または Alt+T）を押すと下書きをチャンネルの言語に翻訳（太字・コード・リンク・メンション・絵文字を保持）。もう一度 Alt+T で元に戻す。
// @match              https://app.slack.com/*
// @run-at             document-idle
// @grant              unsafeWindow
// @grant              GM_xmlhttpRequest
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @connect            clients5.google.com
// @license            MIT
// @homepageURL        https://github.com/snomiao/search-in-your-lang-userjs
// @supportURL         https://github.com/snomiao/search-in-your-lang-userjs/issues
// ==/UserScript==

(function main() {
    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const gmGet = (k, d) => (typeof GM_getValue === "function" ? GM_getValue(k, d) : d);
    const norm = (t = "") => {
        const [b, ...r] = t.toLowerCase().split(/[-_]/);
        return b === "zh" ? (r.some((x) => /^(tw|hk|mo|hant)$/.test(x)) ? "zh-TW" : "zh-CN") : b;
    };
    const myLangs = () => [...new Set([...navigator.languages, "en"].map(norm))];
    const langName = (c) => new Intl.DisplayNames([navigator.language], { type: "language" }).of(c) || c;
    typeof GM_registerMenuCommand === "function" &&
        GM_registerMenuCommand("Set target language…", () => {
            const v = prompt("Target language (ja, en, zh-CN…), empty = auto-detect from channel messages", gmGet("targetLang", ""));
            v !== null && (GM_setValue("targetLang", v.trim()), cache.clear());
        });

    // ---------- language detection (on-device) ----------
    let detector;
    const detectAll = async (s) => (await (await (detector ??= W.LanguageDetector?.create().catch(() => null)))?.detect(s)) || [];
    // short text detects poorly ("cat videos" → la), so prefer a candidate among the user's langs
    const detect = async (s) => {
        const cs = await detectAll(s);
        return norm((cs.find((c) => c.confidence > 0.05 && myLangs().includes(norm(c.detectedLanguage))) || cs[0])?.detectedLanguage);
    };
    // channel languages: detected over the last visible messages, most common first, with share of votes
    const channelLangs = async () => {
        const votes = {};
        const msgs = [...document.querySelectorAll("[data-qa=message-text]")].slice(-20);
        for (const el of msgs) {
            const l = norm((await detectAll(el.innerText.slice(0, 500)))[0]?.detectedLanguage);
            l && l !== "und" && (votes[l] = (votes[l] || 0) + 1);
        }
        return Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([l, n]) => [l, n / msgs.length]);
    };
    const pickTarget = async (from) => {
        const fixed = norm(gmGet("targetLang", ""));
        if (fixed) return fixed !== from ? fixed : myLangs().find((l) => l !== from);
        // mixed channel (en+ja) and I wrote en → ja; channel all in my draft's lang → my own lang (to double-check)
        return (await channelLangs()).find(([l, share]) => l !== from && share >= 0.25)?.[0] || myLangs().find((l) => l !== from);
    };

    // ---------- translation of inline-HTML (tags + placeholders survive) ----------
    const getJson = (url) =>
        typeof GM_xmlhttpRequest !== "function"
            ? fetch(url).then((r) => r.json())
            : new Promise((ok, ng) =>
                  GM_xmlhttpRequest({ url, timeout: 1e4, onerror: ng, ontimeout: ng, onload: (r) => { try { ok(JSON.parse(r.responseText)); } catch (e) { ng(e); } } }));
    const translators = {};
    const providers = [
        // Google keeps tags best and translates inside them
        async (html, to, from) => {
            const d = await getJson(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&format=html&sl=${from || "auto"}&tl=${to}&q=${encodeURIComponent(html)}`);
            const x = d[0];
            return Array.isArray(x) ? x[0] : x;
        },
        async (html, to, from) => {
            if (!W.Translator || !from) throw 0;
            const k = from + ">" + to;
            return (await (translators[k] ??= W.Translator.create({ sourceLanguage: from, targetLanguage: to }).catch((e) => (delete translators[k], Promise.reject(e))))).translate(html);
        },
    ];
    const tr = async (html, to, from) => {
        for (const p of providers) try { const r = await p(html, to, from); if (r) return r; } catch {}
        throw new Error("translate failed");
    };

    // ---------- Quill delta <-> inline HTML ----------
    const TAGS = { bold: "b", italic: "i", strike: "s", underline: "u" };
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const unesc = (s) => s.replace(/&(#x?[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) =>
        e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[e.toLowerCase()]);
    /** split delta ops into lines: [{ segs: ops[], nl: op }] — line formats (list/quote/code-block) live on the "\n" op */
    const toLines = (ops) => {
        const lines = [];
        let segs = [];
        for (const op of ops) {
            if (typeof op.insert !== "string") { segs.push(op); continue; }
            op.insert.split("\n").forEach((t, i, a) => {
                t && segs.push({ ...op, insert: t });
                if (i < a.length - 1) lines.push({ segs, nl: { ...op, insert: "\n" } }), (segs = []);
            });
        }
        segs.length && lines.push({ segs, nl: null });
        return lines;
    };
    // embeds (emoji/mention/channel), inline code and links become opaque placeholders
    const isText = (op) => typeof op?.insert === "string" && !op.attributes?.code && !op.attributes?.link;
    const lineToHtml = (segs, keep) =>
        segs.map((op, i) => {
            // remember spacing around placeholders: translators drop it ("voirthe docs")
            if (!isText(op)) return `<x-p id=${keep.push({ op, pre: /\s$/.test(segs[i - 1]?.insert ?? ""), post: /^\s/.test(segs[i + 1]?.insert ?? "") }) - 1}></x-p>`;
            return Object.entries(TAGS).reduce((s, [a, t]) => (op.attributes?.[a] ? `<${t}>${s}</${t}>` : s), esc(op.insert));
        }).join("");
    const htmlToSegs = (html, keep) => {
        const out = [], on = {}, used = new Set();
        let space = false;
        const endsSpace = () => { const t = out.at(-1); return !t || typeof t.insert !== "string" || /\s$/.test(t.insert); };
        const tag2attr = Object.fromEntries(Object.entries(TAGS).map(([a, t]) => [t, a]));
        for (const [, close, tag, id, text] of html.matchAll(/<(\/?)(b|i|s|u)\s*>|<x-p\s+id="?(\d+)"?\s*>\s*<\/x-p\s*>|([^<]+|<)/gi)) {
            if (tag) close ? delete on[tag2attr[tag.toLowerCase()]] : (on[tag2attr[tag.toLowerCase()]] = true);
            else if (id !== undefined) {
                const k = keep[id];
                if (!k || used.has(id)) continue;
                used.add(id), k.pre && !endsSpace() && out.push({ insert: " " }), out.push(k.op), (space = k.post);
            } else {
                let t = unesc(text);
                if (space && !/^[\s.,!?;:)\]}、。，．！？」』）]/.test(t)) t = " " + t;
                if (out.length && !isText(out.at(-1))) t = t.replace(/^\s+(?=[.,!?;:)\]}、。，．！？」』）])/, ""); // "code , x" → "code, x"
                (space = false), out.push({ insert: t, ...(Object.keys(on).length && { attributes: { ...on } }) });
            }
        }
        keep.forEach((k, i) => used.has(String(i)) || out.push({ insert: " " }, k.op)); // never lose a mention
        return out;
    };
    const cache = new Map();
    const translateDelta = (ops) => {
        const key = JSON.stringify(ops) + gmGet("targetLang", "");
        if (cache.has(key)) return cache.get(key);
        const job = (async () => {
            const text = ops.map((o) => (typeof o.insert === "string" ? o.insert : " ")).join("").trim();
            if (!text) return null;
            const from = await detect(text).catch(() => "");
            const to = await pickTarget(from);
            if (!to) return null;
            const lines = await Promise.all(toLines(ops).map(async ({ segs, nl }) => {
                const keep = [], html = lineToHtml(segs, keep);
                const skip = nl?.attributes?.["code-block"] || !segs.some((o) => isText(o) && o.insert.trim());
                return [...(skip ? segs : htmlToSegs(await tr(html, to, from), keep)), ...(nl ? [nl] : [])];
            }));
            const out = lines.flat();
            return { ops: out, to, text: out.map((o) => (typeof o.insert === "string" ? o.insert : "·")).join("").trim() };
        })();
        job.catch(() => cache.delete(key));
        cache.set(key, job);
        return job;
    };

    // ---------- chip UI: a real <button>, Tab from the composer lands on it ----------
    const h = (tag, className, textContent = "") => Object.assign(document.createElement(tag), { className, textContent });
    const host = Object.assign(document.createElement("div"), { id: "slack-translate-draft-chip" });
    Object.assign(host.style, { position: "fixed", zIndex: 2147483647, top: 0, left: 0, display: "none" });
    const root = host.attachShadow({ mode: "open" }), sheet = new CSSStyleSheet();
    sheet.replaceSync(`.chip{font:13px/1.4 system-ui,sans-serif;display:flex;gap:6px;align-items:center;max-width:min(560px,80vw);padding:4px 8px;border-radius:8px;cursor:pointer;user-select:none;background:#1a1d21;color:#e8eaed;box-shadow:0 2px 8px #0005;border:1px solid #5f6368;text-align:left}
        .chip:focus-visible{outline:2px solid #8ab4f8;outline-offset:1px}.k2,.chip:focus .k1{display:none}.chip:focus .k2{display:inline}.key{font-size:11px;padding:0 5px;border:1px solid #9aa0a6;border-radius:4px;color:#bdc1c6;white-space:nowrap}.lang{color:#8ab4f8;white-space:nowrap}.text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.busy .text{opacity:.6;font-style:italic}`);
    root.adoptedStyleSheets = [sheet];
    const [chip, langEl, textEl] = [h("button", "chip"), h("span", "lang"), h("span", "text")];
    chip.append(h("span", "key k1", "Tab ⇥ / Alt+T"), h("span", "key k2", "Enter ⏎"), langEl, textEl), root.append(chip);

    // ---------- state ----------
    let quill = null, editor = null, original = null, result = null, pending = null, applied = false, dismissed = false, timer = 0, selfChange = false;
    const quillOf = (el) => { const c = el?.closest?.(".ql-editor")?.parentElement; return (c?.wrappedJSObject || c)?.__quill; };
    const render = () => {
        const has = quill && quill.getText().trim();
        const [lang, text] = !quill || dismissed || !has ? [] : applied ? ["↩", "original"] : result ? [langName(result.to), result.text] : pending ? ["", "translating…"] : [];
        if (text === undefined) return (host.style.display = "none");
        host.isConnected || document.documentElement.append(host);
        chip.classList.toggle("busy", !result && !applied);
        [langEl.textContent, textEl.textContent, host.style.display] = [lang, text, "block"];
        chip.ariaLabel = applied ? "Restore original draft" : result ? `Translate draft to ${lang}: ${text}` : text;
        position();
    };
    const position = () => {
        if (!editor || host.style.display === "none") return;
        const box = (editor.closest("[data-qa=message_input]") || editor).getBoundingClientRect();
        host.style.transform = `translate(${Math.round(Math.max(0, box.right - chip.offsetWidth))}px,${Math.round(Math.max(0, box.top - chip.offsetHeight - 6))}px)`;
    };
    const schedule = () => {
        clearTimeout(timer), (result = null);
        const ops = original.ops, job = quill.getText().trim() ? new Promise((ok) => (timer = setTimeout(ok, 700))).then(() => translateDelta(ops)) : null;
        (pending = job), render();
        job?.then((r) => pending === job && ((result = r), (pending = null), render()), (e) => pending === job && (console.warn("[slack-translate-draft]", e), (pending = null), render()));
    };
    const onChange = () => {
        if (selfChange) return;
        [original, applied, dismissed] = [quill.getContents(), false, false];
        schedule();
    };
    const attach = (el) => {
        const q = quillOf(el);
        if (!q) return;
        if (q === quill) return render();
        quill?.off("text-change", onChange);
        [quill, editor, original, applied, dismissed] = [q, el.closest(".ql-editor"), q.getContents(), false, false];
        quill.on("text-change", onChange);
        schedule();
    };
    const setDelta = (ops) => {
        selfChange = true;
        try { quill.setContents(ops, "user"); quill.setSelection(quill.getLength(), 0, "user"); } finally { selfChange = false; }
    };
    const toggle = async () => {
        if (!quill) return;
        const q = quill;
        if (applied) setDelta(original.ops), (applied = false);
        else {
            const r = result || (await pending?.catch(() => null));
            if (q !== quill) return;
            r && (setDelta(r.ops), (applied = true));
        }
        q.focus(), render(); // back in the composer: Enter now sends
    };
    const nextTabbable = (from) =>
        [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex],[contenteditable]")].find((el) =>
            el.tabIndex >= 0 && !el.disabled && !from.contains(el) && from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && el.getClientRects().length);
    // Tab belongs to Slack while completing :emoji:/@name or inside a list/code block
    const tabIsSlacks = () => document.querySelector("[data-qa=texty_autocomplete_menu]") || ["list", "code-block"].some((f) => quill.getFormat()[f]);

    // ---------- events ----------
    document.addEventListener("focusin", (e) => (quillOf(e.target) ? attach(e.target) : null), true);
    document.addEventListener("focusout", () => setTimeout(() => !quillOf(document.activeElement) && document.activeElement !== host && (host.style.display = "none"), 150), true);
    window.addEventListener("keydown", (e) => {
        if (!quill || !quillOf(e.target) || e.isComposing) return;
        if (e.key === "Escape" && host.style.display !== "none") return (dismissed = true), render();
        if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && host.style.display !== "none" && !tabIsSlacks())
            return e.preventDefault(), e.stopImmediatePropagation(), chip.focus(); // Tab: composer → button
        if (e.code !== "KeyT" || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault(), e.stopImmediatePropagation();
        dismissed = false;
        toggle();
    }, true);
    chip.addEventListener("keydown", (e) => {
        e.stopPropagation(); // keep Slack's global hotkeys away from the button
        if (e.key === "Enter" || e.key === " ") return e.preventDefault(), toggle();
        if (e.key === "Escape" || (e.key === "Tab" && e.shiftKey)) return e.preventDefault(), quill?.focus(); // back to the composer
        if (e.key === "Tab") { const n = editor && nextTabbable(editor); n && (e.preventDefault(), n.focus()); }
    });
    chip.addEventListener("mousedown", (e) => e.preventDefault()); // mouse click keeps focus in composer
    chip.addEventListener("click", (e) => e.detail && toggle()); // detail=0 → keyboard click, already handled
    addEventListener("resize", () => requestAnimationFrame(position));
    quillOf(document.activeElement) && attach(document.activeElement);
})();
