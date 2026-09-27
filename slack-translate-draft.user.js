// ==UserScript==
// @name               Slack Translate Draft
// @name:zh            Slack 草稿翻译
// @name:ja            Slack 下書き翻訳
// @namespace          snomiao@gmail.com
// @author             snomiao@gmail.com
// @version            0.3.0
// @description        [snolab] In Slack's message box, press Tab to reach a translate button; Space cycles your draft through the channel's languages then yours, Enter keeps it, Esc undoes. Bold/italic/code/links/mentions/emoji are kept. Uses Chrome's on-device Translator as fallback.
// @description:zh     [snolab] 在 Slack 输入框按 Tab 聚焦翻译按钮，空格在频道语言和你的语言之间轮换草稿，回车确定，Esc 撤销；保留粗体/代码/链接/提及/表情。
// @description:ja     [snolab] Slack の入力欄で Tab → 翻訳ボタン、スペースでチャンネルの言語と自分の言語を順に切り替え、Enter で確定、Esc で取り消し（太字・コード・リンク・メンション・絵文字を保持）。
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
        GM_registerMenuCommand("Set languages…", () => {
            const v = prompt("Languages to cycle, comma separated (e.g. ja,en,zh-CN). Empty = channel languages, then your browser languages", gmGet("langs", ""));
            v !== null && (GM_setValue("langs", v.trim()), GM_setValue("targetLang", ""), cache.clear());
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
    const fixedLangs = () => (gmGet("langs", gmGet("targetLang", "")) || "").split(/[\s,]+/).filter(Boolean).map(norm);
    /** [null(original), ...channel langs, ...my langs] minus the draft's own lang; sep = index where "my langs" start */
    const cycleOf = async (from) => {
        const fixed = fixedLangs().filter((l) => l !== from);
        if (fixed.length) return { cycle: [null, ...new Set(fixed)], sep: 0 };
        const ch = (await channelLangs()).filter(([l, share]) => l !== from && share >= 0.25).map(([l]) => l);
        const mine = myLangs().filter((l) => l !== from && !ch.includes(l));
        return { cycle: [null, ...ch, ...mine], sep: ch.length && mine.length ? ch.length + 1 : 0 };
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
    const memo = (k, f) => cache.get(k) ?? cache.set(k, f().catch((e) => (cache.delete(k), Promise.reject(e)))).get(k);
    const plain = (ops) => ops.map((o) => (typeof o.insert === "string" ? o.insert : "·")).join("").trim();
    // always from the original draft; null = came back unchanged
    const translateDelta = (ops, to, from) => memo(to + ":" + JSON.stringify(ops), async () => {
        const lines = await Promise.all(toLines(ops).map(async ({ segs, nl }) => {
            const keep = [], html = lineToHtml(segs, keep);
            const skip = nl?.attributes?.["code-block"] || !segs.some((o) => isText(o) && o.insert.trim());
            return [...(skip ? segs : htmlToSegs(await tr(html, to, from), keep)), ...(nl ? [nl] : [])];
        }));
        const out = lines.flat();
        return plain(out).toLowerCase() === plain(ops).toLowerCase() ? null : out;
    });

    // ---------- chip UI: a real <button>, Tab from the composer lands on it ----------
    //   collapsed: [Tab ⇥] japonais  今日デプロイ…
    //   focused:   orig [ja] en | fr zh-CN ru   ␣ next ⏎ ok esc undo
    //              japonais · 今日デプロイ…
    const h = (tag, className, textContent = "") => Object.assign(document.createElement(tag), { className, textContent });
    const host = Object.assign(document.createElement("div"), { id: "slack-translate-draft-chip" });
    Object.assign(host.style, { position: "fixed", zIndex: 2147483647, top: 0, left: 0, display: "none" });
    const root = host.attachShadow({ mode: "open" }), sheet = new CSSStyleSheet();
    sheet.replaceSync(`.chip{font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:3px;max-width:min(560px,80vw);padding:4px 8px;border-radius:8px;cursor:pointer;user-select:none;background:#1a1d21;color:#e8eaed;box-shadow:0 2px 8px #0005;border:1px solid #5f6368;text-align:left}
        .chip:focus-visible{outline:2px solid #8ab4f8;outline-offset:1px}.row{display:flex;gap:6px;align-items:center;min-width:0}
        .pills{display:none;flex-wrap:wrap}.open .pills,.chip:hover .pills{display:flex}.pill{font-size:11px;padding:0 5px;border-radius:4px;border:1px solid transparent;color:#bdc1c6}
        .pill.cur{border-color:#8ab4f8;background:#8ab4f833;color:#fff}.pill.wait{opacity:.5}.pill.skip,.pill.bad{text-decoration:line-through;opacity:.4}.sep{color:#5f6368}
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

    // ---------- state: cycle = [null(original), ...langs]; pos = index shown in the composer ----------
    let quill = null, editor = null, original = null, from = "", cycle = [null], sep = 0, ready = false, pos = 0, dir = 1, entry = 0, status = {}, dismissed = false, timer = 0, selfChange = false, gen = 0;
    const quillOf = (el) => { const c = el?.closest?.(".ql-editor")?.parentElement; return (c?.wrappedJSObject || c)?.__quill; };
    const isOpen = () => document.activeElement === host;
    const dead = (l) => /skip|bad/.test(status[l]?.s);
    const valueAt = (i) => (i ? status[cycle[i]]?.ops : original.ops);
    const setDelta = (ops) => {
        if (!ops) return;
        selfChange = true;
        try { quill.setContents(ops, "user"); } finally { selfChange = false; } // no setSelection: it would steal focus from the button
    };
    const want = (to) => {
        if (!to || status[to]) return;
        const g = gen, st = (status[to] = { s: "wait" });
        translateDelta(original.ops, to, from).then((o) => ((st.s = o ? "ok" : "skip"), (st.ops = o), (st.text = o && plain(o))), (e) => (console.warn("[slack-translate-draft]", e), (st.s = "bad"))).then(() => {
            if (g !== gen) return;
            if (cycle[pos] === to) st.s === "ok" ? setDelta(st.ops) : isOpen() && go(pos + dir, dir); // landed on a dead lang: keep going
            render();
        });
    };
    const go = (i, d = 1) => {
        const n = cycle.length;
        i = ((i % n) + n) % n;
        for (let k = 0; k < n && i && dead(cycle[i]); k++) i = (i + d + n) % n;
        [pos, dir] = [i, d];
        want(cycle[i]), want(cycle[(i + d + n) % n]); // current + prefetch next
        setDelta(valueAt(i)), render();
    };
    const render = () => {
        const text0 = original && plain(original.ops);
        if (!quill || dismissed || !text0) return (host.style.display = "none");
        const open = isOpen(), cur = cycle[pos], pv = pos ? cur : cycle.slice(1).find((l) => !dead(l));
        if (ready && !pv) return (host.style.display = "none");
        pv && !open && want(pv);
        const st = status[pv] || {}, n = cycle.length - 1;
        const [lang, text] = !ready ? ["", "translating…"]
            : open && !pos ? ["original", text0]
            : !open && pos ? [langName(cur) + " ✓", ""]
            : [langName(pv), st.s === "ok" ? st.text : st.s === "wait" || !st.s ? "translating…" : "—"];
        pills.replaceChildren(...cycle.flatMap((l, i) => [
            ...(sep && i === sep ? [h("span", "sep", "|")] : []), // channel langs | my langs
            Object.assign(h("span", `pill ${i === pos ? "cur" : ""} ${(l && status[l]?.s) || ""}`, l || "orig"), { title: l ? langName(l) : "original" }),
        ]), h("span", "hint", "␣ next · ⏎ ok · esc undo"));
        [...pills.querySelectorAll(".pill")].forEach((p, i) => (p.dataset.i = i));
        host.isConnected || document.documentElement.append(host);
        chip.classList.toggle("open", open), chip.classList.toggle("busy", text === "translating…");
        [langEl.textContent, textEl.textContent, host.style.display] = [lang, open ? (text && "· " + text) : text, "block"];
        chip.ariaLabel = `${lang}${pos ? ` ${pos}/${n}` : ""}: ${text}`;
        open && (live.textContent = chip.ariaLabel);
        position();
    };
    const position = () => {
        if (!editor || host.style.display === "none") return;
        const box = (editor.closest("[data-qa=message_input]") || editor).getBoundingClientRect();
        host.style.transform = `translate(${Math.round(Math.max(0, box.right - chip.offsetWidth))}px,${Math.round(Math.max(0, box.top - chip.offsetHeight - 6))}px)`;
    };
    const schedule = () => {
        clearTimeout(timer), gen++, ([cycle, sep, ready, pos, status] = [[null], 0, false, 0, {}]);
        const g = gen, text = plain(original.ops);
        if (!text) return render();
        render();
        timer = setTimeout(async () => {
            const f = await detect(text).catch(() => ""), c = await cycleOf(f);
            g === gen && ((from = f), (cycle = c.cycle), (sep = c.sep), (ready = true), render());
        }, 700);
    };
    const onChange = () => {
        if (selfChange) return;
        [original, dismissed] = [quill.getContents(), false];
        schedule();
    };
    const attach = (el) => {
        const q = quillOf(el);
        if (!q) return;
        if (q === quill) return render();
        quill?.off("text-change", onChange);
        [quill, editor, original, dismissed] = [q, el.closest(".ql-editor"), q.getContents(), false];
        quill.on("text-change", onChange);
        schedule();
    };
    const nextTabbable = (from) =>
        [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex],[contenteditable]")].find((el) =>
            el.tabIndex >= 0 && !el.disabled && !from.contains(el) && from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && el.getClientRects().length);
    // Tab belongs to Slack while completing :emoji:/@name or inside a list/code block
    const tabIsSlacks = () => document.querySelector("[data-qa=texty_autocomplete_menu]") || ["list", "code-block"].some((f) => quill.getFormat()[f]);

    // ---------- events ----------
    document.addEventListener("focusin", (e) => (quillOf(e.target) ? attach(e.target) : e.target === host && render()), true);
    document.addEventListener("focusout", () => setTimeout(() => (!quillOf(document.activeElement) && !isOpen() ? (host.style.display = "none") : render()), 150), true);
    window.addEventListener("keydown", (e) => {
        if (!quill || !quillOf(e.target) || e.isComposing) return;
        if (e.key === "Escape" && host.style.display !== "none") return (dismissed = true), render();
        if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || host.style.display === "none" || tabIsSlacks()) return;
        e.preventDefault(), e.stopImmediatePropagation(), (entry = pos), chip.focus(); // Tab: composer → button
        want(cycle[pos + 1] ?? cycle[1]);
    }, true);
    chip.addEventListener("keydown", (e) => {
        e.stopPropagation(); // keep Slack's global hotkeys away from the button
        const k = e.key, back = () => (e.preventDefault(), quill?.focus(), quill?.setSelection(quill.getLength(), 0, "silent")); // caret at end
        if (k === " " || k === "ArrowRight") return e.preventDefault(), go(pos + 1, 1);
        if (k === "ArrowLeft") return e.preventDefault(), go(pos - 1, -1);
        if (/^\d$/.test(k) && +k < cycle.length) return e.preventDefault(), go(+k);
        if (k === "Enter" || (k === "Tab" && e.shiftKey)) return back(); // keep current draft; Enter again sends
        if (k === "Escape") return (pos = entry), setDelta(valueAt(entry) ?? original.ops), back(); // undo this round
        if (k === "Tab") { const n = editor && nextTabbable(editor); n && (e.preventDefault(), n.focus()); }
    });
    chip.addEventListener("mousedown", (e) => e.preventDefault()); // mouse keeps focus in composer
    chip.addEventListener("click", (e) => {
        if (!e.detail) return; // keyboard click, handled above
        const i = e.composedPath().find((x) => x.dataset?.i)?.dataset.i;
        i != null ? go(+i) : go(pos + 1, 1);
    });
    addEventListener("resize", () => requestAnimationFrame(position));
    quillOf(document.activeElement) && attach(document.activeElement);
})();
