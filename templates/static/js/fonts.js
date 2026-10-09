/* NSLFonts - BDF bitmap font editor for the fonts partial.
 *
 *  - Picks a font + size (/api/fonts, /api/sizes).
 *  - Shows every glyph on a clickable character map.
 *  - Edits pixels on a grid (click or drag to paint), with shift,
 *    invert and clear tools plus a live test strip.
 *  - Saves the glyph back with PUT.
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

    function bitsFromInts(ints, w, h) {
        var stride = Math.ceil(w / 8);
        var out = [];
        for (var r = 0; r < h; r++) {
            var row = ints[r] || 0;
            var bits = [];
            for (var c = 0; c < w; c++) {
                bits.push((row >> (stride * 8 - 1 - c)) & 1);
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
        // Override the open glyph with the live edit.
        glyphs[S.encoding] = {
            dw: S.dwidth, w: S.rows[0].length, h: S.rows.length,
            xoff: S.bbx[2], yoff: S.bbx[3],
            rows: S.rows.map(function (bits) {
                var stride = Math.ceil(bits.length / 8);
                var v = 0;
                bits.forEach(function (b) { v = (v << 1) | b; });
                return v << (stride * 8 - bits.length);
            })
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
                sizes.forEach(function (size) {
                    var opt = document.createElement('option');
                    opt.value = String(size);
                    opt.textContent = String(size);
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
            }
        });

        root.addEventListener('input', function (event) {
            var t = event.target;
            if (t && t.id === 'bdf-test' && root.contains(t)) renderStrip(root);
        });

        root.addEventListener('click', function (event) {
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
