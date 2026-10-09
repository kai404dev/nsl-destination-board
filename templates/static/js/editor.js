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
          xId: 'number-x', yId: 'number-y', wId: 'number-w', hId: 'number-h', alignId: 'number-align', valignId: 'number-valign' },
        { key: 'destination', textId: 'sign-destination', fontId: 'dest-font', sizeId: 'dest-size', colorId: 'dest-color',
          xId: 'dest-x', yId: 'dest-y', wId: 'dest-w', hId: 'dest-h', alignId: 'dest-align', valignId: 'dest-valign' },
        { key: 'via', textId: 'sign-via', fontId: 'via-font', sizeId: 'via-size', colorId: 'via-color',
          xId: 'via-x', yId: 'via-y', wId: 'via-w', hId: 'via-h', alignId: 'via-align', valignId: 'via-valign' }
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
            number: { x: 210, y: 0, w: 30, h: 40 },
            destination: { x: 0, y: 0, w: 220, h: 26 },
            via: { x: 0, y: 26, w: 220, h: 14 }
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
        styles: {
            number: { font: '', size: '', color: '#db9600', align: 'center', valign: 'middle', box: { x: 210, y: 0, w: 30, h: 40 } },
            destination: { font: '', size: '', color: '#db9600', align: 'center', valign: 'middle', box: { x: 0, y: 0, w: 220, h: 26 } },
            via: { font: '', size: '', color: '#db9600', align: 'center', valign: 'middle', box: { x: 0, y: 26, w: 220, h: 14 } }
        }
    };

    function $(root, id) {
        return root.querySelector('#' + id);
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
                box: {
                    x: num(root, group.xId, 0, 239, fb.box.x),
                    y: num(root, group.yId, 0, 39, fb.box.y),
                    w: num(root, group.wId, 1, 240, fb.box.w),
                    h: num(root, group.hId, 1, 40, fb.box.h)
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
            guides: !!(guidesEl && guidesEl.checked),
            dots: !dotsEl || dotsEl.checked,
            outerTab: activeIndex(root, '.side-bar > .tabs'),
            innerTab: activeIndex(root, '.sign-attributes > .tabs'),
            styles: styles,
            updatedAt: Date.now()
        };
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
            setBox(root, group, saved.box || fb.box);
            // Fonts + sizes resolve async; stash what to select once loaded.
            var fontEl = $(root, group.fontId);
            if (fontEl) fontEl.dataset.pending = saved.font || '';
            var sizeEl = $(root, group.sizeId);
            if (sizeEl) sizeEl.dataset.pending = saved.size || '';
        });
        markActive(root, '.side-bar > .tabs', state.outerTab || 0);
        markActive(root, '.sign-attributes > .tabs', state.innerTab || 0);
    }

    function setBox(root, group, box) {
        setVal(root, group.xId, box.x);
        setVal(root, group.yId, box.y);
        setVal(root, group.wId, box.w);
        setVal(root, group.hId, box.h);
    }

    function applyPreset(root, layout) {
        var preset = LAYOUT_PRESETS[layout] || LAYOUT_PRESETS.top;
        GROUPS.forEach(function (group) {
            setBox(root, group, preset[group.key]);
        });
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

    function fillSelect(selectEl, items, pendingValue, fallbackIndex) {
        selectEl.innerHTML = '';
        if (!items.length) {
            var opt = document.createElement('option');
            opt.textContent = 'None available';
            selectEl.appendChild(opt);
            return;
        }
        items.forEach(function (item) {
            var option = document.createElement('option');
            option.value = String(item);
            option.textContent = String(item);
            selectEl.appendChild(option);
        });
        var pending = pendingValue || selectEl.dataset.pending || '';
        var match = items.map(String).indexOf(String(pending));
        selectEl.selectedIndex = match >= 0 ? match : Math.min(fallbackIndex, items.length - 1);
        selectEl.dataset.pending = '';
    }

    function nearestIndex(sizes, target) {
        var best = 0;
        sizes.forEach(function (size, i) {
            if (Math.abs(size - target) < Math.abs(sizes[best] - target)) best = i;
        });
        return best;
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
        var preferred = { number: 45, destination: 33, via: 20 }[group.key] || 20;
        return fetch('/api/sizes/' + encodeURIComponent(fontEl.value))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (sizes) {
                fillSelect(sizeEl, sizes, '', nearestIndex(sizes, preferred));
            })
            .catch(function (err) {
                console.error(err);
            });
    }

    function renderPreview(root) {
        var canvas = root.querySelector('#sign-canvas');
        if (!canvas || !window.NSLPreview) return;
        var state = collectState(root);
        var colors = {};
        var fonts = {};
        var boxes = {};
        var aligns = {};
        var valigns = {};
        GROUPS.forEach(function (group) {
            var s = state.styles[group.key];
            var fb = DEFAULTS.styles[group.key];
            colors[group.key] = s.color || fb.color;
            fonts[group.key] = { name: s.font, size: s.size };
            boxes[group.key] = s.box;
            aligns[group.key] = s.align;
            valigns[group.key] = s.valign;
        });
        window.NSLPreview.render(canvas, {
            layout: state.layout,
            number: state.route,
            destination: state.destination,
            via: state.via,
            colors: colors,
            fonts: fonts,
            boxes: boxes,
            aligns: aligns,
            valigns: valigns,
            guides: state.guides,
            dots: state.dots
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
        return {
            text: text,
            font: (s.font || 'johnston100') + '-' + (s.size || '20'),
            colour: s.color || '#db9600',
            from_X: s.box.x,
            to_X: s.box.x + s.box.w,
            front_Y: s.box.y,
            to_Y: s.box.y + s.box.h
        };
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
                var dest = prog.services && prog.services[ctx.service] && prog.services[ctx.service][ctx.destination];
                if (!dest || !dest.text || !dest.text[ctx.page]) throw new Error('page no longer exists');
                dest.text[ctx.page] = {
                    number: pageElement(state.route, state.styles.number),
                    destination: pageElement(state.destination, state.styles.destination),
                    via: pageElement(state.via, state.styles.via)
                };
                return fetch('/api/programs/' + encodeURIComponent(ctx.program), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(prog)
                }).then(function (put) {
                    if (!put.ok) throw new Error('HTTP ' + put.status);
                    return put.json();
                });
            })
            .then(function () {
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

    function doClear(root) {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) { /* ignore */ }
        setVal(root, 'route-number', '');
        setVal(root, 'sign-destination', '');
        setVal(root, 'sign-via', '');
        setVal(root, 'sign-layout', 'bottom');
        var guidesEl = $(root, 'show-guides');
        if (guidesEl) guidesEl.checked = false;
        var dotsEl = $(root, 'show-dots');
        if (dotsEl) dotsEl.checked = true;
        applyPreset(root, 'bottom');
        GROUPS.forEach(function (group) {
            var fb = DEFAULTS.styles[group.key];
            setVal(root, group.colorId, fb.color);
            setVal(root, group.alignId, fb.align);
            setVal(root, group.valignId, fb.valign);
            var fontEl = $(root, group.fontId);
            if (fontEl && fontEl.options.length) fontEl.selectedIndex = 0;
        });
        GROUPS.forEach(function (group) {
            loadSizes(root, group).then(function () { renderPreview(root); });
        });
        markActive(root, '.side-bar > .tabs', 0);
        markActive(root, '.sign-attributes > .tabs', 0);
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

    function refresh(root) {
        var draft = loadDraft();
        applyState(root, draft || DEFAULTS);
        renderPreview(root);
        renderPageLink(root);
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
            if (!t || !t.id) return;
            var group = GROUPS.find(function (g) {
                return g.fontId === t.id;
            });
            if (group) {
                renderPreview(root);
                loadSizes(root, group).then(function () { renderPreview(root); save(root); });
                return;
            }
            // Layout changes never touch custom positions; boxes are manual.
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
            // Persist tab switches too (runs after the tabs.js handler).
            if (event.target.closest && event.target.closest('.tabs .tab button')) {
                setTimeout(function () { save(root, false); }, 0);
            }
        });
    }

    window.NSLEditor = { init: init };
})();
