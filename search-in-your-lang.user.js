// ==UserScript==
// @name               Search in Your Language
// @name:zh            用你的语言搜索
// @name:ja            あなたの言語で検索
// @namespace          snomiao@gmail.com
// @author             snomiao@gmail.com
// @version            0.1.0
// @description        [snolab] Press Tab in any search box (Google, YouTube, Wikipedia, Bing, DuckDuckGo, Amazon, ...) to translate your keyword into your browser's primary language. Press Tab again to switch back.
// @description:zh     [snolab] 在任意搜索框（谷歌、YouTube、维基百科、Bing……）中按 Tab，即可把搜索关键词翻译成浏览器首选语言；再按一次 Tab 切回原文。
// @description:ja     [snolab] どの検索ボックス（Google、YouTube、Wikipedia、Bing など）でも Tab キーで検索キーワードをブラウザの第一言語に翻訳。もう一度 Tab で元に戻す。
// @match              *://*/*
// @run-at             document-idle
// @grant              GM_xmlhttpRequest
// @grant              GM.xmlHttpRequest
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @connect            clients5.google.com
// @connect            translate.googleapis.com
// @connect            api.mymemory.translated.net
// @license            MIT
// @noframes
// ==/UserScript==

(function main() {
    "use strict";

    const DEBOUNCE_MS = 250;
    const HOST_ID = "search-in-your-lang-chip";

    // ---------- settings ----------
    const gmGet = (k, d) => (typeof GM_getValue === "function" ? GM_getValue(k, d) : d);
    const gmSet = (k, v) => typeof GM_setValue === "function" && GM_setValue(k, v);

    /** Google-style language code: "ja-JP" -> "ja", "zh-TW"/"zh-Hant" -> "zh-TW", "zh"/"zh-CN" -> "zh-CN" */
    function normalizeLang(tag) {
        const t = String(tag || "").trim();
        if (!t) return "";
        const [base, ...rest] = t.split(/[-_]/);
        const b = base.toLowerCase();
        if (b === "zh") return rest.some((r) => /^(tw|hk|mo|hant)$/i.test(r)) ? "zh-TW" : "zh-CN";
        if (b === "iw") return "he";
        return b;
    }

    /** Ordered target languages: override (if set), browser languages, then English. */
    function targetLangs() {
        const override = gmGet("targetLang", "");
        const list = [override, ...(navigator.languages || [navigator.language]), "en"]
            .map(normalizeLang)
            .filter(Boolean);
        return [...new Set(list)];
    }

    const langName = (code) => {
        try {
            return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) || code;
        } catch {
            return code;
        }
    };

    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Set target language…", () => {
            const cur = gmGet("targetLang", "") || "";
            const v = prompt(
                `Target language code (e.g. ja, en, zh-CN, fr).\nLeave empty to follow your browser (${navigator.languages.join(", ")}).`,
                cur,
            );
            if (v === null) return;
            gmSet("targetLang", v.trim());
            cache.clear();
        });
    }

    // ---------- translation ----------
    function httpGetJson(url) {
        const gmx =
            (typeof GM_xmlhttpRequest === "function" && GM_xmlhttpRequest) ||
            (typeof GM !== "undefined" && GM.xmlHttpRequest);
        if (!gmx) return fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
        return new Promise((resolve, reject) =>
            gmx({
                method: "GET",
                url,
                timeout: 8000,
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) return reject(new Error(`HTTP ${r.status}`));
                    try {
                        resolve(JSON.parse(r.responseText));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject,
                ontimeout: () => reject(new Error("timeout")),
            }),
        );
    }

    /** Each provider returns { text, from } where `from` is the detected source language (may be ""). */
    const providers = [
        async (q, to) => {
            const u = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${to}&q=${encodeURIComponent(q)}`;
            const d = await httpGetJson(u);
            // shape: [["translated","srcLang"]] or ["translated"]
            const first = Array.isArray(d) ? d[0] : null;
            if (Array.isArray(first)) return { text: first[0], from: first[1] || "" };
            if (typeof first === "string") return { text: first, from: "" };
            throw new Error("bad response");
        },
        async (q, to) => {
            const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(q)}`;
            const d = await httpGetJson(u);
            return { text: d[0].map((s) => s[0]).join(""), from: d[2] || "" };
        },
        async (q, to) => {
            const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=autodetect|${to}`;
            const d = await httpGetJson(u);
            if (d.responseStatus !== 200) throw new Error(d.responseDetails);
            return { text: d.responseData.translatedText, from: d.responseData.detectedLanguage || "" };
        },
    ];

    async function translateRaw(q, to) {
        let err;
        for (const p of providers) {
            try {
                const r = await p(q, to);
                if (r?.text) return { ...r, from: normalizeLang(r.from) };
            } catch (e) {
                err = e;
            }
        }
        throw err || new Error("translation failed");
    }

    const cache = new Map();
    /** Translate into the first preferred language that isn't the query's own language. */
    function translate(q) {
        if (cache.has(q)) return cache.get(q);
        const job = (async () => {
            const langs = targetLangs();
            let r = await translateRaw(q, langs[0]);
            let to = langs[0];
            if (r.from === to || same(r.text, q)) {
                // Already written in the primary language: offer the next one instead (usually English).
                to = langs.find((l) => l !== r.from && l !== langs[0]);
                if (!to) return null;
                r = await translateRaw(q, to);
            }
            if (!r.text || same(r.text, q)) return null;
            return { text: r.text, to };
        })();
        job.catch(() => cache.delete(q));
        cache.set(q, job);
        return job;
    }

    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

    // ---------- search box detection ----------
    const SEARCH_NAMES = new Set([
        "q", "query", "search", "search_query", "searchtext", "search_text", "keyword", "keywords",
        "field-keywords", "wd", "word", "kw", "k", "p", "s", "term", "terms", "search-input",
    ]);
    const SEARCH_HINT = /search|query|keyword|検索|搜索|搜尋|검색|suche|recherche|buscar|pesquis|cerca|поиск|zoek/i;

    function isSearchBox(el) {
        if (!el || el.disabled || el.readOnly) return false;
        const tag = el.tagName;
        if (tag === "TEXTAREA") {
            // Google/Bing use a <textarea> as their main search box
            if (!(SEARCH_NAMES.has((el.name || "").toLowerCase()) || el.closest?.("form[role=search], [role=search], form[action*=search]")))
                return false;
        } else if (tag === "INPUT") {
            const type = (el.getAttribute("type") || "text").toLowerCase();
            if (type === "search") return true;
            if (type !== "text") return false;
        } else return false;

        const role = el.getAttribute("role") || "";
        if (role === "searchbox") return true;
        if (el.getAttribute("enterkeyhint") === "search") return true;
        if (SEARCH_NAMES.has((el.name || "").toLowerCase())) return true;
        const hints = [el.id, el.name, el.className, el.placeholder, el.getAttribute("aria-label"), el.title].join(" ");
        if (SEARCH_HINT.test(hints)) return true;
        const form = el.form || el.closest?.("form");
        if (el.closest?.("[role=search]")) return true;
        if (form && (SEARCH_HINT.test(form.getAttribute("action") || "") || SEARCH_HINT.test(form.id + " " + form.className)))
            return true;
        return false;
    }

    function setNativeValue(el, value) {
        let proto = el;
        let desc;
        while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "value"))) proto = Object.getPrototypeOf(proto);
        desc?.set ? desc.set.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        try {
            el.setSelectionRange(value.length, value.length);
        } catch {}
    }

    // ---------- UI chip (built without innerHTML so it works under Trusted Types, e.g. YouTube) ----------
    const host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, { position: "fixed", zIndex: "2147483647", top: "0", left: "0", display: "none" });
    const root = host.attachShadow({ mode: "open" });
    const css = `
        .chip { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; gap: 6px; align-items: center;
            max-width: min(520px, 90vw); padding: 4px 8px; border-radius: 8px; cursor: pointer; user-select: none;
            background: #202124; color: #e8eaed; box-shadow: 0 2px 8px rgba(0,0,0,.3); border: 1px solid #5f6368; }
        .key { flex: none; font-size: 11px; padding: 0 5px; border: 1px solid #9aa0a6; border-radius: 4px; color: #bdc1c6; }
        .lang { flex: none; color: #8ab4f8; }
        .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chip.busy .text { opacity: .6; font-style: italic; }
        .chip.err { border-color: #f28b82; }
    `;
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [sheet];
    } catch {
        const style = document.createElement("style");
        style.textContent = css;
        root.appendChild(style);
    }
    const chip = document.createElement("div");
    chip.className = "chip";
    const keyEl = Object.assign(document.createElement("span"), { className: "key", textContent: "Tab ⇥" });
    const langEl = Object.assign(document.createElement("span"), { className: "lang" });
    const textEl = Object.assign(document.createElement("span"), { className: "text" });
    chip.append(keyEl, langEl, textEl);
    root.appendChild(chip);
    const mountHost = () => host.isConnected || document.documentElement.appendChild(host);

    // ---------- state ----------
    /** @type {HTMLInputElement|HTMLTextAreaElement|null} */
    let box = null;
    let original = ""; // what the user typed
    let result = null; // { text, to } | null
    let pending = null; // Promise of current translation
    let applied = false; // box currently shows the translation
    let dismissed = false; // user hit Escape
    let failed = false;
    let timer = 0;
    let selfInput = false;
    const bound = new WeakSet();

    function render() {
        const text = box && box.value.trim();
        if (!box || dismissed || !text || !box.isConnected) return (host.style.display = "none");
        mountHost();
        chip.classList.toggle("busy", !!pending && !result);
        chip.classList.toggle("err", failed);
        if (applied) {
            langEl.textContent = "↩";
            textEl.textContent = original;
        } else if (result) {
            langEl.textContent = langName(result.to);
            textEl.textContent = result.text;
        } else if (failed) {
            langEl.textContent = "";
            textEl.textContent = "translation unavailable";
        } else if (pending) {
            langEl.textContent = "";
            textEl.textContent = "translating…";
        } else return (host.style.display = "none");
        host.style.display = "block";
        position();
    }

    function position() {
        if (!box || host.style.display === "none") return;
        const r = box.getBoundingClientRect();
        const h = chip.offsetHeight || 28;
        const w = chip.offsetWidth || 200;
        const below = r.bottom + 4 + h <= innerHeight;
        const top = below ? r.bottom + 4 : Math.max(0, r.top - h - 4);
        const left = Math.min(Math.max(0, r.right - w), Math.max(0, innerWidth - w - 4));
        host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }

    function schedule() {
        clearTimeout(timer);
        result = null;
        failed = false;
        pending = null;
        const q = original.trim();
        if (!q) return render();
        const job = new Promise((res) => (timer = setTimeout(res, DEBOUNCE_MS))).then(() => translate(q));
        pending = job;
        render();
        job.then(
            (r) => {
                if (pending !== job) return;
                result = r;
                pending = null;
                render();
            },
            (e) => {
                if (pending !== job) return;
                console.warn("[search-in-your-lang]", e);
                failed = true;
                pending = null;
                render();
            },
        );
    }

    function attach(el) {
        if (box === el) return;
        box = el;
        original = el.value;
        applied = false;
        dismissed = false;
        if (!bound.has(el)) {
            bound.add(el);
            el.addEventListener("input", () => {
                if (selfInput || el !== box) return;
                original = el.value;
                applied = false;
                dismissed = false;
                schedule();
            });
        }
        schedule();
    }

    function detach() {
        clearTimeout(timer);
        box = null;
        pending = null;
        render();
    }

    async function toggle() {
        if (!box) return;
        const el = box;
        if (applied) {
            apply(el, original);
            applied = false;
            return render();
        }
        const r = result || (await pending?.catch(() => null));
        if (!r || el !== box) return;
        apply(el, r.text);
        applied = true;
        render();
    }

    function apply(el, value) {
        selfInput = true;
        try {
            setNativeValue(el, value);
        } finally {
            selfInput = false;
        }
        el.focus();
    }

    // ---------- events ----------
    const deepTarget = (e) => (e.composedPath?.()[0]) || e.target;

    document.addEventListener(
        "focusin",
        (e) => {
            const el = deepTarget(e);
            if (isSearchBox(el)) attach(el);
            else if (el !== box && !host.contains(el)) detach();
        },
        true,
    );
    document.addEventListener(
        "focusout",
        (e) => {
            if (deepTarget(e) !== box) return;
            // Some sites (YouTube) re-focus the same box right away; only hide if focus really moved.
            setTimeout(() => {
                const a = document.activeElement;
                const deep = a?.shadowRoot?.activeElement || a;
                if (box && deep !== box) detach();
            }, 150);
        },
        true,
    );

    window.addEventListener(
        "keydown",
        (e) => {
            if (!box || deepTarget(e) !== box || e.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape" && host.style.display !== "none") {
                dismissed = true;
                render();
                return; // let the site also handle Escape (e.g. close its suggestion list)
            }
            if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
            if (dismissed || !box.value.trim()) return; // normal Tab: move focus
            if (!applied && !result && !pending) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            toggle();
        },
        true,
    );

    chip.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
    chip.addEventListener("click", () => toggle());

    let raf = 0;
    const reposition = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(position);
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    // A search box may already be focused (autofocus on google.com / wikipedia.org)
    const initial = document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    if (isSearchBox(initial)) attach(initial);
})();
