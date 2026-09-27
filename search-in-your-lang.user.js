// ==UserScript==
// @name               Search in Your Language
// @name:zh            用你的语言搜索
// @name:ja            あなたの言語で検索
// @namespace          snomiao@gmail.com
// @author             snomiao@gmail.com
// @version            0.2.0
// @description        [snolab] Press Tab in any search box (Google, YouTube, Wikipedia, Bing, Amazon, ...) to translate your keyword into your browser's primary language, Tab again to switch back. Uses Chrome's on-device Translator API when available.
// @description:zh     [snolab] 在任意搜索框中按 Tab 把关键词翻译成浏览器首选语言，再按 Tab 切回原文。优先使用 Chrome 内置翻译 API。
// @description:ja     [snolab] どの検索ボックスでも Tab でキーワードをブラウザの第一言語に翻訳、もう一度 Tab で元に戻す。Chrome 内蔵翻訳 API を優先使用。
// @match              *://*/*
// @run-at             document-idle
// @noframes
// @grant              GM_xmlhttpRequest
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @connect            clients5.google.com
// @connect            translate.googleapis.com
// @license            MIT
// ==/UserScript==

(function main() {
    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const gmGet = (k, d) => (typeof GM_getValue === "function" ? GM_getValue(k, d) : d);
    const norm = (t = "") => {
        const [b, ...r] = t.toLowerCase().split(/[-_]/);
        return b === "zh" ? (r.some((x) => /^(tw|hk|mo|hant)$/.test(x)) ? "zh-TW" : "zh-CN") : b;
    };
    const langs = () => [...new Set([gmGet("targetLang", ""), ...navigator.languages, "en"].filter(Boolean).map(norm))];
    const langName = (c) => new Intl.DisplayNames([navigator.language], { type: "language" }).of(c) || c;
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    typeof GM_registerMenuCommand === "function" &&
        GM_registerMenuCommand("Set target language…", () => {
            const v = prompt(`Target language (ja, en, zh-CN…), empty = browser (${navigator.languages})`, gmGet("targetLang", ""));
            v !== null && (GM_setValue("targetLang", v.trim()), cache.clear());
        });

    // translate: Chrome built-in Translator first (on-device), then Google endpoints
    const getJson = (url) =>
        typeof GM_xmlhttpRequest !== "function"
            ? fetch(url).then((r) => r.json())
            : new Promise((ok, ng) =>
                  GM_xmlhttpRequest({ url, timeout: 8e3, onerror: ng, ontimeout: ng, onload: (r) => { try { ok(JSON.parse(r.responseText)); } catch (e) { ng(e); } } }));
    let detector;
    // short keywords detect poorly ("cat videos" → la 79%, en 10%), so prefer a candidate among the user's langs
    const detect = async (q) => {
        const cands = (await (await (detector ??= W.LanguageDetector?.create().catch(() => null)))?.detect(q)) || [];
        return norm((cands.find((c) => c.confidence > 0.05 && langs().includes(norm(c.detectedLanguage))) || cands[0])?.detectedLanguage);
    };
    const translators = {};
    const providers = [
        async (q, to, from) => {
            if (!W.Translator || !from || from === "und") throw 0;
            const key = from + ">" + to;
            return { text: await (await (translators[key] ??= W.Translator.create({ sourceLanguage: from, targetLanguage: to }).catch((e) => (delete translators[key], Promise.reject(e))))).translate(q), from };
        },
        async (q, to) => {
            const [[text, from]] = await getJson(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${to}&q=${encodeURIComponent(q)}`);
            return { text, from: norm(from) };
        },
        async (q, to) => {
            const d = await getJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(q)}`);
            return { text: d[0].map((s) => s[0]).join(""), from: norm(d[2]) };
        },
    ];
    const tr = async (q, to, from) => {
        for (const p of providers) try { const r = await p(q, to, from); if (r.text) return r; } catch {}
        throw new Error("translate failed");
    };
    const cache = new Map();
    const translate = (q) =>
        cache.get(q) ??
        cache.set(q, (async () => {
            const [primary, ...rest] = langs();
            const from = await detect(q).catch(() => "");
            // already in primary lang → offer next preferred lang (usually en)
            const to = from === primary ? rest.find((l) => l !== from) : primary;
            let r = to && { ...(await tr(q, to, from)), to };
            // no local detector: learn source lang from the remote result, retry if it was already primary
            const to2 = r && !from && (r.from === primary || same(r.text, q)) && rest.find((l) => l !== r.from);
            if (to2) r = { ...(await tr(q, to2, r.from)), to: to2 };
            return r && !same(r.text, q) ? r : null;
        })().catch((e) => (cache.delete(q), Promise.reject(e)))).get(q);

    // search box detection
    const NAMES = /^(q|query|search|search_query|searchtext|keywords?|field-keywords|wd|word|kw|k|p|s|terms?|search-input)$/i;
    const HINT = /search|query|keyword|検索|搜索|搜尋|검색|suche|recherche|buscar|pesquis|cerca|поиск|zoek/i;
    const isSearchBox = (el) => {
        if (!el || el.disabled || el.readOnly || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return false;
        const type = (el.getAttribute("type") || "text").toLowerCase(), form = el.closest("form");
        if (el.tagName === "INPUT" && type === "search") return true;
        if (el.tagName === "INPUT" ? type !== "text" : !NAMES.test(el.name) && !el.closest("[role=search], form[action*=search]")) return false;
        return el.role === "searchbox" || el.enterKeyHint === "search" || NAMES.test(el.name) || !!el.closest("[role=search]") ||
            HINT.test([el.id, el.name, el.className, el.placeholder, el.ariaLabel, el.title, form?.getAttribute("action"), form?.id, form?.className].join(" "));
    };
    const setValue = (el, v) => {
        let p = el, d;
        while (p && !(d = Object.getOwnPropertyDescriptor(p, "value"))) p = Object.getPrototypeOf(p);
        d.set.call(el, v); // native setter so React/Vue notice
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.setSelectionRange?.(v.length, v.length);
    };

    // chip UI (no innerHTML: YouTube enforces Trusted Types)
    const h = (tag, className, textContent = "") => Object.assign(document.createElement(tag), { className, textContent });
    const host = Object.assign(document.createElement("div"), { id: "search-in-your-lang-chip" });
    Object.assign(host.style, { position: "fixed", zIndex: 2147483647, top: 0, left: 0, display: "none" });
    const root = host.attachShadow({ mode: "open" }), sheet = new CSSStyleSheet();
    sheet.replaceSync(`.chip{font:13px/1.4 system-ui,sans-serif;display:flex;gap:6px;align-items:center;max-width:min(520px,90vw);padding:4px 8px;border-radius:8px;cursor:pointer;user-select:none;background:#202124;color:#e8eaed;box-shadow:0 2px 8px #0005;border:1px solid #5f6368}
        .key{font-size:11px;padding:0 5px;border:1px solid #9aa0a6;border-radius:4px;color:#bdc1c6}.lang{color:#8ab4f8}.text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.busy .text{opacity:.6;font-style:italic}`);
    root.adoptedStyleSheets = [sheet];
    const [chip, langEl, textEl] = [h("div", "chip"), h("span", "lang"), h("span", "text")];
    chip.append(h("span", "key", "Tab ⇥"), langEl, textEl), root.append(chip);

    // state
    let box = null, original = "", result = null, pending = null, applied = false, dismissed = false, timer = 0, selfInput = false;
    const shown = () => host.style.display !== "none";
    const render = () => {
        const [lang, text] = !box || dismissed || !box.value.trim() ? [] : applied ? ["↩", original] : result ? [langName(result.to), result.text] : pending ? ["", "translating…"] : [];
        if (text === undefined) return (host.style.display = "none");
        host.isConnected || document.documentElement.append(host);
        chip.classList.toggle("busy", !result && !applied);
        [langEl.textContent, textEl.textContent, host.style.display] = [lang, text, "block"];
        position();
    };
    const position = () => {
        if (!box || !shown()) return;
        const r = box.getBoundingClientRect(), { offsetWidth: w, offsetHeight: ch } = chip;
        const top = r.bottom + 4 + ch <= innerHeight ? r.bottom + 4 : Math.max(0, r.top - ch - 4);
        host.style.transform = `translate(${Math.round(Math.max(0, Math.min(r.right - w, innerWidth - w - 4)))}px,${Math.round(top)}px)`;
    };
    const schedule = () => {
        clearTimeout(timer), (result = null);
        const q = original.trim(), job = q ? new Promise((ok) => (timer = setTimeout(ok, 250))).then(() => translate(q)) : null;
        (pending = job), render();
        job?.then((r) => pending === job && ((result = r), (pending = null), render()), (e) => pending === job && (console.warn("[search-in-your-lang]", e), (pending = null), render()));
    };
    const bound = new WeakSet();
    const attach = (el) => {
        if (box === el) return;
        [box, original, applied, dismissed] = [el, el.value, false, false];
        bound.has(el) || (bound.add(el), el.addEventListener("input", () => !selfInput && el === box && (([original, applied, dismissed] = [el.value, false, false]), schedule())));
        schedule();
    };
    const detach = () => (clearTimeout(timer), (box = pending = null), render());
    const apply = (v) => { selfInput = true; try { setValue(box, v); } finally { selfInput = false; } box.focus(); };
    const toggle = async () => {
        if (applied) return apply(original), (applied = false), render();
        const el = box, r = result || (await pending?.catch(() => null));
        if (r && el === box) apply(r.text), (applied = true), render();
    };

    // events
    const deep = (e) => e.composedPath?.()[0] || e.target;
    const active = () => document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    document.addEventListener("focusin", (e) => (isSearchBox(deep(e)) ? attach(deep(e)) : deep(e) !== box && detach()), true);
    document.addEventListener("focusout", (e) => deep(e) === box && setTimeout(() => box && active() !== box && detach(), 150), true);
    window.addEventListener("keydown", (e) => {
        if (!box || deep(e) !== box || e.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape" && shown()) return (dismissed = true), render(); // site still gets Escape
        if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !shown()) return;
        e.preventDefault(), e.stopImmediatePropagation(), toggle();
    }, true);
    chip.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in box
    chip.addEventListener("click", toggle);
    let raf = 0;
    const reposition = () => (cancelAnimationFrame(raf), (raf = requestAnimationFrame(position)));
    addEventListener("scroll", reposition, true), addEventListener("resize", reposition);
    isSearchBox(active()) && attach(active()); // autofocused box
})();
