/* NSLSettings - studio-wide settings stored in localStorage.
 *
 *   { display: { w, h }, colour, layout,
 *     fonts: { number: {font,size}, destination: {...}, via: {...} } }
 *
 * Display size drives the Editor canvas (and board preview pushes).
 * Colour/layout/fonts seed fresh drafts, Clear draft and new pages.
 * Exposes window.NSLSettings = { get(), dims(), init(root) }.
 */
(function () {
    var KEY = 'nsl.settings.v1';

    var FACTORY = {
        display: { w: 240, h: 40 },
        colour: '#DB7700',
        layout: 'bottom',
        fonts: {
            number: { font: '', size: '' },
            destination: { font: '', size: '' },
            via: { font: '', size: '' }
        }
    };

    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }

    function num(v, fallback, lo, hi) {
        var n = parseInt(v, 10);
        if (isNaN(n)) return fallback;
        return Math.max(lo, Math.min(hi, n));
    }

    function sanitise(raw) {
        var out = clone(FACTORY);
        if (!raw || typeof raw !== 'object') return out;
        if (raw.display && typeof raw.display === 'object') {
            out.display.w = num(raw.display.w, 240, 1, 1024);
            out.display.h = num(raw.display.h, 40, 1, 256);
        }
        if (typeof raw.colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.colour)) {
            out.colour = raw.colour;
        }
        if (['top', 'bottom', 'left', 'right', 'none'].indexOf(raw.layout) >= 0) {
            out.layout = raw.layout;
        }
        if (raw.fonts && typeof raw.fonts === 'object') {
            ['number', 'destination', 'via'].forEach(function (k) {
                var f = raw.fonts[k];
                if (f && typeof f === 'object') {
                    if (typeof f.font === 'string') out.fonts[k].font = f.font;
                    if (f.size !== undefined && f.size !== null && String(f.size) !== '') {
                        out.fonts[k].size = String(f.size);
                    }
                }
            });
        }
        return out;
    }

    function get() {
        try {
            var raw = localStorage.getItem(KEY);
            if (!raw) return clone(FACTORY);
            return sanitise(JSON.parse(raw));
        } catch (err) {
            return clone(FACTORY);
        }
    }

    function set(s) {
        var clean = sanitise(s);
        try {
            localStorage.setItem(KEY, JSON.stringify(clean));
        } catch (err) { /* ignore */ }
        return clean;
    }

    function dims() {
        var s = get();
        return { w: s.display.w, h: s.display.h };
    }

    function $(root, id) {
        return root.querySelector('#' + id);
    }

    function setStatus(root, text) {
        var el = $(root, 'set-status');
        if (el) el.textContent = text;
    }

    function fmtTime(ts) {
        try {
            return new Date(ts).toLocaleTimeString();
        } catch (err) {
            return '';
        }
    }

    function fillSelect(el, items, current) {
        if (!el) return;
        el.innerHTML = '';
        if (!items.length) {
            var opt = document.createElement('option');
            opt.textContent = 'None available';
            el.appendChild(opt);
            return;
        }
        items.forEach(function (item) {
            var option = document.createElement('option');
            option.value = String(item);
            option.textContent = String(item);
            el.appendChild(option);
        });
        var idx = items.map(String).indexOf(String(current || ''));
        el.selectedIndex = idx >= 0 ? idx : 0;
    }

    function nearestIndex(sizes, target) {
        var best = 0;
        sizes.forEach(function (size, i) {
            if (Math.abs(size - target) < Math.abs(sizes[best] - target)) best = i;
        });
        return best;
    }

    var ROWS = [
        { key: 'number', fontId: 'set-number-font', sizeId: 'set-number-size', preferred: 45 },
        { key: 'destination', fontId: 'set-dest-font', sizeId: 'set-dest-size', preferred: 33 },
        { key: 'via', fontId: 'set-via-font', sizeId: 'set-via-size', preferred: 18 }
    ];

    function loadSizes(root, row) {
        var fontEl = $(root, row.fontId);
        var sizeEl = $(root, row.sizeId);
        if (!fontEl || !sizeEl || !fontEl.value) return Promise.resolve();
        var s = get();
        var current = (s.fonts[row.key] || {}).size;
        return fetch('/api/sizes/' + encodeURIComponent(fontEl.value))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (sizes) {
                fillSelect(sizeEl, sizes, current);
                if (!current && sizes.length) {
                    sizeEl.selectedIndex = Math.min(nearestIndex(sizes, row.preferred), sizes.length - 1);
                }
            })
            .catch(function (err) {
                console.error(err);
            });
    }

    function loadFonts(root) {
        var s = get();
        return fetch('/api/fonts')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (fonts) {
                ROWS.forEach(function (row) {
                    fillSelect($(root, row.fontId), fonts, (s.fonts[row.key] || {}).font);
                });
                return Promise.all(ROWS.map(function (row) {
                    return loadSizes(root, row);
                }));
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load fonts');
            });
    }

    function applyState(root, s) {
        var wEl = $(root, 'set-width');
        if (wEl) wEl.value = s.display.w;
        var hEl = $(root, 'set-height');
        if (hEl) hEl.value = s.display.h;
        var cEl = $(root, 'set-colour');
        if (cEl) cEl.value = s.colour;
        var lEl = $(root, 'set-layout');
        if (lEl) lEl.value = s.layout;
    }

    function collectState(root) {
        var s = get();
        s.display.w = num($(root, 'set-width') && $(root, 'set-width').value, s.display.w, 1, 1024);
        s.display.h = num($(root, 'set-height') && $(root, 'set-height').value, s.display.h, 1, 256);
        var cEl = $(root, 'set-colour');
        if (cEl && /^#[0-9a-fA-F]{6}$/.test(cEl.value)) s.colour = cEl.value;
        var lEl = $(root, 'set-layout');
        if (lEl && lEl.value) s.layout = lEl.value;
        ROWS.forEach(function (row) {
            var fontEl = $(root, row.fontId);
            var sizeEl = $(root, row.sizeId);
            s.fonts[row.key] = {
                font: fontEl ? fontEl.value : '',
                size: sizeEl ? sizeEl.value : ''
            };
        });
        return s;
    }

    function persist(root) {
        set(collectState(root));
        setStatus(root, 'Saved ' + fmtTime(Date.now()));
    }

    function reset(root) {
        try {
            localStorage.removeItem(KEY);
        } catch (err) { /* ignore */ }
        var s = get();
        applyState(root, s);
        loadFonts(root);
        setStatus(root, 'Reset to factory defaults');
    }

    var boundRoot = null;

    function refresh(root) {
        var s = get();
        applyState(root, s);
        loadFonts(root);
        setStatus(root, '');
    }

    function init(root) {
        if (!root || !root.querySelector('#settings-root')) return;
        refresh(root);
        if (boundRoot === root) return;
        boundRoot = root;
        var timer = null;
        root.addEventListener('input', function (event) {
            var t = event.target;
            if (!t || !t.id || !root.contains(t)) return;
            if (t.id.indexOf('set-') !== 0 || t.id === 'set-reset') return;
            var row = null;
            ROWS.forEach(function (r) {
                if (r.fontId === t.id) row = r;
            });
            if (row) {
                // Font changed: reload its sizes, then save.
                loadSizes(root, row).then(function () { persist(root); });
                return;
            }
            clearTimeout(timer);
            timer = setTimeout(function () { persist(root); }, 350);
        });
        root.addEventListener('change', function (event) {
            var t = event.target;
            if (t && t.id && t.id.indexOf('set-') === 0 && root.contains(t)) persist(root);
        });
        root.addEventListener('click', function (event) {
            var btn = event.target.closest ? event.target.closest('#set-reset') : null;
            if (btn && root.contains(btn)) reset(root);
        });
    }

    window.NSLSettings = { get: get, set: set, dims: dims, init: init };
})();
