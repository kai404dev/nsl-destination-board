/* NSLPreview - true 240x40 bitmap preview for the sign editor.
 *
 * Renders the sign onto a <canvas width="240" height="40"> using the same
 * BDF fonts the board uses, so the preview matches the real display pixel
 * for pixel. Each element (number / destination / via) draws inside its own
 * bounding box (same from/to scheme as programs/*.dest) with configurable
 * horizontal + vertical alignment. The canvas is scaled up with
 * `image-rendering: pixelated`.
 *
 * Usage: NSLPreview.render(canvas, opts) where opts is:
 *   { layout, number, destination, via, guides, dots,
 *     colors: { number, destination, via },
 *     fonts: { number: { name, size }, destination: {...}, via: {...} },
 *     boxes: { number: { x, y, w, h }, destination: {...}, via: {...} },
 *     aligns: { number: 'left'|'center'|'right', ... },
 *     valigns: { number: 'top'|'middle'|'bottom', ... } }
 *
 * dots=true renders round LED pixels with gaps (like the real board);
 * guides=true outlines each element's box in its own colour.
 */
(function () {
    var W = 240;
    var H = 40;

    var GUIDE_COLORS = { number: '#4da3ff', destination: '#db9600', via: '#46c46a' };

    var cache = {}; // "name-size" -> Promise<font|null>, font = { glyphs, ascent, descent }

    function parseBDF(text) {
        var glyphs = {};
        var ascent = 0;
        var descent = 0;
        var lines = String(text).split(/\r?\n/);
        var cur = null;
        var bitmap = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('FONT_ASCENT') === 0) {
                ascent = parseInt(line.split(/\s+/)[1], 10) || 0;
            } else if (line.indexOf('FONT_DESCENT') === 0) {
                descent = parseInt(line.split(/\s+/)[1], 10) || 0;
            } else if (line.indexOf('STARTCHAR') === 0) {
                cur = { enc: -1, dw: 0, w: 0, h: 0, xoff: 0, yoff: 0, rows: [] };
                bitmap = false;
            } else if (!cur) {
                continue;
            } else if (line.indexOf('ENCODING') === 0) {
                cur.enc = parseInt(line.split(/\s+/)[1], 10);
            } else if (line.indexOf('DWIDTH') === 0) {
                cur.dw = parseInt(line.split(/\s+/)[1], 10);
            } else if (line.indexOf('BBX') === 0) {
                var parts = line.split(/\s+/);
                cur.w = parseInt(parts[1], 10);
                cur.h = parseInt(parts[2], 10);
                cur.xoff = parseInt(parts[3], 10);
                cur.yoff = parseInt(parts[4], 10);
            } else if (line === 'BITMAP') {
                bitmap = true;
            } else if (line === 'ENDCHAR') {
                if (cur.enc >= 0) glyphs[cur.enc] = cur;
                cur = null;
            } else if (bitmap) {
                var row = parseInt(line.trim(), 16);
                if (!isNaN(row)) cur.rows.push(row);
            }
        }
        return { glyphs: glyphs, ascent: ascent, descent: descent };
    }

    function loadFont(name, size) {
        var key = name + '-' + size;
        if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
        var url = '/fonts/' + encodeURIComponent(name) + '/' + encodeURIComponent(key) + '.bdf';
        var promise = fetch(url)
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.text();
            })
            .then(parseBDF)
            .catch(function (err) {
                console.error(err);
                return null;
            });
        cache[key] = promise;
        return promise;
    }

    // Ink extents of a string relative to the baseline: width in px,
    // top = highest ink pixel above baseline, bottom = lowest ink offset
    // (usually <= 0). Falls back to font ascent/descent for blank strings.
    function measureString(font, str) {
        var width = 0;
        var top = 0;
        var bottom = 0;
        var hasInk = false;
        for (var i = 0; i < str.length; i++) {
            var glyph = font.glyphs[str.charCodeAt(i)];
            if (!glyph) {
                width += 4; // missing glyph: fixed advance, like a space
                continue;
            }
            width += glyph.dw || glyph.w;
            if (glyph.rows.length) {
                hasInk = true;
                if (glyph.yoff + glyph.h > top) top = glyph.yoff + glyph.h;
                if (glyph.yoff < bottom) bottom = glyph.yoff;
            }
        }
        if (!hasInk) {
            top = font.ascent || 0;
            bottom = -(font.descent || 0);
        }
        return { width: width, top: top, bottom: bottom };
    }

    function drawLine(ctx, font, line, x, baseline, color) {
        ctx.fillStyle = color;
        var pen = x;
        for (var i = 0; i < line.length; i++) {
            var glyph = font.glyphs[line.charCodeAt(i)];
            if (!glyph) {
                pen += 4; // missing glyph: fixed advance, like a space
                continue;
            }
            var stride = Math.ceil(glyph.w / 8);
            for (var r = 0; r < glyph.rows.length; r++) {
                var row = glyph.rows[r];
                var y = baseline - glyph.yoff - glyph.h + r;
                for (var c = 0; c < glyph.w; c++) {
                    if (row & (1 << (stride * 8 - 1 - c))) {
                        ctx.fillRect(pen + glyph.xoff + c, y, 1, 1);
                    }
                }
            }
            pen += glyph.dw || glyph.w;
        }
        return pen - x;
    }

    function drawString(ctx, font, str, box, align, valign, color) {
        if (!str) return 0;
        var lines = String(str).split(/\r?\n/);
        if (lines.length <= 1) {
            var m = measureString(font, str);
            var x = box.x;
            if (align === 'center') x = Math.round(box.x + (box.w - m.width) / 2);
            else if (align === 'right') x = Math.round(box.x + box.w - m.width);
            var baseline = Math.round(box.y + box.h + m.bottom);
            if (valign === 'top') baseline = Math.round(box.y + m.top);
            else if (valign === 'middle') baseline = Math.round(box.y + box.h / 2 + (m.top + m.bottom) / 2);
            return drawLine(ctx, font, str, x, baseline, color);
        }
        // Multi-line: stack lines using font ascent/descent so Enter in the
        // Via box (or "\n" in a .dest file) renders as separate rows.
        var measures = lines.map(function (line) {
            return measureString(font, line);
        });
        var ascent = font.ascent || 0;
        var descent = font.descent || 0;
        var lineHeight = ascent + descent;
        if (!lineHeight) {
            var maxInk = 0;
            measures.forEach(function (mm) {
                var ink = mm.top - mm.bottom;
                if (ink > maxInk) maxInk = ink;
            });
            lineHeight = maxInk || 8;
            if (!ascent) {
                var maxTop = 0;
                measures.forEach(function (mm) {
                    if (mm.top > maxTop) maxTop = mm.top;
                });
                ascent = maxTop || lineHeight;
            }
        }
        var totalH = lineHeight * lines.length;
        var startY = Math.round(box.y + box.h - totalH); // bottom (default)
        if (valign === 'top') startY = Math.round(box.y);
        else if (valign === 'middle') startY = Math.round(box.y + (box.h - totalH) / 2);
        var maxWidth = 0;
        lines.forEach(function (line, i) {
            var w = measures[i].width;
            if (w > maxWidth) maxWidth = w;
            var lx = box.x;
            if (align === 'center') lx = Math.round(box.x + (box.w - w) / 2);
            else if (align === 'right') lx = Math.round(box.x + box.w - w);
            drawLine(ctx, font, line, lx, startY + ascent + i * lineHeight, color);
        });
        return maxWidth;
    }

    function drawRegion(ctx, font, text, box, align, valign, color) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.clip();
        if (font && text) {
            drawString(ctx, font, text, box, align || 'left', valign || 'bottom', color);
        } else if (text) {
            // BDF unavailable: monospace fallback, same box + alignment.
            // Supports "\n" by splitting into rows within the box.
            var fallbackLines = String(text).split(/\r?\n/);
            ctx.fillStyle = color;
            ctx.font = Math.max(6, Math.floor(box.h / fallbackLines.length) - 2) + 'px monospace';
            ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
            var fx = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w - 1 : box.x + 1;
            if (fallbackLines.length <= 1) {
                ctx.textBaseline = valign === 'top' ? 'top' : valign === 'middle' ? 'middle' : 'bottom';
                var fy = valign === 'top' ? box.y : valign === 'middle' ? box.y + box.h / 2 : box.y + box.h - 1;
                ctx.fillText(fallbackLines[0], fx, fy);
            } else {
                ctx.textBaseline = 'middle';
                var slice = box.h / fallbackLines.length;
                fallbackLines.forEach(function (line, i) {
                    ctx.fillText(line, fx, box.y + slice * (i + 0.5));
                });
            }
        }
        ctx.restore();
    }

    function defaultBoxes() {
        return {
            number: { x: 210, y: 0, w: 30, h: 40 },
            destination: { x: 0, y: 0, w: 208, h: 25 },
            via: { x: 0, y: 25, w: 208, h: 15 }
        };
    }

    function draw(ctx, fonts, opts) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);

        var boxes = opts.boxes || defaultBoxes();
        var items = [
            { key: 'destination', text: opts.destination },
            { key: 'via', text: opts.layout === 'none' ? '' : opts.via },
            { key: 'number', text: opts.number }
        ];
        items.forEach(function (item) {
            var box = boxes[item.key];
            if (!box) return;
            drawRegion(ctx, fonts[item.key], item.text, box,
                (opts.aligns && opts.aligns[item.key]) || 'left',
                (opts.valigns && opts.valigns[item.key]) || 'bottom',
                opts.colors[item.key]);
        });
    }

    function drawGuides(ctx, boxes, hideVia) {
        ctx.save();
        ctx.setLineDash([3, 2]);
        Object.keys(boxes).forEach(function (key) {
            if (key === 'via' && hideVia) return;
            var b = boxes[key];
            if (!b) return;
            ctx.strokeStyle = GUIDE_COLORS[key] || '#8a8a93';
            ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
        });
        ctx.restore();
    }

    // Round-LED overlay: repaints the 240x40 bitmap as circular dots with
    // real gaps, like the physical panels. Drawn supersampled (s = backing
    // pixels per LED) so the circles survive - drawing them at 1px each
    // just reads as dimmer squares. getPixel(x, y) -> [r, g, b].
    //
    // A disc covers less area than the square pixel it replaces, which reads
    // as dimming - so channels are boosted by 1/fill-factor (clamped) to keep
    // the same perceived colour and brightness.
    var DOT_R = 0.5;
    var DOT_GAIN = 1 / (Math.PI * DOT_R * DOT_R);

    function boost(v) {
        return Math.min(255, Math.round(v * DOT_GAIN));
    }

    function drawDots(ctx, getPixel, s) {
        s = s || 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W * s, H * s);
        for (var y = 0; y < H; y++) {
            for (var x = 0; x < W; x++) {
                var px = getPixel(x, y);
                ctx.fillStyle = (px[0] || px[1] || px[2])
                    ? 'rgb(' + boost(px[0]) + ',' + boost(px[1]) + ',' + boost(px[2]) + ')'
                    : '#141414'; // unlit LED
                ctx.beginPath();
                ctx.arc(x * s + s / 2, y * s + s / 2, s * DOT_R, 0, 6.2832);
                ctx.fill();
            }
        }
    }

    var latest = 0;

    function render(canvas, opts) {
        if (!canvas || !canvas.getContext) return Promise.resolve();
        var my = ++latest;
        var wanted = [opts.fonts.number, opts.fonts.destination, opts.fonts.via];
        var seen = {};
        var jobs = [];
        wanted.forEach(function (spec) {
            var key = spec.name + '-' + spec.size;
            if (!spec.name || seen[key]) return;
            seen[key] = true;
            jobs.push(loadFont(spec.name, spec.size).then(function (font) {
                return { key: key, font: font };
            }));
        });
        return Promise.all(jobs).then(function (results) {
            if (my !== latest) return; // superseded by a newer render
            var byKey = {};
            results.forEach(function (result) {
                byKey[result.key] = result.font;
            });
            var fonts = {
                number: byKey[wanted[0].name + '-' + wanted[0].size] || null,
                destination: byKey[wanted[1].name + '-' + wanted[1].size] || null,
                via: byKey[wanted[2].name + '-' + wanted[2].size] || null
            };
            var ctx = canvas.getContext('2d');
            if (!ctx) return; // no 2d context available
            var boxes = opts.boxes || defaultBoxes();
            // Backing store may be supersampled (e.g. 720x120) for crisp dots.
            var s = (canvas.width || W) / W;
            if (canvas.style) {
                canvas.style.imageRendering = opts.dots ? 'auto' : 'pixelated';
            }
            var off = null;
            var octx = null;
            if (opts.dots && typeof document !== 'undefined' && document.createElement) {
                off = document.createElement('canvas');
                off.width = W;
                off.height = H;
                octx = off.getContext && off.getContext('2d');
                if (!octx || !octx.getImageData) {
                    off = null;
                    octx = null;
                }
            }
            if (off) {
                draw(octx, fonts, opts);
                var data = octx.getImageData(0, 0, W, H).data;
                drawDots(ctx, function (x, y) {
                    var i = (y * W + x) * 4;
                    return [data[i], data[i + 1], data[i + 2]];
                }, s);
            } else {
                // Square pixels, scaled to fill the backing store.
                ctx.save();
                ctx.scale(s, s);
                draw(ctx, fonts, opts);
                ctx.restore();
            }
            if (opts.guides) {
                ctx.save();
                ctx.scale(s, s);
                ctx.lineWidth = 1 / s;
                drawGuides(ctx, boxes, opts.layout === 'none');
                ctx.restore();
            }
        });
    }

    window.NSLPreview = {
        render: render,
        _parseBDF: parseBDF,
        _measureString: measureString,
        _drawString: drawString,
        _draw: draw,
        _drawGuides: drawGuides,
        _drawDots: drawDots,
        _defaultBoxes: defaultBoxes
    };
})();
