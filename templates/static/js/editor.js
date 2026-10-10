/* NSLEditor - sign editor behaviour for the editor partial.
 *
 *  - Loads font / size dropdowns from the /api/fonts + /api/sizes API.
 *  - Renders a live 240x40 bitmap preview via NSLPreview.
 *  - Autosaves the draft to localStorage (debounced) and restores it,
 *    so reloading the page never loses work.
 *  - If opened from the Program tab (nsl.programCtx), the Save tab offers
 *    "Update page in program" to write the draft back to the .dest file.
 *
 * Call `NSLEditor.init(root)` after injecting the partial (studio.js does).
 */
(function () {
    var STORAGE_KEY = 'nsl.signDraft.v1';
    var CTX_KEY = 'nsl.programCtx';
    var SAVE_DELAY_MS = 350;

    var GROUPS = [
        { key: 'number', textId: null, fontId: 'number-font', sizeId: 'number-size', colorId: 'number-color',
          xId: 'number-x', yId: 'number-y', wId: 'number-w', hId: 'number-h', alignId: 'number-align', valignId: 'number-valign', lhId: 'number-lh', lgId: 'number-lg', lsId: 'number-ls', spaceId: 'number-sp' },
        { key: 'destination', textId: 'sign-destination', fontId: 'dest-font', sizeId: 'dest-size', colorId: 'dest-color',
          xId: 'dest-x', yId: 'dest-y', wId: 'dest-w', hId: 'dest-h', alignId: 'dest-align', valignId: 'dest-valign', lhId: 'dest-lh', lgId: 'dest-lg', lsId: 'dest-ls', spaceId: 'dest-sp', scrollId: 'dest-scroll' },
        { key: 'via', textId: 'sign-via', fontId: 'via-font', sizeId: 'via-size', colorId: 'via-color',
          xId: 'via-x', yId: 'via-y', wId: 'via-w', hId: 'via-h', alignId: 'via-align', valignId: 'via-valign', lhId: 'via-lh', lgId: 'via-lg', lsId: 'via-ls', spaceId: 'via-sp', scrollId: 'via-scroll' }
    ];

    // Quick-position presets (from_X/to_X/front_Y/to_Y scheme as in
    // programs/*.dest). Only applied to a fresh draft or on "Clear draft" -
    // changing the layout never touches custom positions.
    var LAYOUT_PRESETS = {
        top: {
            number: { x: 210, y: 0, w: 30, h: 40 },
            destination: { x: 0, y: 14, w: 220, h: 26 },
            via: { x: 0, y: 0, w: 220, h: 14 }
        },
        bottom: {
            number: { x: 180, y: 0, w: 60, h: 40 },
            destination: { x: 0, y: 0, w: 180, h: 25 },
            via: { x: 0, y: 25, w: 180, h: 15 }
        },
        left: {
            number: { x: 0, y: 0, w: 30, h: 40 },
            destination: { x: 32, y: 14, w: 208, h: 26 },
            via: { x: 32, y: 0, w: 208, h: 14 }
        },
        none: {
            number: { x: 210, y: 0, w: 30, h: 40 },
            destination: { x: 0, y: 0, w: 208, h: 40 },
            via: { x: 0, y: 26, w: 220, h: 14 }
        }
    };
    LAYOUT_PRESETS.right = LAYOUT_PRESETS.top;

    var DEFAULTS = {
        route: '',
        destination: '',
        via: '',
        layout: 'bottom',
        guides: false,
        dots: true,
        outerTab: 0,
        innerTab: 0,
        images: [],
        styles: {
            number: { font: '', size: '', color: '#DB7700', align: 'center', valign: 'middle', lineHeight: null, lineGap: 0, letterSpacing: 0, spaceWidth: null, box: { x: 180, y: 0, w: 60, h: 40 } },
            destination: { font: '', size: '', color: '#DB7700', align: 'center', valign: 'middle', lineHeight: null, lineGap: 0, letterSpacing: 0, spaceWidth: null, scroll: false, box: { x: 0, y: 0, w: 180, h: 25 } },
            via: { font: '', size: '', color: '#DB7700', align: 'center', valign: 'middle', lineHeight: null, lineGap: 0, letterSpacing: 0, spaceWidth: null, scroll: false, box: { x: 0, y: 25, w: 180, h: 15 } }
        }
    };

    // Line-height field: empty = auto (null), otherwise clamped px.
    function lineHeightOf(root, id) {
        var el = id && root.querySelector('#' + id);
        if (!el || String(el.value).trim() === '') return null;
        var n = parseInt(el.value, 10);
        if (isNaN(n)) return null;
        return Math.max(1, Math.min(256, n));
    }

    function lineGapOf(root, id) {
        var el = id && root.querySelector('#' + id);
        if (!el || String(el.value).trim() === '') return 0;
        var n = parseInt(el.value, 10);
        if (isNaN(n)) return 0;
        return Math.max(-64, Math.min(200, n));
    }

    function letterSpacingOf(root, id) {
        var el = id && root.querySelector('#' + id);
        if (!el || String(el.value).trim() === '') return 0;
        var n = parseInt(el.value, 10);
        if (isNaN(n)) return 0;
        return Math.max(-20, Math.min(40, n));
    }

    // Space width field: empty = font default (null), otherwise clamped px.
    function spaceWidthOf(root, id) {
        var el = id && root.querySelector('#' + id);
        if (!el || String(el.value).trim() === '') return null;
        var n = parseInt(el.value, 10);
        if (isNaN(n)) return null;
        return Math.max(0, Math.min(64, n));
    }

    function $(root, id) {
        return root.querySelector('#' + id);
    }

    // Studio display size from the Settings tab (falls back to 240x40).
    function edims() {
        try {
            if (window.NSLSettings) return window.NSLSettings.dims();
        } catch (err) { /* ignore */ }
        return { w: 240, h: 40 };
    }

    // Fresh-draft defaults: factory values overlaid with the user's
    // Settings (colour, layout, per-element fonts/sizes).
    function defaultDraft() {
        var d = JSON.parse(JSON.stringify(DEFAULTS));
        try {
            if (!window.NSLSettings) return d;
            var s = window.NSLSettings.get();
            d.layout = s.layout || d.layout;
            ['number', 'destination', 'via'].forEach(function (k) {
                if (s.colour) d.styles[k].color = s.colour;
                var f = (s.fonts || {})[k] || {};
                if (f.font) d.styles[k].font = f.font;
                if (f.size !== undefined && f.size !== null && String(f.size) !== '') {
                    d.styles[k].size = String(f.size);
                }
            });
        } catch (err) { /* ignore */ }
        return d;
    }

    function loadDraft() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var data = JSON.parse(raw);
            return data && data.v === 1 ? data : null;
        } catch (err) {
            return null;
        }
    }

    function collectState(root) {
        var styles = {};
        var D = edims();
        GROUPS.forEach(function (group) {
            var fontEl = $(root, group.fontId);
            var sizeEl = $(root, group.sizeId);
            var colorEl = $(root, group.colorId);
            var fb = DEFAULTS.styles[group.key];
            styles[group.key] = {
                font: fontEl ? fontEl.value : '',
                size: sizeEl ? sizeEl.value : '',
                color: colorEl ? colorEl.value : '',
                align: val(root, group.alignId) || fb.align,
                valign: val(root, group.valignId) || fb.valign,
                lineHeight: lineHeightOf(root, group.lhId),
                lineGap: lineGapOf(root, group.lgId),
                letterSpacing: letterSpacingOf(root, group.lsId),
                spaceWidth: spaceWidthOf(root, group.spaceId),
                scroll: !!(group.scrollId && $(root, group.scrollId) && $(root, group.scrollId).checked),
                box: {
                    x: num(root, group.xId, 0, D.w - 1, fb.box.x),
                    y: num(root, group.yId, 0, D.h - 1, fb.box.y),
                    w: num(root, group.wId, 1, D.w, fb.box.w),
                    h: num(root, group.hId, 1, D.h, fb.box.h)
                }
            };
        });
        var guidesEl = $(root, 'show-guides');
        var dotsEl = $(root, 'show-dots');
        return {
            v: 1,
            route: val(root, 'route-number'),
            destination: val(root, 'sign-destination'),
            via: val(root, 'sign-via'),
            layout: val(root, 'sign-layout') || 'bottom',
            numberSide: val(root, 'number-side') || 'right',
            guides: !!(guidesEl && guidesEl.checked),
            dots: !dotsEl || dotsEl.checked,
            outerTab: activeIndex(root, '.side-bar > .tabs'),
            innerTab: activeIndex(root, '.sign-attributes > .tabs'),
            styles: styles,
            images: readPageImages(root),
            updatedAt: Date.now()
        };
    }

    // Font-size stepper (−/+ beside each Size select): move one step
    // through the loaded sizes for that font, then preview + autosave.
    function stepSize(root, btn, scheduleSave) {
        var sel = btn.dataset.sizeTarget && root.querySelector('#' + btn.dataset.sizeTarget);
        if (!sel || !sel.options || sel.options.length < 2) return;
        var dir = parseInt(btn.dataset.sizeStep, 10) || 0;
        var next = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + dir));
        if (next === sel.selectedIndex) return;
        sel.selectedIndex = next;
        scheduleSave();
    }

    // Positioned bitmaps live in #page-images rows (data-idx). Read them
    // back for autosave / preview / program writes.
    function cleanImageSpec(spec) {
        if (!spec || typeof spec !== 'object') return null;
        var src = String(spec.src || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (src.indexOf('bitmaps/') !== 0) return null;
        function i(v, fallback, lo, hi) {
            var n = parseInt(v, 10);
            if (isNaN(n)) return fallback;
            return Math.max(lo, Math.min(hi, n));
        }
        var out = { src: src, x: i(spec.x, 0, -1024, 1024), y: i(spec.y, 0, -256, 256) };
        [ 'w', 'h' ].forEach(function (k) {
            if (spec[k] === undefined || spec[k] === null || String(spec[k]).trim() === '') return;
            var n = parseInt(spec[k], 10);
            if (!isNaN(n) && n >= 1 && n <= 1024) out[k] = n;
        });
        return out;
    }

    function readPageImages(root) {
        var box = root.querySelector('#page-images');
        if (!box) return (window.__nslImages || []).slice(0, 8);
        var rows = box.querySelectorAll('.page-image');
        // No rows rendered yet (e.g. first paint before applyState):
        // fall back to the in-memory list so a linked page load isn't lost.
        if (!rows.length) return (window.__nslImages || []).slice(0, 8);
        var out = [];
        rows.forEach(function (row) {
            var spec = cleanImageSpec({
                src: row.dataset.src,
                x: (row.querySelector('[data-field="x"]') || {}).value,
                y: (row.querySelector('[data-field="y"]') || {}).value,
                w: (row.querySelector('[data-field="w"]') || {}).value,
                h: (row.querySelector('[data-field="h"]') || {}).value
            });
            if (spec) out.push(spec);
        });
        window.__nslImages = out.slice();
        return out.slice(0, 8);
    }

    function setPageImages(root, images) {
        var clean = [];
        (images || []).forEach(function (spec) {
            var c = cleanImageSpec(spec);
            if (c) clean.push(c);
        });
        window.__nslImages = clean.slice(0, 8);
        renderPageImages(root);
    }

    function num(root, id, min, max, fallback) {
        var el = $(root, id);
        if (!el) return fallback;
        var n = parseInt(el.value, 10);
        if (isNaN(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function val(root, id) {
        var el = $(root, id);
        return el ? el.value : '';
    }

    function activeIndex(root, tabsSelector) {
        var tabsEl = root.querySelector(tabsSelector);
        if (!tabsEl) return 0;
        var buttons = Array.prototype.slice.call(tabsEl.querySelectorAll('.tab button'));
        var idx = buttons.findIndex(function (btn) {
            return btn.classList.contains('active');
        });
        return idx >= 0 ? idx : 0;
    }

    function applyState(root, state) {
        setVal(root, 'route-number', state.route);
        setVal(root, 'sign-destination', state.destination);
        setVal(root, 'sign-via', state.via);
        setVal(root, 'sign-layout', state.layout);
        // Older drafts predate the Number side control - infer it from the
        // number box so the control reflects what is on screen.
        var side = state.numberSide;
        if (side !== 'left' && side !== 'right') {
            var nbox = ((state.styles || {}).number || {}).box
                || DEFAULTS.styles.number.box;
            side = (nbox.x + nbox.w / 2 < 120) ? 'left' : 'right';
        }
        setVal(root, 'number-side', side);
        var guidesEl = $(root, 'show-guides');
        if (guidesEl) guidesEl.checked = !!state.guides;
        var dotsEl = $(root, 'show-dots');
        if (dotsEl) dotsEl.checked = state.dots !== false;
        GROUPS.forEach(function (group) {
            var saved = (state.styles || {})[group.key] || {};
            var fb = DEFAULTS.styles[group.key];
            var textKey = { destination: 'destination', via: 'via' }[group.key];
            if (group.textId) setVal(root, group.textId, textKey ? state[textKey] || '' : '');
            setVal(root, group.colorId, saved.color || fb.color);
            setVal(root, group.alignId, saved.align || fb.align);
            setVal(root, group.valignId, saved.valign || fb.valign);
            setVal(root, group.lhId, saved.lineHeight !== undefined && saved.lineHeight !== null ? saved.lineHeight : '');
            setVal(root, group.lgId, saved.lineGap !== undefined && saved.lineGap !== null ? saved.lineGap : 0);
            setVal(root, group.lsId, saved.letterSpacing !== undefined && saved.letterSpacing !== null ? saved.letterSpacing : 0);
            setVal(root, group.spaceId, saved.spaceWidth !== undefined && saved.spaceWidth !== null ? saved.spaceWidth : '');
            if (group.scrollId) {
                var scrollEl = $(root, group.scrollId);
                if (scrollEl) scrollEl.checked = !!saved.scroll;
            }
            setBox(root, group, saved.box || fb.box);
            // Fonts + sizes resolve async; stash what to select once loaded.
            var fontEl = $(root, group.fontId);
            if (fontEl) fontEl.dataset.pending = saved.font || '';
            var sizeEl = $(root, group.sizeId);
            if (sizeEl) sizeEl.dataset.pending = saved.size || '';
        });
        markActive(root, '.side-bar > .tabs', state.outerTab || 0);
        markActive(root, '.sign-attributes > .tabs', state.innerTab || 0);
        setPageImages(root, state.images || []);
    }

    function setBox(root, group, box) {
        setVal(root, group.xId, box.x);
        setVal(root, group.yId, box.y);
        setVal(root, group.wId, box.w);
        setVal(root, group.hId, box.h);
    }

    function applyPreset(root, layout) {
        var preset = LAYOUT_PRESETS[layout] || LAYOUT_PRESETS.bottom;
        GROUPS.forEach(function (group) {
            setBox(root, group, preset[group.key]);
        });
    }

    // Smart layout: rearrange boxes for the new layout, moving as little as
    // possible. Widths/heights are never touched - only x/y.
    function applySmartLayout(root, layout) {
        var boxes = readBoxes(root);
        var number = boxes.number;
        var dest = boxes.destination;
        var via = boxes.via;
        var W = edims().w;

        if (layout === 'left') {
            number.x = 0;
            var edge = number.x + number.w + 2;
            if (dest.x < edge) dest.x = Math.min(edge, W - dest.w);
            if (via.x < edge) via.x = Math.min(edge, W - via.w);
        } else if (layout === 'top' || layout === 'right') {
            number.x = Math.max(0, W - number.w);
            stackAbove(via, dest); // via above dest
        } else if (layout === 'bottom') {
            number.x = Math.max(0, W - number.w);
            stackAbove(dest, via); // dest above via
        }
        // 'none': leave everything where it is (via just isn't drawn)

        writeBoxes(root, boxes);
    }

    function readBoxes(root) {
        var boxes = {};
        var D = edims();
        GROUPS.forEach(function (group) {
            var fb = DEFAULTS.styles[group.key].box;
            boxes[group.key] = {
                x: num(root, group.xId, 0, D.w - 1, fb.x),
                y: num(root, group.yId, 0, D.h - 1, fb.y),
                w: num(root, group.wId, 1, D.w, fb.w),
                h: num(root, group.hId, 1, D.h, fb.h)
            };
        });
        return boxes;
    }

    function writeBoxes(root, boxes) {
        GROUPS.forEach(function (group) {
            setBox(root, group, boxes[group.key]);
        });
    }

    // Number side: pin the route number to the left or right edge and make
    // room for it, moving destination/via only as far as needed. Sizes and
    // y positions are never touched, and it is independent of Layout.
    function applyNumberSide(root, side) {
        var boxes = readBoxes(root);
        var number = boxes.number;
        var others = [boxes.destination, boxes.via];
        var W = edims().w;

        if (side === 'left') {
            number.x = 0;
            var edge = number.x + number.w + 2;
            others.forEach(function (b) {
                if (b.x < edge) b.x = Math.min(edge, W - b.w);
            });
        } else {
            number.x = Math.max(0, W - number.w);
            others.forEach(function (b) {
                if (b.x + b.w > number.x) b.x = Math.max(0, number.x - b.w);
            });
        }

        writeBoxes(root, boxes);
    }

    // Place `top` directly above `bottom`, keeping both sizes. Anchors on
    // `bottom` unless that would push `top` off-screen.
    function stackAbove(top, bottom) {
        var H = edims().h;
        top.y = bottom.y - top.h;
        if (top.y < 0) {
            top.y = 0;
            bottom.y = top.h;
        }
        if (bottom.y + bottom.h > H) {
            bottom.y = H - bottom.h;
        }
    }

    function setVal(root, id, value) {
        var el = $(root, id);
        if (el && value !== undefined && value !== null) el.value = value;
    }

    function markActive(root, tabsSelector, index) {
        var tabsEl = root.querySelector(tabsSelector);
        if (!tabsEl) return;
        var buttons = tabsEl.querySelectorAll('.tab button');
        buttons.forEach(function (btn, i) {
            btn.classList.toggle('active', i === index);
        });
    }

    function fillSelect(selectEl, items, pendingValue, fallbackIndex, labels) {
        selectEl.innerHTML = '';
        if (!items.length) {
            var opt = document.createElement('option');
            opt.textContent = 'None available';
            selectEl.appendChild(opt);
            return;
        }
        items.forEach(function (item, i) {
            var option = document.createElement('option');
            option.value = String(item);
            option.textContent = (labels && labels[i] != null) ? String(labels[i]) : String(item);
            selectEl.appendChild(option);
        });
        var pending = pendingValue || selectEl.dataset.pending || '';
        var match = items.map(String).indexOf(String(pending));
        selectEl.selectedIndex = match >= 0 ? match : Math.min(fallbackIndex, items.length - 1);
        selectEl.dataset.pending = '';
    }

    // Nearest numeric size to the target. Non-numeric tokens (e.g. the
    // WxH entries under the default family) are skipped; if none qualify,
    // index 0 (smallest first - list_sizes sorts that way).
    function nearestIndex(sizes, target) {
        var best = -1;
        sizes.forEach(function (size, i) {
            var n = Number(size);
            if (isNaN(n)) return;
            if (best < 0 || Math.abs(n - target) < Math.abs(Number(sizes[best]) - target)) best = i;
        });
        return best < 0 ? 0 : best;
    }

    function loadFonts(root) {
        var fontEls = GROUPS.map(function (group) { return $(root, group.fontId); })
            .filter(Boolean);
        if (!fontEls.length) return Promise.resolve();
        return fetch('/api/fonts')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (fonts) {
                fontEls.forEach(function (el) {
                    fillSelect(el, fonts, '', 0);
                });
                return Promise.all(GROUPS.map(function (group) {
                    return loadSizes(root, group);
                }));
            })
            .catch(function (err) {
                console.error(err);
                fontEls.forEach(function (el) {
                    el.innerHTML = '';
                    var opt = document.createElement('option');
                    opt.textContent = 'Could not load fonts';
                    el.appendChild(opt);
                });
            });
    }

    function loadSizes(root, group) {
        var fontEl = $(root, group.fontId);
        var sizeEl = $(root, group.sizeId);
        if (!fontEl || !sizeEl || !fontEl.value) return Promise.resolve();
        var preferred = { number: 45, destination: 33, via: 18 }[group.key] || 18;
        return fetch('/api/sizes/' + encodeURIComponent(fontEl.value))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (sizes) {
                // WxH bitmap families (e.g. 10x20) have a single size whose
                // number is meaningless - show the family name instead.
                var labels = null;
                if (sizes.length === 1 && /^\d+x\d+[a-z]*$/i.test(fontEl.value || '')) {
                    labels = [fontEl.value];
                }
                fillSelect(sizeEl, sizes, '', nearestIndex(sizes, preferred), labels);
            })
            .catch(function (err) {
                console.error(err);
            });
    }

    // Size the canvas backing store from the Settings display size
    // (3x supersample for crisp dots) and keep input bounds in sync.
    function sizeCanvas(root) {
        var D = edims();
        var canvas = root.querySelector('#sign-canvas');
        if (canvas) {
            canvas.width = D.w * 3;
            canvas.height = D.h * 3;
        }
        GROUPS.forEach(function (group) {
            [['xId', 0, D.w - 1], ['yId', 0, D.h - 1],
             ['wId', 1, D.w], ['hId', 1, D.h]].forEach(function (spec) {
                var el = $(root, group[spec[0]]);
                if (el) {
                    el.min = spec[1];
                    el.max = spec[2];
                }
            });
        });
    }

    // ---- Scroll preview: while a destination/via scroll flag is on, a
    // 120ms timer re-renders the canvas with advancing offsets so the
    // marquee plays live in the editor, like the board. Widths are
    // measured async (fonts cache, so this is cheap after first load).
    var scrollTick = 0;
    var scrollTimer = null;
    var scrollWidths = {}; // key -> { sig, width }
    var SCROLL_HOLD_TICKS = 6;
    var SCROLL_PX_PER_TICK = 2;

    function stopScrollLoop() {
        if (scrollTimer) {
            clearInterval(scrollTimer);
            scrollTimer = null;
        }
        scrollTick = 0;
    }

    function scrollSig(text, s, box) {
        return [text, s.font, s.size, s.letterSpacing, s.spaceWidth, box.w].join('|');
    }

    function scrollOffsetFor(root, key, text, s, box) {
        if (!s.scroll) return 0;
        var cached = scrollWidths[key];
        var sig = scrollSig(text, s, box);
        if (!cached || cached.sig !== sig) {
            scrollWidths[key] = { sig: sig, width: cached ? cached.width : 0 };
            if (window.NSLPreview && window.NSLPreview.measure) {
                window.NSLPreview.measure(text, s.font, s.size, s.letterSpacing, s.spaceWidth).then(function (w) {
                    var cur = scrollWidths[key];
                    if (cur && cur.sig === sig) cur.width = w;
                });
            }
            return 0;
        }
        var distance = Math.max(0, (cached.width || 0) - box.w);
        if (!distance) return 0;
        var run = Math.ceil(distance / SCROLL_PX_PER_TICK);
        var cycle = SCROLL_HOLD_TICKS * 2 + run;
        var t = scrollTick % cycle;
        if (t < SCROLL_HOLD_TICKS) return 0;
        if (t < SCROLL_HOLD_TICKS + run) {
            return Math.min(distance, (t - SCROLL_HOLD_TICKS) * SCROLL_PX_PER_TICK);
        }
        return distance;
    }

    function renderPreview(root) {
        var canvas = root.querySelector('#sign-canvas');
        if (!canvas || !window.NSLPreview) return;
        sizeCanvas(root);
        var D = edims();
        var state = collectState(root);
        var colors = {};
        var fonts = {};
        var boxes = {};
        var aligns = {};
        var valigns = {};
        var spacings = {};
        var scrolls = {};
        var scrollOffsets = {};
        GROUPS.forEach(function (group) {
            var s = state.styles[group.key];
            var fb = DEFAULTS.styles[group.key];
            colors[group.key] = s.color || fb.color;
            fonts[group.key] = { name: s.font, size: s.size };
            boxes[group.key] = s.box;
            aligns[group.key] = s.align;
            valigns[group.key] = s.valign;
            spacings[group.key] = { lineHeight: s.lineHeight, lineGap: s.lineGap, letterSpacing: s.letterSpacing, spaceWidth: s.spaceWidth };
        });
        var texts = { number: state.route, destination: state.destination, via: state.layout === 'none' ? '' : state.via };
        GROUPS.forEach(function (group) {
            var s = state.styles[group.key];
            scrolls[group.key] = !!s.scroll;
            scrollOffsets[group.key] = scrollOffsetFor(root, group.key, texts[group.key] || '', s, boxes[group.key]);
        });
        // Animate the marquee while any scroll flag is on; stop (and reset)
        // when none is, so the canvas goes back to a static render.
        var wantScroll = !!(state.styles.destination.scroll || state.styles.via.scroll);
        if (wantScroll && !scrollTimer) {
            scrollTimer = setInterval(function () {
                scrollTick++;
                renderPreview(root);
            }, 120);
        } else if (!wantScroll && scrollTimer) {
            stopScrollLoop();
        }
        window.NSLPreview.render(canvas, {
            layout: state.layout,
            number: state.route,
            destination: state.destination,
            via: state.via,
            width: D.w,
            height: D.h,
            colors: colors,
            fonts: fonts,
            boxes: boxes,
            aligns: aligns,
            valigns: valigns,
            spacings: spacings,
            scroll: scrolls,
            scrollOffsets: scrollOffsets,
            images: state.images || [],
            guides: state.guides,
            dots: state.dots
        });
    }

    // ---- Bitmaps: library, upload, per-page positioning ----

    function bitmapSay(root, text) {
        var el = root.querySelector('#bitmap-upload-status');
        if (el) el.textContent = text;
    }

    function fetchBitmaps() {
        return fetch('/api/bitmaps').then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        });
    }

    function shortName(path) {
        return String(path || '').split('/').pop();
    }

    function renderLibrary(root, files) {
        var box = root.querySelector('#bitmap-library');
        if (!box) return;
        box.innerHTML = '';
        if (!files.length) {
            box.innerHTML = '<p class="muted">No bitmaps yet — upload one above.</p>';
            return;
        }
        files.forEach(function (f) {
            var path = f.path || f;
            var cell = document.createElement('div');
            cell.className = 'bitmap-cell';
            var img = document.createElement('img');
            img.src = '/' + path;
            img.alt = shortName(path);
            img.loading = 'lazy';
            var label = document.createElement('span');
            label.textContent = shortName(path);
            label.title = path;
            var row = document.createElement('div');
            row.className = 'row';
            var add = document.createElement('button');
            add.type = 'button';
            add.textContent = 'Place';
            add.addEventListener('click', function () { addImageToPage(root, path); });
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'danger';
            del.textContent = 'Delete';
            del.setAttribute('aria-label', 'Delete ' + path);
            del.addEventListener('click', function () { deleteBitmap(root, path); });
            row.appendChild(add);
            row.appendChild(del);
            cell.appendChild(img);
            cell.appendChild(label);
            cell.appendChild(row);
            box.appendChild(cell);
        });
    }

    function refreshLibrary(root, say) {
        var box = root.querySelector('#bitmap-library');
        if (!box) return;
        if (say) box.innerHTML = '<p class="muted">Loading…</p>';
        fetchBitmaps()
            .then(function (files) { renderLibrary(root, files || []); })
            .catch(function (err) {
                console.error(err);
                box.innerHTML = '<p class="muted">Could not load bitmaps.</p>';
            });
    }

    function uploadBitmap(root) {
        var input = root.querySelector('#bitmap-file');
        var file = input && input.files && input.files[0];
        if (!file) {
            bitmapSay(root, 'Choose a file first');
            return;
        }
        bitmapSay(root, 'Uploading…');
        var reader = new FileReader();
        reader.onload = function () {
            fetch('/api/bitmaps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, data: String(reader.result || '') })
            })
                .then(function (response) {
                    return response.json().then(function (body) {
                        return { ok: response.ok, body: body };
                    });
                })
                .then(function (res) {
                    if (!res.ok) throw new Error((res.body && res.body.error) || 'upload failed');
                    bitmapSay(root, 'Uploaded ' + shortName(res.body.path));
                    if (input) input.value = '';
                    refreshLibrary(root, false);
                })
                .catch(function (err) {
                    console.error(err);
                    bitmapSay(root, 'Upload failed: ' + err.message);
                });
        };
        reader.onerror = function () { bitmapSay(root, 'Could not read file'); };
        reader.readAsDataURL(file);
    }

    function deleteBitmap(root, path) {
        if (!window.confirm('Delete ' + shortName(path) + '? Pages using it will show text only.')) return;
        fetch('/api/bitmaps/' + path, { method: 'DELETE' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function () { refreshLibrary(root, false); })
            .catch(function (err) {
                console.error(err);
                bitmapSay(root, 'Delete failed');
            });
    }

    function addImageToPage(root, path) {
        var images = readPageImages(root);
        if (images.length >= 8) {
            bitmapSay(root, 'A page holds at most 8 bitmaps');
            return;
        }
        if (images.some(function (im) { return im.src === path; })) {
            bitmapSay(root, 'Already on this page — adjust X/Y below');
            return;
        }
        images.push({ src: path, x: 0, y: 0 });
        setPageImages(root, images);
        renderPreview(root);
        save(root);
    }

    function renderPageImages(root) {
        var box = root.querySelector('#page-images');
        if (!box) return;
        var images = window.__nslImages || [];
        box.innerHTML = '';
        if (!images.length) {
            box.innerHTML = '<p class="muted">None yet — pick Place in the library.</p>';
            return;
        }
        images.forEach(function (spec, idx) {
            var row = document.createElement('div');
            row.className = 'page-image';
            row.dataset.src = spec.src;
            var head = document.createElement('div');
            head.className = 'head';
            var thumb = document.createElement('img');
            thumb.src = '/' + spec.src;
            thumb.alt = shortName(spec.src);
            var name = document.createElement('span');
            name.textContent = shortName(spec.src);
            name.title = spec.src;
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', 'Remove ' + spec.src);
            remove.dataset.removeImage = String(idx);
            head.appendChild(thumb);
            head.appendChild(name);
            head.appendChild(remove);
            var grid = document.createElement('div');
            grid.className = 'grid';
            [['x', 'X', 0], ['y', 'Y', 0], ['w', 'W', ''], ['h', 'H', '']].forEach(function (f) {
                var label = document.createElement('label');
                label.textContent = f[1];
                var input = document.createElement('input');
                input.type = 'number';
                input.dataset.field = f[0];
                input.dataset.idx = String(idx);
                input.value = spec[f[0]] !== undefined ? spec[f[0]] : f[2];
                if (f[0] === 'x' || f[0] === 'y') {
                    input.min = f[0] === 'x' ? -1024 : -256;
                    input.max = f[0] === 'x' ? 1024 : 256;
                } else {
                    input.min = 1;
                    input.max = 1024;
                    input.placeholder = 'auto';
                }
                label.appendChild(input);
                grid.appendChild(label);
            });
            row.appendChild(head);
            row.appendChild(grid);
            box.appendChild(row);
        });
    }

    function loadCtx() {
        try {
            var raw = localStorage.getItem(CTX_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    function pageElement(text, s) {
        var el = {
            text: text,
            font: (s.font || 'johnston100') + '-' + (s.size || '20'),
            colour: s.color || '#DB7700',
            from_X: s.box.x,
            to_X: s.box.x + s.box.w,
            front_Y: s.box.y,
            to_Y: s.box.y + s.box.h,
            align: s.align || 'center',
            valign: s.valign || 'middle'
        };
        // Only store non-default spacing, so .dest files stay clean.
        if (s.lineHeight !== undefined && s.lineHeight !== null && s.lineHeight !== '') {
            var lh = parseInt(s.lineHeight, 10);
            if (!isNaN(lh) && lh >= 1 && lh <= 256) el.line_height = lh;
        }
        if (s.lineGap !== undefined && s.lineGap !== null && s.lineGap !== '' && parseInt(s.lineGap, 10)) {
            var lg = parseInt(s.lineGap, 10);
            if (!isNaN(lg)) el.line_gap = Math.max(-64, Math.min(200, lg));
        }
        if (s.letterSpacing !== undefined && s.letterSpacing !== null && s.letterSpacing !== '' && parseInt(s.letterSpacing, 10)) {
            var ls = parseInt(s.letterSpacing, 10);
            if (!isNaN(ls)) el.letter_spacing = Math.max(-20, Math.min(40, ls));
        }
        if (s.spaceWidth !== undefined && s.spaceWidth !== null && s.spaceWidth !== '') {
            var sw = parseInt(s.spaceWidth, 10);
            if (!isNaN(sw)) el.space_width = Math.max(0, Math.min(64, sw));
        }
        // Marquee on overflow: board + preview scroll over-wide text.
        if (s.scroll) el.scroll = true;
        return el;
    }

    function buildPage(state) {
        var page = {
            number: pageElement(state.route, state.styles.number),
            destination: pageElement(state.destination, state.styles.destination),
            via: pageElement(state.via, state.styles.via)
        };
        if (state.images && state.images.length) {
            page.images = state.images.map(function (im) {
                return cleanImageSpec(im);
            }).filter(Boolean);
        }
        return page;
    }

    function renderPageLink(root) {
        var box = root.querySelector('#page-link');
        if (!box) return;
        box.innerHTML = '';
        var ctx = loadCtx();
        if (!ctx || !ctx.program) return;
        var p = document.createElement('p');
        p.textContent = 'Linked page: ' + ctx.program + ' › service ' + ctx.service + ' › ' + ctx.destination + ' › ' + ctx.page;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-primary';
        btn.textContent = 'Update page in program';
        btn.addEventListener('click', function () { updatePage(root, ctx, btn); });
        var status = document.createElement('span');
        status.className = 'page-link-status';
        box.appendChild(p);
        box.appendChild(btn);
        box.appendChild(status);
    }

    function updatePage(root, ctx, btn) {
        var state = collectState(root);
        var status = root.querySelector('#page-link .page-link-status');
        function say(text) {
            if (status) status.textContent = text;
        }
        say('Saving…');
        if (btn) btn.disabled = true;
        fetch('/api/programs/' + encodeURIComponent(ctx.program))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (prog) {
                // Upsert: create any missing level instead of failing.
                if (!prog.services || typeof prog.services !== 'object') prog.services = {};
                if (!prog.services[ctx.service] || typeof prog.services[ctx.service] !== 'object') {
                    prog.services[ctx.service] = {};
                }
                var services = prog.services[ctx.service];
                if (!services[ctx.destination] || typeof services[ctx.destination] !== 'object') {
                    services[ctx.destination] = { service_code: '', service_name: ctx.destination };
                }
                var dest = services[ctx.destination];
                if (!dest.text || typeof dest.text !== 'object') dest.text = {};
                dest.text[ctx.page] = buildPage(state);
                return fetch('/api/programs/' + encodeURIComponent(ctx.program), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prog)
                }).then(function (put) {
                    if (!put.ok) throw new Error('HTTP ' + put.status);
                    return prog;
                });
            })
            .then(function (prog) {
                // Keep the Program tab's unsaved working copy in sync.
                try {
                    var raw = localStorage.getItem('nsl.programDraft.' + ctx.program);
                    if (raw) {
                        var working = JSON.parse(raw);
                        if (!working.services) working.services = {};
                        if (!working.services[ctx.service]) working.services[ctx.service] = {};
                        working.services[ctx.service][ctx.destination] =
                            prog.services[ctx.service][ctx.destination];
                        localStorage.setItem('nsl.programDraft.' + ctx.program, JSON.stringify(working));
                    }
                } catch (err) { /* ignore */ }
                say('Page updated ' + fmtTime(Date.now()));
            })
            .catch(function (err) {
                console.error(err);
                say('Update failed');
            })
            .then(function () {
                if (btn) btn.disabled = false;
            });
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function nextPageKey(text) {
        var max = -1;
        Object.keys(text || {}).forEach(function (k) {
            var m = /^(\d+):?$/.exec(k);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return (max + 1) + ':';
    }

    function splitFontName(f) {
        var s = String(f || '');
        var i = s.lastIndexOf('-');
        if (i < 0) return { name: s, size: '' };
        return { name: s.slice(0, i), size: s.slice(i + 1) };
    }

    function numOr(v, fallback) {
        var n = parseInt(v, 10);
        return isNaN(n) ? fallback : n;
    }

    var LINK_FALLBACK_BOXES = {
        number: { x: 210, y: 0, w: 30, h: 40 },
        destination: { x: 0, y: 0, w: 220, h: 26 },
        via: { x: 0, y: 26, w: 220, h: 14 }
    };

    function oneOf(v, allowed, fallback) {
        return allowed.indexOf(v) >= 0 ? v : fallback;
    }

    function spacingFromPage(el) {
        el = el || {};
        var lh = (el.line_height === undefined || el.line_height === null || el.line_height === '')
            ? null : parseInt(el.line_height, 10);
        if (lh === null || isNaN(lh) || lh < 1 || lh > 256) lh = null;
        var lg = parseInt(el.line_gap, 10);
        if (isNaN(lg)) lg = 0;
        var ls = parseInt(el.letter_spacing, 10);
        if (isNaN(ls)) ls = 0;
        var sw = (el.space_width === undefined || el.space_width === null || el.space_width === '')
            ? null : parseInt(el.space_width, 10);
        if (sw !== null && (isNaN(sw) || sw < 0 || sw > 64)) sw = null;
        return { lineHeight: lh, lineGap: Math.max(-64, Math.min(200, lg)),
                 letterSpacing: Math.max(-20, Math.min(40, ls)),
                 spaceWidth: sw };
    }

    function styleFromPage(el, fb) {
        el = el || {};
        var split = splitFontName(el.font);
        var D = edims();
        var y = numOr(el.front_Y != null ? el.front_Y : el.from_Y, fb.y);
        var x = numOr(el.from_X, fb.x);
        var w = numOr(el.to_X, fb.x + fb.w) - x;
        var h = numOr(el.to_Y, fb.y + fb.h) - y;
        var spacing = spacingFromPage(el);
        return {
            font: split.name, size: split.size,
            color: el.colour || '#DB7700',
            align: oneOf(el.align, ['left', 'center', 'right'], 'center'),
            valign: oneOf(el.valign, ['top', 'middle', 'bottom'], 'middle'),
            lineHeight: spacing.lineHeight,
            lineGap: spacing.lineGap,
            letterSpacing: spacing.letterSpacing,
            spaceWidth: spacing.spaceWidth,
            box: {
                x: Math.max(0, Math.min(D.w - 1, x)),
                y: Math.max(0, Math.min(D.h - 1, y)),
                w: w >= 1 && w <= D.w ? w : fb.w,
                h: h >= 1 && h <= D.h ? h : fb.h
            }
        };
    }

    function imagesFromPage(page) {
        var raw = page.images;
        if (!Array.isArray(raw)) raw = page.bitmaps; // legacy shape
        var out = [];
        (raw || []).forEach(function (spec) {
            var c = cleanImageSpec(spec);
            if (c) out.push(c);
        });
        return out.slice(0, 8);
    }

    function draftFromPage(page) {
        return {
            v: 1,
            route: ((page.number || {}).text) || '',
            destination: ((page.destination || {}).text) || '',
            via: ((page.via || {}).text) || '',
        layout: 'bottom',
        numberSide: 'right',
            guides: false,
            dots: true,
            outerTab: 0,
            innerTab: 0,
            images: imagesFromPage(page || {}),
            styles: {
                number: styleFromPage(page.number, LINK_FALLBACK_BOXES.number),
                destination: styleFromPage(page.destination, LINK_FALLBACK_BOXES.destination),
                via: styleFromPage(page.via, LINK_FALLBACK_BOXES.via)
            },
            updatedAt: Date.now()
        };
    }

    function fetchProgram(name) {
        return fetch('/api/programs/' + encodeURIComponent(name)).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        });
    }

    function linkedDestination(prog, ctx) {
        var dest = prog.services && prog.services[ctx.service] && prog.services[ctx.service][ctx.destination];
        return (dest && dest.text && typeof dest.text === 'object') ? dest : null;
    }

    function sortedPageKeys(text) {
        return Object.keys(text).sort(function (a, b) {
            function n(k) {
                var m = /^(\d+)/.exec(k);
                return m ? parseInt(m[1], 10) : 9999;
            }
            return n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0);
        });
    }

    function renderPages(root) {
        var list = root.querySelector('#pages-list');
        var addBtn = root.querySelector('#add-page');
        if (!list) return;
        var ctx = loadCtx();
        if (!ctx || !ctx.program) {
            list.innerHTML = '<p class="muted">Open a page from the Program tab to manage its pages here.</p>';
            if (addBtn) addBtn.hidden = true;
            return;
        }
        if (addBtn) addBtn.hidden = false;
        list.innerHTML = '<p class="muted">Loading…</p>';
        fetchProgram(ctx.program)
            .then(function (prog) {
                var dest = linkedDestination(prog, ctx);
                if (!dest) {
                    list.innerHTML = '<p class="muted">Destination no longer exists.</p>';
                    return;
                }
                var keys = sortedPageKeys(dest.text);
                if (!keys.length) {
                    list.innerHTML = '<p class="muted">No pages yet.</p>';
                    return;
                }
                var html = '<div class="page-list">';
                keys.forEach(function (key, idx) {
                    var d = ((dest.text[key] || {}).destination || {}).text || '';
                    var current = key === ctx.page;
                    html += '<span class="page-chip"><button type="button" data-page="' + esc(key) + '"' +
                        (current ? ' class="active" disabled' : '') + '>' +
                        esc(key + (d ? ' ' + d : '')) + '</button>' +
                        '<button type="button" data-shift-page="' + esc(key) + '" data-dir="-1"' +
                        (idx === 0 ? ' disabled' : '') +
                        ' aria-label="Move page ' + esc(key) + ' earlier">◀</button>' +
                        '<button type="button" data-shift-page="' + esc(key) + '" data-dir="1"' +
                        (idx === keys.length - 1 ? ' disabled' : '') +
                        ' aria-label="Move page ' + esc(key) + ' later">▶</button>' +
                        '<button type="button" data-delete-page="' + esc(key) +
                        '" aria-label="Delete page ' + esc(key) + '">×</button></span>';
                });
                list.innerHTML = html + '</div>';
            })
            .catch(function (err) {
                console.error(err);
                list.innerHTML = '<p class="muted">Could not load pages.</p>';
            });
    }

    function loadLinkedPage(root, pageKey) {
        var ctx = loadCtx();
        if (!ctx || !ctx.program) return Promise.resolve();
        setStatus(root, 'Loading page…');
        return fetchProgram(ctx.program)
            .then(function (prog) {
                var dest = linkedDestination(prog, ctx);
                var page = dest && dest.text[pageKey];
                if (!page) throw new Error('page no longer exists');
                var draft = draftFromPage(page);
                // Stay on the tabs the user already has open.
                draft.outerTab = activeIndex(root, '.side-bar > .tabs');
                draft.innerTab = activeIndex(root, '.sign-attributes > .tabs');
                applyState(root, draft);
                try {
                    localStorage.setItem(CTX_KEY, JSON.stringify({
                        program: ctx.program, service: ctx.service,
                        destination: ctx.destination, page: pageKey
                    }));
                } catch (err) { /* ignore */ }
                renderPreview(root);
                renderPageLink(root);
                renderPages(root);
                return loadFonts(root);
            })
            .then(function () {
                renderPreview(root);
                save(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load page');
            });
    }

    function shiftLinkedPage(root, pageKey, dir) {
        var ctx = loadCtx();
        if (!ctx || !ctx.program) return;
        setStatus(root, 'Reordering…');
        fetchProgram(ctx.program)
            .then(function (prog) {
                var dest = linkedDestination(prog, ctx);
                if (!dest || !dest.text[pageKey]) throw new Error('page no longer exists');
                var keys = sortedPageKeys(dest.text);
                var i = keys.indexOf(pageKey);
                var j = i + dir;
                if (i < 0 || j < 0 || j >= keys.length) throw new Error('at end');
                var tmp = dest.text[keys[i]];
                dest.text[keys[i]] = dest.text[keys[j]];
                dest.text[keys[j]] = tmp;
                return fetch('/api/programs/' + encodeURIComponent(ctx.program), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prog)
                }).then(function (put) {
                    if (!put.ok) throw new Error('HTTP ' + put.status);
                    return prog;
                });
            })
            .then(function (prog) {
                // Keep the Program tab's unsaved working copy in sync.
                try {
                    var raw = localStorage.getItem('nsl.programDraft.' + ctx.program);
                    if (raw) {
                        var working = JSON.parse(raw);
                        var dest = working.services && working.services[ctx.service] &&
                            working.services[ctx.service][ctx.destination];
                        if (dest) {
                            dest.text = prog.services[ctx.service][ctx.destination].text;
                            localStorage.setItem('nsl.programDraft.' + ctx.program, JSON.stringify(working));
                        }
                    }
                } catch (err) { /* ignore */ }
                // The current draft now shows the neighbour's content (keys are
                // stable, contents swapped) - reload the same key so the
                // editor + preview match the new rotation.
                return loadLinkedPage(root, ctx.page);
            })
            .catch(function (err) {
                console.error(err);
                if (err.message !== 'at end') setStatus(root, 'Could not reorder page');
            });
    }

    function deleteLinkedPage(root, pageKey) {
        var ctx = loadCtx();
        if (!ctx || !ctx.program) return;
        if (!window.confirm('Delete page ' + pageKey + ' of ' + ctx.destination + '?')) return;
        setStatus(root, 'Deleting page…');
        fetchProgram(ctx.program)
            .then(function (prog) {
                var dest = linkedDestination(prog, ctx);
                if (!dest || !dest.text[pageKey]) throw new Error('page no longer exists');
                if (Object.keys(dest.text).length <= 1) throw new Error('last page');
                delete dest.text[pageKey];
                return fetch('/api/programs/' + encodeURIComponent(ctx.program), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prog)
                }).then(function (put) {
                    if (!put.ok) throw new Error('HTTP ' + put.status);
                    return prog;
                });
            })
            .then(function (prog) {
                // Keep the Program tab's unsaved working copy in sync.
                try {
                    var raw = localStorage.getItem('nsl.programDraft.' + ctx.program);
                    if (raw) {
                        var working = JSON.parse(raw);
                        var dest = working.services && working.services[ctx.service] &&
                            working.services[ctx.service][ctx.destination];
                        if (dest) {
                            dest.text = prog.services[ctx.service][ctx.destination].text;
                            localStorage.setItem('nsl.programDraft.' + ctx.program, JSON.stringify(working));
                        }
                    }
                } catch (err) { /* ignore */ }
                if (ctx.page === pageKey) {
                    var remaining = sortedPageKeys(prog.services[ctx.service][ctx.destination].text);
                    return loadLinkedPage(root, remaining[0]);
                }
                renderPages(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, err.message === 'last page'
                    ? 'A destination needs at least one page'
                    : 'Could not delete page');
            });
    }

    function addLinkedPage(root) {
        var ctx = loadCtx();
        if (!ctx || !ctx.program) return;
        setStatus(root, 'Adding page…');
        // The new page inherits the current draft's route, destination and
        // styling - only the new content (usually the via) needs typing.
        var state = collectState(root);
        var inherited = buildPage({
            route: state.route,
            destination: state.destination,
            via: '',
            styles: state.styles,
            images: state.images
        });
        var freshText = null;
        fetchProgram(ctx.program)
            .then(function (prog) {
                var dest = linkedDestination(prog, ctx);
                if (!dest) throw new Error('destination no longer exists');
                var key = nextPageKey(dest.text);
                dest.text[key] = inherited;
                freshText = dest.text;
                return fetch('/api/programs/' + encodeURIComponent(ctx.program), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prog)
                }).then(function (put) {
                    if (!put.ok) throw new Error('HTTP ' + put.status);
                    return key;
                });
            })
            .then(function (key) {
                // Keep the Program tab's unsaved working copy in sync.
                try {
                    var raw = localStorage.getItem('nsl.programDraft.' + ctx.program);
                    if (raw) {
                        var working = JSON.parse(raw);
                        var dest = working.services && working.services[ctx.service] &&
                            working.services[ctx.service][ctx.destination];
                        if (dest) {
                            dest.text = freshText;
                            localStorage.setItem('nsl.programDraft.' + ctx.program, JSON.stringify(working));
                        }
                    }
                } catch (err) { /* ignore */ }
                return loadLinkedPage(root, key);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not add page');
            });
    }

    function doClear(root) {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) { /* ignore */ }
        // Reset to the user's Settings defaults (fresh-draft shape).
        var def = defaultDraft();
        setVal(root, 'route-number', '');
        setVal(root, 'sign-destination', '');
        setVal(root, 'sign-via', '');
        setVal(root, 'sign-layout', def.layout || 'bottom');
        setVal(root, 'number-side', 'right');
        var guidesEl = $(root, 'show-guides');
        if (guidesEl) guidesEl.checked = false;
        var dotsEl = $(root, 'show-dots');
        if (dotsEl) dotsEl.checked = true;
        applyPreset(root, def.layout || 'bottom');
        GROUPS.forEach(function (group) {
            var fb = (def.styles || {})[group.key] || DEFAULTS.styles[group.key];
            setVal(root, group.colorId, fb.color);
            setVal(root, group.alignId, fb.align);
            setVal(root, group.valignId, fb.valign);
            setVal(root, group.lhId, '');
            setVal(root, group.lgId, 0);
            setVal(root, group.lsId, 0);
            setVal(root, group.spaceId, '');
            // Fonts + sizes resolve async; stash what to select once loaded.
            var fontEl = $(root, group.fontId);
            if (fontEl) fontEl.dataset.pending = fb.font || '';
            var sizeEl = $(root, group.sizeId);
            if (sizeEl) sizeEl.dataset.pending = fb.size || '';
        });
        loadFonts(root).then(function () { renderPreview(root); save(root, false); });
        markActive(root, '.side-bar > .tabs', 0);
        markActive(root, '.sign-attributes > .tabs', 0);
        setPageImages(root, []);
        renderPreview(root);
        setStatus(root, 'Draft cleared');
    }

    function fmtTime(ts) {
        try {
            return new Date(ts).toLocaleTimeString();
        } catch (err) {
            return '';
        }
    }

    function setStatus(root, text) {
        root.querySelectorAll('.save-status').forEach(function (node) {
            node.textContent = text;
        });
    }

    function save(root, announce) {
        var state = collectState(root);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (err) {
            setStatus(root, 'Autosave unavailable');
            return;
        }
        if (announce !== false) setStatus(root, 'Autosaved ' + fmtTime(state.updatedAt));
    }

    function previewSay(root, text) {
        var el = root.querySelector('#board-preview .preview-status');
        if (el) el.textContent = text;
    }

    function showStop(root, show) {
        var btn = root.querySelector('#stop-preview');
        if (btn) btn.hidden = !show;
        var start = root.querySelector('#preview-board');
        if (start) start.disabled = !!show;
    }

    // Push the current draft to the physical board for 60s, exactly as the
    // canvas preview shows it (same boxes, fonts, colours, alignment).
    function startBoardPreview(root) {
        var state = collectState(root);
        var D = edims();
        previewSay(root, 'Sending to board…');
        fetch('/api/board/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                page: buildPage(state),
                width: D.w,
                height: D.h,
                seconds: 60
            })
        })
            .then(function (response) {
                return response.json().then(function (body) {
                    return { ok: response.ok, body: body };
                });
            })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) || 'failed');
                previewSay(root, 'On the board for 60s (pauses the normal display).');
                showStop(root, true);
            })
            .catch(function (err) {
                console.error(err);
                previewSay(root, 'Preview failed: ' + err.message);
            });
    }

    function stopBoardPreview(root) {
        previewSay(root, 'Stopping…');
        fetch('/api/board/preview', { method: 'DELETE' })
            .then(function () {
                previewSay(root, '');
                showStop(root, false);
            })
            .catch(function (err) {
                console.error(err);
                previewSay(root, 'Stop failed');
            });
    }

    function refresh(root) {
        stopScrollLoop(); // drop any timer bound to the previous partial DOM
        var draft = loadDraft();
        applyState(root, draft || defaultDraft());
        renderPreview(root);
        renderPageLink(root);
        renderPages(root);
        refreshLibrary(root, true);
        loadFonts(root).then(function () {
            renderPreview(root);
            if (draft) {
                save(root); // persist any migrated shape
                setStatus(root, 'Draft restored · saved ' + fmtTime(draft.updatedAt));
            } else {
                save(root, false);
                setStatus(root, 'Autosave on');
            }
        });
    }

    function init(root) {
        // The partial DOM is re-injected on every visit, so refresh every
        // time but bind listeners only once (they live on the stable root).
        if (!root || !root.querySelector('#sign-destination')) return;
        refresh(root);
        if (root.dataset.editorInit) return;
        root.dataset.editorInit = '1';

        var timer = null;
        function scheduleSave() {
            renderPreview(root);
            clearTimeout(timer);
            timer = setTimeout(function () { save(root); }, SAVE_DELAY_MS);
        }

        root.addEventListener('input', function (event) {
            var t = event.target;
            if (!t) return;
            // Bitmap X/Y/W/H fields have no id, only data-field.
            if (t.dataset && t.dataset.field) {
                scheduleSave();
                return;
            }
            if (!t.id) return;
            var group = GROUPS.find(function (g) {
                return g.fontId === t.id;
            });
            if (group) {
                renderPreview(root);
                loadSizes(root, group).then(function () { renderPreview(root); save(root); });
                return;
            }
            // Layout rearranges positions, but never resizes: widths/heights
            // are always preserved, only x/y move - and only if needed.
            if (t.id === 'sign-layout') {
                applySmartLayout(root, t.value);
            } else if (t.id === 'number-side') {
                applyNumberSide(root, t.value);
            }
            scheduleSave();
        });
        root.addEventListener('change', scheduleSave);

        // Delegated: the partial DOM is replaced on every load, so never
        // bind directly to nodes inside it.
        root.addEventListener('click', function (event) {
            var clear = event.target.closest ? event.target.closest('#clear-draft') : null;
            if (clear) {
                doClear(root);
                return;
            }
            var uploadBtn = event.target.closest ? event.target.closest('#bitmap-upload') : null;
            if (uploadBtn) {
                uploadBitmap(root);
                return;
            }
            var removeImg = event.target.closest ? event.target.closest('[data-remove-image]') : null;
            if (removeImg) {
                var images = readPageImages(root);
                images.splice(parseInt(removeImg.dataset.removeImage, 10) || 0, 1);
                setPageImages(root, images);
                renderPreview(root);
                save(root);
                return;
            }
            var stepBtn = event.target.closest ? event.target.closest('[data-size-step]') : null;
            if (stepBtn) {
                stepSize(root, stepBtn, scheduleSave);
                return;
            }
            var shiftPageBtn = event.target.closest ? event.target.closest('#pages-list [data-shift-page]') : null;
            if (shiftPageBtn && !shiftPageBtn.disabled) {
                var dir = parseInt(shiftPageBtn.dataset.dir, 10);
                shiftLinkedPage(root, shiftPageBtn.dataset.shiftPage, isNaN(dir) ? 0 : dir);
                return;
            }
            var pageBtn = event.target.closest ? event.target.closest('#pages-list [data-page]') : null;
            if (pageBtn && !pageBtn.disabled) {
                loadLinkedPage(root, pageBtn.dataset.page);
                return;
            }
            var delPageBtn = event.target.closest ? event.target.closest('#pages-list [data-delete-page]') : null;
            if (delPageBtn) {
                deleteLinkedPage(root, delPageBtn.dataset.deletePage);
                return;
            }
            var addPageBtn = event.target.closest ? event.target.closest('#add-page') : null;
            if (addPageBtn) {
                addLinkedPage(root);
                return;
            }
            var previewBtn = event.target.closest ? event.target.closest('#preview-board') : null;
            if (previewBtn && !previewBtn.disabled) {
                startBoardPreview(root);
                return;
            }
            var stopBtn = event.target.closest ? event.target.closest('#stop-preview') : null;
            if (stopBtn) {
                stopBoardPreview(root);
                return;
            }
            // Persist tab switches too (runs after the tabs.js handler).
            if (event.target.closest && event.target.closest('.tabs .tab button')) {
                setTimeout(function () { save(root, false); }, 0);
            }
        });
    }

    window.NSLEditor = { init: init };
})();
