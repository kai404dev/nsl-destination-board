/* NSLFonts - BDF bitmap font editor for the fonts partial.
 *
 *  - Picks a font + size (/api/fonts, /api/sizes).
 *  - Shows every glyph on a clickable character map.
 *  - Edits pixels on a grid (click or drag to paint), with shift,
 *    invert and clear tools plus a live test strip.
 *  - Saves the glyph back with PUT.
 *  - "All sizes overview" sub-tab renders every font at every size
 *    at once for the full letters + numbers string.
 *
 * Call `NSLFonts.init(root)` after injecting the partial (studio.js does).
 */
(function () {
    var CELL = 14;

    // Module state for the open glyph.
    var S = {
        font: '', size: '', glyphs: [], encoding: null,
        name: '', dwidth: 0, bbx: [0, 0, 0, 0],
        rows: [], dirty: false, fileText: ''
    };

    function $(root, id) {
        return root.querySelector('#' + id);
    }

    function setStatus(root, text) {
        var el = $(root, 'bdf-status');
        if (el) el.textContent = text;
    }

    function markDirty(root, on) {
        S.dirty = on !== false;
        if (S.dirty) setStatus(root, 'Unsaved changes');
    }

    function checkSwitch(root) {
        if (!S.dirty) return true;
        if (window.confirm('Discard unsaved pixels?')) {
            S.dirty = false;
            return true;
        }
        return false;
    }

    // Unused by the editor (the API already returns bit arrays), kept for
    // reference. Uses division/modulo: rows wider than 32px overflow
    // JS 32-bit bitwise ops (>>), so never use shifts here.
    function bitsFromInts(ints, w, h) {
        var stride = Math.ceil(w / 8);
        var out = [];
        for (var r = 0; r < h; r++) {
            var row = ints[r] || 0;
            var bits = [];
            for (var c = 0; c < w; c++) {
                bits.push(Math.floor(row / Math.pow(2, stride * 8 - 1 - c)) % 2);
            }
            out.push(bits);
        }
        return out;
    }

    function drawBits(ctx, bits, x0, y0, cell, color) {
        ctx.fillStyle = '#000';
        ctx.fillRect(x0, y0, bits[0].length * cell, bits.length * cell);
        ctx.fillStyle = color || '#fff';
        for (var r = 0; r < bits.length; r++) {
            for (var c = 0; c < bits[r].length; c++) {
                if (bits[r][c]) ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
            }
        }
    }

    function printable(enc) {
        return enc >= 32 && enc <= 126 ? String.fromCharCode(enc) : '';
    }

    function renderMap(root) {
        var map = $(root, 'bdf-map');
        if (!map) return;
        map.innerHTML = '';
        S.glyphs.forEach(function (g) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cell' + (g.encoding === S.encoding ? ' active' : '');
            btn.dataset.encoding = g.encoding;
            btn.title = g.name + ' (' + g.encoding + ')';
            var label = document.createElement('span');
            label.textContent = printable(g.encoding) || g.name;
            btn.appendChild(label);
            btn.addEventListener('click', function () {
                if (g.encoding !== S.encoding && !checkSwitch(root)) return;
                loadGlyph(root, g.encoding);
            });
            map.appendChild(btn);
        });
    }

    function renderEditor(root) {
        var canvas = $(root, 'bdf-canvas');
        var nameEl = $(root, 'bdf-glyph-name');
        var metaEl = $(root, 'bdf-meta');
        if (!canvas || !canvas.getContext || !S.rows.length) return;
        var w = S.rows[0].length;
        var h = S.rows.length;
        canvas.width = w * CELL;
        canvas.height = h * CELL;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        drawBits(ctx, S.rows, 0, 0, CELL, '#fff');
        // Grid lines.
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var c = 0; c <= w; c++) {
            ctx.moveTo(c * CELL + 0.5, 0);
            ctx.lineTo(c * CELL + 0.5, h * CELL);
        }
        for (var r = 0; r <= h; r++) {
            ctx.moveTo(0, r * CELL + 0.5);
            ctx.lineTo(w * CELL, r * CELL + 0.5);
        }
        ctx.stroke();
        if (nameEl) nameEl.textContent = (printable(S.encoding) ? printable(S.encoding) + ' ' : '') + S.name;
        if (metaEl) {
            metaEl.textContent = 'U+' + ('0000' + S.encoding.toString(16).toUpperCase()).slice(-4) +
                ' · ' + w + '×' + h + ' · advance ' + S.dwidth;
        }
        renderStrip(root);
    }

    // Test strip: draws the input text with the live (possibly edited) model.
    function renderStrip(root) {
        var strip = $(root, 'bdf-strip');
        var input = $(root, 'bdf-test');
        if (!strip || !strip.getContext || !window.NSLPreview) return;
        var ctx = strip.getContext('2d');
        if (!ctx) return;
        var text = input ? input.value : '';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, strip.width, strip.height);
        if (!text || !S.rows.length) return;
        var glyphs = {};
        S.glyphCache = S.glyphCache || {};
        Object.keys(S.glyphCache).forEach(function (enc) {
            glyphs[enc] = S.glyphCache[enc];
        });
        // Override the open glyph with the live edit (bit arrays: the
        // preview renderer reads rows as arrays, never as ints).
        glyphs[S.encoding] = {
            dw: S.dwidth, w: S.rows[0].length, h: S.rows.length,
            xoff: S.bbx[2], yoff: S.bbx[3],
            rows: S.rows.map(function (bits) { return bits.slice(); })
        };
        window.NSLPreview._drawString(ctx, { glyphs: glyphs }, text,
            { x: 0, y: 0, w: strip.width, h: strip.height }, 'center', 'middle', '#fff');
    }

    function applyTool(root, tool) {
        var h = S.rows.length;
        if (!h) return;
        var w = S.rows[0].length;
        function blank() {
            return Array.apply(null, { length: h }).map(function () {
                return Array.apply(null, { length: w }).map(function () { return 0; });
            });
        }
        if (tool === 'clear') {
            S.rows = blank();
        } else if (tool === 'invert') {
            S.rows = S.rows.map(function (row) {
                return row.map(function (b) { return b ? 0 : 1; });
            });
        } else {
            var next = blank();
            for (var r = 0; r < h; r++) {
                for (var c = 0; c < w; c++) {
                    var sr = r, sc = c;
                    if (tool === 'left') sc = c + 1;
                    else if (tool === 'right') sc = c - 1;
                    else if (tool === 'up') sr = r + 1;
                    else if (tool === 'down') sr = r - 1;
                    else return;
                    if (sr >= 0 && sc >= 0 && sr < h && sc < w) next[r][c] = S.rows[sr][sc];
                }
            }
            S.rows = next;
        }
        markDirty(root);
        renderEditor(root);
    }

    function loadFonts(root) {
        var fontSel = $(root, 'bdf-font');
        if (!fontSel) return Promise.resolve();
        return fetch('/api/fonts')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (fonts) {
                fontSel.innerHTML = '';
                fonts.forEach(function (name) {
                    var opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    fontSel.appendChild(opt);
                });
                if (!fonts.length) throw new Error('no fonts');
                S.font = fonts[0];
                fontSel.value = S.font;
                return loadSizes(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load fonts');
            });
    }

    function loadSizes(root) {
        var sizeSel = $(root, 'bdf-size');
        if (!sizeSel || !S.font) return Promise.resolve();
        return fetch('/api/sizes/' + encodeURIComponent(S.font))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (sizes) {
                sizeSel.innerHTML = '';
                // WxH bitmap families (e.g. 10x20): show the family name.
                var showName = sizes.length === 1 && /^\d+x\d+[a-z]*$/i.test(S.font || '');
                sizes.forEach(function (size) {
                    var opt = document.createElement('option');
                    opt.value = String(size);
                    opt.textContent = showName ? S.font : String(size);
                    sizeSel.appendChild(opt);
                });
                if (!sizes.length) throw new Error('no sizes');
                S.size = String(sizes[0]);
                sizeSel.value = S.size;
                return loadGlyphList(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load sizes');
            });
    }

    function glyphURL(enc) {
        var url = '/api/fonts/' + encodeURIComponent(S.font) + '/' + encodeURIComponent(S.size) + '/glyphs';
        return enc == null ? url : url + '/' + encodeURIComponent(enc);
    }

    function loadGlyphList(root) {
        S.glyphCache = {};
        return fetch(glyphURL(null))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (glyphs) {
                S.glyphs = glyphs;
                // Cache full BDF parse for the test strip via the raw file.
                return fetch('/fonts/' + encodeURIComponent(S.font) + '/' +
                    encodeURIComponent(S.font + '-' + S.size) + '.bdf')
                    .then(function (r) { return r.ok ? r.text() : ''; })
                    .then(function (text) {
                        if (text && window.NSLPreview) {
                            var parsed = window.NSLPreview._parseBDF(text);
                            S.glyphCache = parsed.glyphs || {};
                        }
                    })
                    .catch(function () { /* strip falls back to open glyph only */ });
            })
            .then(function () {
                renderMap(root);
                var first = printable(S.glyphs.length && S.glyphs[0].encoding) ? S.glyphs[0] :
                    S.glyphs.filter(function (g) { return g.encoding === 65; })[0] || S.glyphs[0];
                if (first) return loadGlyph(root, first.encoding);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load glyphs');
            });
    }

    function loadGlyph(root, encoding) {
        return fetch(glyphURL(encoding))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (g) {
                S.encoding = g.encoding;
                S.name = g.name;
                S.dwidth = g.dwidth;
                S.bbx = g.bbx;
                S.rows = g.rows;
                S.dirty = false;
                renderMap(root);
                renderEditor(root);
                setStatus(root, '');
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load glyph');
            });
    }

    function doSave(root) {
        if (S.encoding == null || !S.rows.length) return;
        setStatus(root, 'Saving…');
        fetch(glyphURL(S.encoding), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: S.rows })
        })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function () {
                S.dirty = false;
                renderMap(root);
                setStatus(root, 'Glyph saved');
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Save failed');
            });
    }

    var boundRoot = null;

    // ---- All-sizes overview (fonts tab sub-view) ----
    var OVC = { token: 0, cache: {}, loading: false };
    var OVERVIEW_DEFAULT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    function overviewText(root) {
        var input = $(root, 'bdf-overview-text');
        var text = input && input.value != null ? input.value : '';
        return text || OVERVIEW_DEFAULT;
    }

    function setOverviewStatus(root, text) {
        var el = $(root, 'bdf-overview-status');
        if (el) el.textContent = text;
    }

    function overviewScale(root) {
        var sel = $(root, 'bdf-overview-scale');
        var s = sel ? parseInt(sel.value, 10) : 2;
        if (!(s >= 1 && s <= 4)) s = 2;
        return s;
    }

    // Long strings split into A–Z / a–z / 0–9 (+ other) rows so each
    // row stays narrow; short custom strings render as typed.
    function overviewLines(text) {
        text = String(text || '');
        if (text.length <= 30) return [text];
        var up = text.replace(/[^A-Z]/g, '');
        var lo = text.replace(/[^a-z]/g, '');
        var dg = text.replace(/[^0-9]/g, '');
        var rest = text.replace(/[A-Za-z0-9]/g, '');
        var lines = [];
        if (up) lines.push(up);
        if (lo) lines.push(lo);
        if (dg) lines.push(dg);
        if (rest) lines.push(rest);
        return lines.length ? lines : [text];
    }

    function switchFtab(root, name) {
        if (!checkSwitch(root)) return;
        var buttons = root.querySelectorAll('[data-ftab]');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('active', buttons[i].dataset.ftab === name);
        }
        var editorView = $(root, 'bdf-editor-view');
        var overviewView = $(root, 'bdf-overview-view');
        if (editorView) editorView.hidden = name !== 'editor';
        if (overviewView) overviewView.hidden = name !== 'overview';
        // Always refetch: BDFs change under us (glyph editor saves), and a
        // stale cache shows old pixels that look like unfixed bugs.
        if (name === 'overview') loadOverview(root, true);
    }

    // Each LED pixel is drawn scale×scale screen pixels (pixelated), so
    // small sizes are enlarged instead of tiny, and large sizes render
    // 1:1-or-bigger inside a horizontal scroll (never shrunk, so no
    // columns vanish from downscaling).
    function drawOverviewRow(fontObj, lines, scale) {
        var wrap = document.createElement('div');
        wrap.className = 'bdf-overview-scroll';
        var canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        if (!window.NSLPreview || !fontObj) return wrap;
        var PAD = 2, GAP = 4;
        var widths = [], heights = [], i, m;
        for (i = 0; i < lines.length; i++) {
            m = window.NSLPreview._measureString(fontObj, lines[i]);
            widths.push(m.width);
            heights.push(m.top - m.bottom);
        }
        var inkW = Math.max.apply(null, widths.concat([1])) + PAD * 2;
        var inkH = PAD * 2;
        for (i = 0; i < heights.length; i++) inkH += heights[i] + (i ? GAP : 0);
        canvas.width = Math.max(1, inkW * scale);
        canvas.height = Math.max(1, inkH * scale);
        canvas.style.width = canvas.width + 'px';
        canvas.style.height = canvas.height + 'px';
        var ctx = canvas.getContext('2d');
        if (!ctx) return wrap;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.scale(scale, scale);
        var y = PAD;
        for (i = 0; i < lines.length; i++) {
            if (lines[i]) {
                window.NSLPreview._drawString(ctx, fontObj, lines[i],
                    { x: PAD, y: y, w: widths[i], h: heights[i] },
                    'left', 'top', '#fff');
            }
            y += heights[i] + GAP;
        }
        ctx.restore();
        return wrap;
    }

    function renderOverviewFromCache(root) {
        var grid = $(root, 'bdf-overview-grid');
        if (!grid) return;
        grid.innerHTML = '';
        var text = overviewText(root);
        var lines = overviewLines(text);
        var scale = overviewScale(root);
        var keys = Object.keys(OVC.cache).sort(function (a, b) {
            var pa = a.split('|'), pb = b.split('|');
            if (pa[0] < pb[0]) return -1;
            if (pa[0] > pb[0]) return 1;
            return parseInt(pa[1], 10) - parseInt(pb[1], 10);
        });
        if (!keys.length) {
            setOverviewStatus(root, 'No fonts loaded yet.');
            return;
        }
        var currentFont = null, fontSection = null;
        keys.forEach(function (key) {
            var parts = key.split('|');
            var fontName = parts[0], size = parts[1];
            var fontObj = OVC.cache[key];
            if (fontName !== currentFont) {
                currentFont = fontName;
                fontSection = document.createElement('div');
                fontSection.className = 'bdf-overview-font';
                var heading = document.createElement('h3');
                heading.textContent = fontName;
                fontSection.appendChild(heading);
                grid.appendChild(fontSection);
            }
            var row = document.createElement('div');
            row.className = 'bdf-overview-row';
            var head = document.createElement('div');
            head.className = 'row-head';
            var label = document.createElement('strong');
            label.textContent = fontName + '-' + size + ' · ' + scale + '×';
            head.appendChild(label);
            if (fontObj) {
                var meta = document.createElement('span');
                meta.textContent = 'ascent ' + fontObj.ascent + ' · descent ' + fontObj.descent;
                head.appendChild(meta);
            } else {
                var missing = document.createElement('span');
                missing.textContent = 'could not load';
                head.appendChild(missing);
            }
            row.appendChild(head);
            if (fontObj) row.appendChild(drawOverviewRow(fontObj, lines, scale));
            fontSection.appendChild(row);
        });
        setOverviewStatus(root, keys.length + ' sizes · ' + lines.length + ' rows · ' + scale + '×');
    }

    function loadOverview(root, force) {
        if (!window.NSLPreview) {
            setOverviewStatus(root, 'Preview library not loaded');
            return Promise.resolve();
        }
        if (OVC.loading) return Promise.resolve();
        if (!force && Object.keys(OVC.cache).length) {
            renderOverviewFromCache(root);
            return Promise.resolve();
        }
        OVC.loading = true;
        var my = ++OVC.token;
        setOverviewStatus(root, 'Loading fonts…');
        if (force) OVC.cache = {};
        return fetch('/api/fonts')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (fonts) {
                var chain = Promise.resolve();
                (fonts || []).forEach(function (fontName) {
                    chain = chain.then(function () {
                        if (my !== OVC.token) return;
                        return fetch('/api/sizes/' + encodeURIComponent(fontName))
                            .then(function (r) {
                                if (!r.ok) throw new Error('HTTP ' + r.status);
                                return r.json();
                            })
                            .then(function (sizes) {
                                var inner = Promise.resolve();
                                (sizes || []).forEach(function (size) {
                                    inner = inner.then(function () {
                                        if (my !== OVC.token) return;
                                        var key = fontName + '|' + size;
                                        if (!force && OVC.cache[key]) return;
                                        setOverviewStatus(root, 'Loading ' + fontName + '-' + size + '…');
                                        return fetch('/fonts/' + encodeURIComponent(fontName) + '/' +
                                            encodeURIComponent(fontName + '-' + size) + '.bdf')
                                            .then(function (resp) {
                                                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                                                return resp.text();
                                            })
                                            .then(function (bdfText) {
                                                if (my !== OVC.token) return;
                                                OVC.cache[key] = window.NSLPreview._parseBDF(bdfText);
                                                renderOverviewFromCache(root);
                                            })
                                            .catch(function () {
                                                if (my !== OVC.token) return;
                                                OVC.cache[key] = null;
                                            });
                                    });
                                });
                                return inner;
                            })
                            .catch(function () { /* skip fonts with no sizes */ });
                    });
                });
                return chain;
            })
            .then(function () {
                if (my !== OVC.token) return;
                renderOverviewFromCache(root);
            })
            .catch(function (err) {
                console.error(err);
                if (my === OVC.token) setOverviewStatus(root, 'Could not load fonts');
            })
            .then(function () {
                if (my === OVC.token) OVC.loading = false;
            });
    }

    function refresh(root) {
        S.encoding = null;
        S.rows = [];
        S.dirty = false;
        return loadFonts(root);
    }

    function init(root) {
        if (!root || !root.querySelector('#bdf-root')) return;
        refresh(root);
        if (boundRoot === root) return;
        boundRoot = root;

        root.addEventListener('change', function (event) {
            var t = event.target;
            if (!t || !root.contains(t)) return;
            if (t.id === 'bdf-font') {
                if (!checkSwitch(root)) {
                    t.value = S.font;
                    return;
                }
                S.font = t.value;
                loadSizes(root);
            } else if (t.id === 'bdf-size') {
                if (!checkSwitch(root)) {
                    t.value = S.size;
                    return;
                }
                S.size = t.value;
                loadGlyphList(root);
            } else if (t.id === 'bdf-overview-scale') {
                var ov = $(root, 'bdf-overview-view');
                if (ov && !ov.hidden) renderOverviewFromCache(root);
            }
        });

        root.addEventListener('input', function (event) {
            var t = event.target;
            if (t && t.id === 'bdf-test' && root.contains(t)) renderStrip(root);
            if (t && t.id === 'bdf-overview-text' && root.contains(t)) {
                var ov = $(root, 'bdf-overview-view');
                if (ov && !ov.hidden) renderOverviewFromCache(root);
            }
        });

        root.addEventListener('click', function (event) {
            var ftab = event.target.closest ? event.target.closest('[data-ftab]') : null;
            if (ftab && root.contains(ftab)) {
                switchFtab(root, ftab.dataset.ftab);
                return;
            }
            var reload = event.target.closest ? event.target.closest('#bdf-overview-reload') : null;
            if (reload && root.contains(reload)) {
                loadOverview(root, true);
                return;
            }
            var save = event.target.closest ? event.target.closest('#bdf-save') : null;
            if (save && root.contains(save)) {
                doSave(root);
                return;
            }
            var tool = event.target.closest ? event.target.closest('[data-tool]') : null;
            if (tool && root.contains(tool)) {
                applyTool(root, tool.dataset.tool);
            }
        });

        // Paint on click + drag.
        var painting = null;
        function cellFromEvent(event) {
            var canvas = $(root, 'bdf-canvas');
            if (!canvas) return null;
            var rect = canvas.getBoundingClientRect();
            var scaleX = canvas.width / (rect.width || 1);
            var scaleY = canvas.height / (rect.height || 1);
            var cx = event.clientX != null ? event.clientX : (event.touches && event.touches[0].clientX);
            var cy = event.clientY != null ? event.clientY : (event.touches && event.touches[0].clientY);
            if (cx == null || cy == null) return null;
            var c = Math.floor((cx - rect.left) * scaleX / CELL);
            var r = Math.floor((cy - rect.top) * scaleY / CELL);
            if (r < 0 || c < 0 || !S.rows.length || r >= S.rows.length || c >= S.rows[0].length) return null;
            return { r: r, c: c };
        }
        function paintTo(event, value) {
            var cell = cellFromEvent(event);
            if (!cell) return;
            if (value == null) value = S.rows[cell.r][cell.c] ? 0 : 1;
            if (S.rows[cell.r][cell.c] !== value) {
                S.rows[cell.r][cell.c] = value;
                markDirty(root);
                renderEditor(root);
            }
            return value;
        }
        root.addEventListener('mousedown', function (event) {
            var canvas = event.target.closest ? event.target.closest('#bdf-canvas') : null;
            if (!canvas || !root.contains(canvas)) return;
            event.preventDefault();
            painting = paintTo(event, null);
        });
        root.addEventListener('mousemove', function (event) {
            if (painting == null) return;
            paintTo(event, painting);
        });
        root.addEventListener('mouseup', function () {
            painting = null;
        });
    }

    window.NSLFonts = { init: init };
})();
