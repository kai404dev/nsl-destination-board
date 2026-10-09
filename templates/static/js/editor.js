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
            number: { font: '', size: '', color: '#DB7700', align: 'center', valign: 'middle', box: { x: 210, y: 0, w: 30, h: 40 } },
            destination: { font: '', size: '', color: '#DB7700', align: 'center', valign: 'middle', box: { x: 0, y: 0, w: 220, h: 26 } },
            via: { font: '', size: '', color: '#DB7700', align: 'center', valign: 'middle', box: { x: 0, y: 26, w: 220, h: 14 } }
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
        var preset = LAYOUT_PRESETS[layout] || LAYOUT_PRESETS.bottom;
        GROUPS.forEach(function (group) {
            setBox(root, group, preset[group.key]);
        });
    }

    // Smart layout: rearrange boxes for the new layout, moving as little as
    // possible. Widths/heights are never touched - only x/y.
    function applySmartLayout(root, layout) {
        var boxes = {};
        GROUPS.forEach(function (group) {
            var fb = DEFAULTS.styles[group.key].box;
            boxes[group.key] = {
                x: num(root, group.xId, 0, 239, fb.x),
                y: num(root, group.yId, 0, 39, fb.y),
                w: num(root, group.wId, 1, 240, fb.w),
                h: num(root, group.hId, 1, 40, fb.h)
            };
        });
        var number = boxes.number;
        var dest = boxes.destination;
        var via = boxes.via;

        if (layout === 'left') {
            number.x = 0;
            var edge = number.x + number.w + 2;
            if (dest.x < edge) dest.x = Math.min(edge, 240 - dest.w);
            if (via.x < edge) via.x = Math.min(edge, 240 - via.w);
        } else if (layout === 'top' || layout === 'right') {
            number.x = Math.max(0, 240 - number.w);
            stackAbove(via, dest); // via above dest
        } else if (layout === 'bottom') {
            number.x = Math.max(0, 240 - number.w);
            stackAbove(dest, via); // dest above via
        }
        // 'none': leave everything where it is (via just isn't drawn)

        GROUPS.forEach(function (group) {
            setBox(root, group, boxes[group.key]);
        });
    }

    // Place `top` directly above `bottom`, keeping both sizes. Anchors on
    // `bottom` unless that would push `top` off-screen.
    function stackAbove(top, bottom) {
        top.y = bottom.y - top.h;
        if (top.y < 0) {
            top.y = 0;
            bottom.y = top.h;
        }
        if (bottom.y + bottom.h > 40) {
            bottom.y = 40 - bottom.h;
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
            colour: s.color || '#DB7700',
            from_X: s.box.x,
            to_X: s.box.x + s.box.w,
            front_Y: s.box.y,
            to_Y: s.box.y + s.box.h,
            align: s.align || 'center',
            valign: s.valign || 'middle'
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

    function styleFromPage(el, fb) {
        el = el || {};
        var split = splitFontName(el.font);
        var y = numOr(el.front_Y != null ? el.front_Y : el.from_Y, fb.y);
        var x = numOr(el.from_X, fb.x);
        var w = numOr(el.to_X, fb.x + fb.w) - x;
        var h = numOr(el.to_Y, fb.y + fb.h) - y;
        return {
            font: split.name, size: split.size,
            color: el.colour || '#DB7700',
            align: oneOf(el.align, ['left', 'center', 'right'], 'center'),
            valign: oneOf(el.valign, ['top', 'middle', 'bottom'], 'middle'),
            box: {
                x: Math.max(0, Math.min(239, x)),
                y: Math.max(0, Math.min(39, y)),
                w: w >= 1 && w <= 240 ? w : fb.w,
                h: h >= 1 && h <= 40 ? h : fb.h
            }
        };
    }

    function draftFromPage(page) {
        return {
            v: 1,
            route: ((page.number || {}).text) || '',
            destination: ((page.destination || {}).text) || '',
            via: ((page.via || {}).text) || '',
            layout: 'bottom',
            guides: false,
            dots: true,
            outerTab: 0,
            innerTab: 0,
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
        var inherited = {
            number: pageElement(state.route, state.styles.number),
            destination: pageElement(state.destination, state.styles.destination),
            via: pageElement('', state.styles.via)
        };
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
        renderPages(root);
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
            // Layout rearranges positions, but never resizes: widths/heights
            // are always preserved, only x/y move - and only if needed.
            if (t.id === 'sign-layout') {
                applySmartLayout(root, t.value);
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
            // Persist tab switches too (runs after the tabs.js handler).
            if (event.target.closest && event.target.closest('.tabs .tab button')) {
                setTimeout(function () { save(root, false); }, 0);
            }
        });
    }

    window.NSLEditor = { init: init };
})();
