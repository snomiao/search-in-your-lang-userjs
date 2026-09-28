// ==UserScript==
// @name               Search in Your Language
// @name:zh            用你的语言搜索
// @name:ja            あなたの言語で検索
// @namespace          snomiao@gmail.com
// @author             snomiao@gmail.com
// @version            0.4.1
// @description        [snolab] Press Tab in any search box (Google, YouTube, Wikipedia, Bing, Amazon, ...) to reach a translate button; Space cycles your keyword through your browser languages, Enter keeps it, Esc undoes. Uses Chrome's on-device Translator API when available.
// @description:zh     [snolab] 在任意搜索框中按 Tab 聚焦翻译按钮，空格在浏览器语言之间轮换关键词，回车确定，Esc 撤销。优先使用 Chrome 内置翻译 API。
// @description:ja     [snolab] どの検索ボックスでも Tab で翻訳ボタンへ移動、スペースでブラウザの言語を順に切り替え、Enter で確定、Esc で取り消し。Chrome 内蔵翻訳 API を優先使用。
// @match              *://*/*
// @run-at             document-idle
// @noframes
// @grant              unsafeWindow
// @grant              GM_xmlhttpRequest
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_registerMenuCommand
// @connect            clients5.google.com
// @connect            translate.googleapis.com
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
    const langs = () => { const set = gmGet("langs", gmGet("targetLang", "")); return [...new Set((set ? set.split(/[\s,]+/) : [...navigator.languages, "en"]).filter(Boolean).map(norm))]; };
    const langName = (c) => new Intl.DisplayNames([navigator.language], { type: "language" }).of(c) || c;
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    typeof GM_registerMenuCommand === "function" &&
        GM_registerMenuCommand("Set languages…", () => {
            const v = prompt(`Languages to cycle, comma separated (e.g. ja,en,zh-CN). Empty = browser languages (${navigator.languages})`, gmGet("langs", ""));
            v !== null && (GM_setValue("langs", v.trim()), GM_setValue("targetLang", ""), cache.clear());
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
    const memo = (k, f) => cache.get(k) ?? cache.set(k, f().catch((e) => (cache.delete(k), Promise.reject(e)))).get(k);
    // source lang: on-device detector, else whatever Google reports
    const srcOf = (q) => memo("src:" + q, async () => (await detect(q).catch(() => "")) || (await tr(q, langs().find((l) => l !== "en") || "en")).from);
    const cycleOf = async (q) => { const from = await srcOf(q).catch(() => ""); return [null, ...langs().filter((l) => l !== from)]; }; // null = original
    // always from the original text, so meaning never drifts; null = same as original (e.g. "iPhone")
    const translate = (q, to) => memo(to + ":" + q, async () => { const { text } = await tr(q, to, await srcOf(q).catch(() => "")); return same(text, q) ? null : text; });

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

    // chip = a real <button> joining the tab order right after the box (no innerHTML: YouTube enforces Trusted Types)
    //   collapsed: [Tab ⇥] Français  Vidéos de chat
    //   focused:   orig [fr] ja zh-CN ru   ␣ next ⏎ ok esc undo
    //              Français · Vidéos de chat
    const h = (tag, className, textContent = "") => Object.assign(document.createElement(tag), { className, textContent });
    const host = Object.assign(document.createElement("div"), { id: "search-in-your-lang-chip" });
    Object.assign(host.style, { position: "fixed", zIndex: 2147483647, top: 0, left: 0, display: "none" });
    const root = host.attachShadow({ mode: "open" }), sheet = new CSSStyleSheet();
    sheet.replaceSync(`.chip{font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:3px;max-width:min(560px,92vw);padding:4px 8px;border-radius:8px;cursor:pointer;user-select:none;background:#202124;color:#e8eaed;box-shadow:0 2px 8px #0005;border:1px solid #5f6368;text-align:left}
        .chip:focus-visible{outline:2px solid #8ab4f8;outline-offset:1px}.row{display:flex;gap:6px;align-items:center;min-width:0}
        .pills{display:none;flex-wrap:wrap}.open .pills,.chip:hover .pills{display:flex}.pill{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid transparent;color:#bdc1c6}
        .pill.cur{border-color:#8ab4f8;background:#8ab4f833;color:#fff}.pill.wait{opacity:.5}.pill.skip,.pill.bad{text-decoration:line-through;opacity:.4}
        .hint{display:none;margin-left:auto;font-size:11px;color:#9aa0a6;white-space:nowrap}.open .hint{display:inline}
        .key{font-size:11px;padding:0 5px;border:1px solid #9aa0a6;border-radius:4px;color:#bdc1c6;white-space:nowrap}.open .key{display:none}
        .lang{color:#8ab4f8;white-space:nowrap}.text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.busy .text{opacity:.6;font-style:italic}
        .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}`);
    root.adoptedStyleSheets = [sheet];
    const [chip, pills, langEl, textEl, live] = [h("button", "chip"), h("span", "row pills"), h("span", "lang"), h("span", "text"), h("span", "sr")];
    const row2 = h("span", "row");
    row2.append(h("span", "key", "Tab ⇥"), langEl, textEl);
    chip.append(pills, row2), root.append(chip, live);
    live.setAttribute("role", "status");

    // state: cycle = [null(original), ...langs]; pos = index into cycle shown in the box
    let box = null, original = "", cycle = [null], ready = false, pos = 0, dir = 1, entry = 0, status = {}, dismissed = false, timer = 0, selfInput = false, hold = 0;
    const active = () => document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    const isOpen = () => active() === chip;
    const dead = (l) => /skip|bad/.test(status[l]?.s);
    const valueAt = (i) => (i ? status[cycle[i]]?.text : original);
    const apply = (v) => { if (v == null || v === box.value) return; selfInput = true; try { setValue(box, v); } finally { selfInput = false; } };
    const want = (to) => {
        if (!to || status[to]) return;
        const q = original, st = (status[to] = { s: "wait" });
        translate(q.trim(), to).then((t) => ((st.s = t ? "ok" : "skip"), (st.text = t)), (e) => (console.warn("[search-in-your-lang]", e), (st.s = "bad"))).then(() => {
            if (q !== original) return;
            if (cycle[pos] === to) st.s === "ok" ? apply(st.text) : isOpen() && go(pos + dir, dir); // landed on a dead lang: keep going
            render();
        });
    };
    const go = (i, d = 1) => {
        const n = cycle.length;
        i = ((i % n) + n) % n;
        for (let k = 0; k < n && i && dead(cycle[i]); k++) i = (i + d + n) % n;
        [pos, dir] = [i, d];
        want(cycle[i]), want(cycle[(i + d + n) % n]); // current + prefetch next
        apply(valueAt(i)), render();
    };
    const render = () => {
        if (!box || dismissed || !original.trim()) return (host.style.display = "none");
        const open = isOpen(), cur = cycle[pos], pv = pos ? cur : cycle.slice(1).find((l) => !dead(l)); // collapsed at original → preview first live lang
        if (ready && !pv) return (host.style.display = "none"); // nothing to offer
        pv && !open && want(pv);
        const st = status[pv] || {}, n = cycle.length - 1;
        const [lang, text] = !ready ? ["", "translating…"]
            : open && !pos ? ["original", original]
            : !open && pos ? [langName(cur) + " ✓", ""]
            : [langName(pv), st.s === "ok" ? st.text : st.s === "wait" || !st.s ? "translating…" : "—"];
        pills.replaceChildren(...cycle.map((l, i) => Object.assign(h("span", `pill ${i === pos ? "cur" : ""} ${(l && status[l]?.s) || ""}`, l || "orig"), { title: l ? langName(l) : "original" })),
            h("span", "hint", "␣ next · ⏎ ok · esc undo"));
        [...pills.children].forEach((p, i) => (p.dataset.i = i));
        host.isConnected || document.documentElement.append(host);
        chip.classList.toggle("open", open), chip.classList.toggle("busy", text === "translating…");
        [langEl.textContent, textEl.textContent, host.style.display] = [lang, open ? (text && "· " + text) : text, "block"];
        chip.ariaLabel = `${lang}${pos ? ` ${pos}/${n}` : ""}: ${text}`;
        open && (live.textContent = chip.ariaLabel); // screen readers hear each switch
        position();
    };
    const position = () => {
        if (!box || host.style.display === "none") return;
        const r = box.getBoundingClientRect(), { offsetWidth: w, offsetHeight: ch } = chip;
        const top = r.bottom + 4 + ch <= innerHeight ? r.bottom + 4 : Math.max(0, r.top - ch - 4);
        host.style.transform = `translate(${Math.round(Math.max(0, Math.min(r.right - w, innerWidth - w - 4)))}px,${Math.round(top)}px)`;
    };
    const schedule = () => {
        clearTimeout(timer), ([cycle, ready, pos, status] = [[null], false, 0, {}]);
        const q = original;
        if (!q.trim()) return render();
        render();
        // if the user tabbed in before langs were known, land on the first lang now
        timer = setTimeout(async () => { const c = await cycleOf(q.trim()); q === original && ((cycle = c), (ready = true), isOpen() && !pos ? go(1) : render()); }, 250);
    };
    const bound = new WeakSet();
    const attach = (el) => {
        if (box === el) return render();
        [box, original, dismissed] = [el, el.value, false];
        bound.has(el) || (bound.add(el), el.addEventListener("input", () => !selfInput && el === box && ((original = el.value), (dismissed = false), schedule())));
        schedule();
    };
    const detach = () => (clearTimeout(timer), (box = null), render());

    // the button lives in its own layer, so walk the page's tab order ourselves
    const nextTabbable = (from) => {
        const anchor = from.getRootNode().host || from;
        return [...document.querySelectorAll("a[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]")].find((el) =>
            el.tabIndex >= 0 && !el.disabled && !anchor.contains(el) && anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
            el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    };

    // events
    const deep = (e) => e.composedPath?.()[0] || e.target;
    const inChip = (e) => e.composedPath?.().includes(host);
    const stillHere = () => { const a = active(); return a === box || a === chip; };
    document.addEventListener("focusin", (e) => {
        if (deep(e) === box && performance.now() < hold) return (hold = 0), setTimeout(() => chip.focus()); // Bing yanks focus back on blur
        inChip(e) ? render() : isSearchBox(deep(e)) ? attach(deep(e)) : deep(e) !== box && detach();
    }, true);
    document.addEventListener("focusout", (e) => (deep(e) === box || inChip(e)) && setTimeout(() => (box && !stillHere() ? detach() : render()), 150), true);
    window.addEventListener("keydown", (e) => {
        if (!box || deep(e) !== box || e.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape" && host.style.display !== "none") return (dismissed = true), render(); // site still gets Escape
        if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || host.style.display === "none") return;
        e.preventDefault(), e.stopImmediatePropagation(), (hold = performance.now() + 300), (entry = pos), chip.focus(), go(pos + 1, 1); // Tab: box → button, already on the next lang
    }, true);
    chip.addEventListener("keydown", (e) => {
        e.stopPropagation(), (hold = 0); // keep site hotkeys (YouTube: space = play) away from the button
        const k = e.key, back = () => (e.preventDefault(), box?.focus());
        if (k === " " || k === "ArrowRight") return e.preventDefault(), go(pos + 1, 1);
        if (k === "ArrowLeft") return e.preventDefault(), go(pos - 1, -1);
        if (/^\d$/.test(k) && +k < cycle.length) return e.preventDefault(), go(+k);
        if (k === "Enter" || (k === "Tab" && e.shiftKey)) return back(); // keep current text
        if (k === "Escape") return (pos = entry), apply(valueAt(entry) ?? original), back(); // undo this round
        if (k === "Tab") { const n = nextTabbable(box); n && (e.preventDefault(), n.focus()); }
    });
    chip.addEventListener("mousedown", (e) => (e.preventDefault(), (hold = 0))); // mouse keeps focus in the box
    chip.addEventListener("click", (e) => {
        if (!e.detail) return; // keyboard click, handled above
        const i = e.composedPath().find((x) => x.dataset?.i)?.dataset.i;
        i != null ? go(+i) : go(pos + 1, 1);
    });
    let raf = 0;
    const reposition = () => (cancelAnimationFrame(raf), (raf = requestAnimationFrame(position)));
    addEventListener("scroll", reposition, true), addEventListener("resize", reposition);
    isSearchBox(active()) && attach(active()); // autofocused box
})();
