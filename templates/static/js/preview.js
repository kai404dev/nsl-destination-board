/* NSLPreview - true bitmap preview for the sign editor.
 *
 * Renders the sign onto a <canvas> using the same BDF fonts the board
 * uses, so the preview matches the real display pixel for pixel. The
 * logical size comes from opts (width/height, default 240x40 to match
 * the stock panels); the caller sizes the canvas backing store
 * (e.g. 3x for crisp dots) and CSS scales it up. Each element
 * (number / destination / via) draws inside its own bounding box
 * (same from/to scheme as programs/*.dest) with configurable
 * horizontal + vertical alignment.
 *
 * Usage: NSLPreview.render(canvas, opts) where opts is:
 *   { layout, number, destination, via, guides, dots,
 *     width, height,
 *     colors: { number, destination, via },
 *     fonts: { number: { name, size }, destination: {...}, via: {...} },
 *     boxes: { number: { x, y, w, h }, destination: {...}, via: {...} },
 *     aligns: { number: 'left'|'center'|'right', ... },
 *     valigns: { number: 'top'|'middle'|'bottom', ... },
 *     spacings: { number: { lineHeight: px|null, lineGap: px, letterSpacing: px, spaceWidth: px|null }, ... },
 *     images: [{ src: 'bitmaps/shared/logo.png', x, y, w?, h? }, ...] }
 *     scroll: { destination: bool, via: bool } (marquee when the text
 *       overflows its box; ignored otherwise),
 *     scrollOffsets: { key: px shift } (one animation frame; 0 = start)
 * }
 *
 * dots=true renders round LED pixels with gaps (like the real board);
 * guides=true outlines each element's box in its own colour.
 */
(function () {
    var DEFAULT_W = 240;
    var DEFAULT_H = 40;

    // Logical display size for one render (Settings tab), clamped.
    function dimsOf(opts) {
        opts = opts || {};
        var w = parseInt(opts.width, 10);
        var h = parseInt(opts.height, 10);
        if (isNaN(w)) w = DEFAULT_W;
        if (isNaN(h)) h = DEFAULT_H;
        return {
            w: Math.max(1, Math.min(1024, w)),
            h: Math.max(1, Math.min(256, h))
        };
    }

    var GUIDE_COLORS = { number: '#4da3ff', destination: '#DB7700', via: '#46c46a' };

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
                // NOTE: rows are stored as bit arrays (not ints) because
                // BDF rows wider than 32px overflow JS 32-bit bitwise ops.
                var hex = line.trim();
                var bits = [];
                for (var b = 0; b < hex.length; b++) {
                    var nibble = parseInt(hex.charAt(b), 16);
                    if (isNaN(nibble)) { bits = null; break; }
                    bits.push((nibble >> 3) & 1, (nibble >> 2) & 1,
                        (nibble >> 1) & 1, nibble & 1);
                }
                if (bits) cur.rows.push(bits.slice(0, cur.w));
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
    // tracking adds extra px after every character (may be negative).
    function measureString(font, str, tracking, spaceW) {
        var width = 0;
        var top = 0;
        var bottom = 0;
        var hasInk = false;
        tracking = tracking || 0;
        for (var i = 0; i < str.length; i++) {
            if (str.charCodeAt(i) === 32 && spaceW !== null && spaceW !== undefined) {
                width += spaceW + tracking; // explicit space width wins over the font
                continue;
            }
            var glyph = font.glyphs[str.charCodeAt(i)];
            if (!glyph) {
                width += 4 + tracking; // missing glyph: fixed advance, like a space
                continue;
            }
            width += (glyph.dw || glyph.w) + tracking;
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

    function drawLine(ctx, font, line, x, baseline, color, tracking, spaceW) {
        ctx.fillStyle = color;
        tracking = tracking || 0;
        var pen = x;
        for (var i = 0; i < line.length; i++) {
            if (line.charCodeAt(i) === 32 && spaceW !== null && spaceW !== undefined) {
                pen += spaceW + tracking; // explicit space width, no ink
                continue;
            }
            var glyph = font.glyphs[line.charCodeAt(i)];
            if (!glyph) {
                pen += 4 + tracking; // missing glyph: fixed advance, like a space
                continue;
            }
            for (var r = 0; r < glyph.rows.length; r++) {
                var bits = glyph.rows[r];
                var y = baseline - glyph.yoff - glyph.h + r;
                for (var c = 0; c < glyph.w; c++) {
                    if (bits[c]) {
                        ctx.fillRect(pen + glyph.xoff + c, y, 1, 1);
                    }
                }
            }
            pen += (glyph.dw || glyph.w) + tracking;
        }
        return pen - x;
    }

    function drawString(ctx, font, str, box, align, valign, color, spacing, scroll, scrollX) {
        if (!str) return 0;
        var sp = spacing || {};
        var tracking = parseInt(sp.letterSpacing, 10);
        if (isNaN(tracking)) tracking = 0;
        tracking = Math.max(-20, Math.min(40, tracking));
        var spaceW = (sp.spaceWidth === undefined || sp.spaceWidth === null || sp.spaceWidth === '')
            ? null : parseInt(sp.spaceWidth, 10);
        if (spaceW !== null && (isNaN(spaceW) || spaceW < 0 || spaceW > 64)) spaceW = null;
        var lines = String(str).split(/\r?\n/);
        if (scroll && lines.length > 1) {
            // Scrolling is one horizontal line: join rows so nothing is lost.
            str = lines.join(' ');
            lines = [str];
        }
        if (lines.length <= 1) {
            var m = measureString(font, str, tracking, spaceW);
            var shift = Math.round(scrollX) || 0;
            var x;
            if (scroll && m.width > box.w) {
                // Scrolling overflow: pin left and slide (offset 0 shows
                // the head). Centering the rest position would start the
                // text halfway scrolled and double-jump.
                x = box.x - shift;
            } else {
                x = box.x;
                if (align === 'center') x = Math.round(box.x + (box.w - m.width) / 2);
                else if (align === 'right') x = Math.round(box.x + box.w - m.width);
            }
            var baseline = Math.round(box.y + box.h + m.bottom);
            if (valign === 'top') baseline = Math.round(box.y + m.top);
            else if (valign === 'middle') baseline = Math.round(box.y + box.h / 2 + (m.top + m.bottom) / 2);
            return drawLine(ctx, font, str, x, baseline, color, tracking, spaceW);
        }
        // Multi-line: stack lines using font ascent/descent so Enter in the
        // Via box (or "\n" in a .dest file) renders as separate rows.
        // spacing = { lineHeight: px|null (null = auto), lineGap: px }.
        var measures = lines.map(function (line) {
            return measureString(font, line, tracking, spaceW);
        });
        var ascent = font.ascent || 0;
        var descent = font.descent || 0;
        var natural = ascent + descent;
        if (!natural) {
            var maxInk = 0;
            measures.forEach(function (mm) {
                var ink = mm.top - mm.bottom;
                if (ink > maxInk) maxInk = ink;
            });
            natural = maxInk || 8;
            if (!ascent) {
                var maxTop = 0;
                measures.forEach(function (mm) {
                    if (mm.top > maxTop) maxTop = mm.top;
                });
                ascent = maxTop || natural;
            }
        }
        var explicit = (sp.lineHeight === undefined || sp.lineHeight === null || sp.lineHeight === '')
            ? null : parseInt(sp.lineHeight, 10);
        var base = (explicit !== null && !isNaN(explicit) && explicit >= 1 && explicit <= 256)
            ? explicit : natural;
        var gap = parseInt(sp.lineGap, 10);
        if (isNaN(gap)) gap = 0;
        gap = Math.max(-64, Math.min(200, gap));
        var step = Math.max(1, base + gap);
        var totalH = step * (lines.length - 1) + base;
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
            drawLine(ctx, font, line, lx, startY + ascent + i * step, color, tracking, spaceW);
        });
        return maxWidth;
    }

    function drawRegion(ctx, font, text, box, align, valign, color, spacing, scroll, scrollX) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.clip();
        if (font && text) {
            drawString(ctx, font, text, box, align || 'left', valign || 'bottom', color, spacing, scroll, scrollX);
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

    function draw(ctx, fonts, opts, images) {
        var D = dimsOf(opts);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, D.w, D.h);

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
                (opts.aligns && opts.aligns[item.key]) || 'center',
                (opts.valigns && opts.valigns[item.key]) || 'middle',
                opts.colors[item.key],
                (opts.spacings && opts.spacings[item.key]) || null,
                !!(opts.scroll && opts.scroll[item.key]),
                (opts.scrollOffsets && opts.scrollOffsets[item.key]) || 0);
        });
        // Positioned bitmap overlays, drawn in order over the text.
        // imageSmoothing is off so scaled logos stay crisp like the board's
        // NEAREST scaling.
        if (images) {
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            (opts.images || []).forEach(function (spec) {
                if (!spec || !spec.src) return;
                var img = images[spec.src];
                if (!img || !img.width) return;
                var x = Math.round(spec.x || 0);
                var y = Math.round(spec.y || 0);
                var w = spec.w > 0 ? Math.round(spec.w) : img.naturalWidth || img.width;
                var h = spec.h > 0 ? Math.round(spec.h) : img.naturalHeight || img.height;
                try {
                    ctx.drawImage(img, x, y, w, h);
                } catch (err) { /* bad image: skip */ }
            });
            ctx.restore();
        }
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

    // Round-LED overlay: repaints the logical bitmap as circular dots with
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

    function drawDots(ctx, getPixel, s, W, H) {
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

    var imageCache = {}; // src -> HTMLImageElement (resolved, maybe broken)

    function loadImage(src) {
        if (Object.prototype.hasOwnProperty.call(imageCache, src)) {
            return Promise.resolve(imageCache[src]);
        }
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                imageCache[src] = img;
                resolve(img);
            };
            img.onerror = function () {
                imageCache[src] = null;
                resolve(null);
            };
            img.src = '/' + String(src).replace(/^\/+/, '');
        });
    }

    function loadImages(specs) {
        var seen = {};
        var jobs = [];
        (specs || []).forEach(function (spec) {
            if (!spec || !spec.src || seen[spec.src]) return;
            seen[spec.src] = true;
            jobs.push(loadImage(spec.src).then(function (img) {
                return { src: spec.src, img: img };
            }));
        });
        if (!jobs.length) return Promise.resolve({});
        return Promise.all(jobs).then(function (results) {
            var bySrc = {};
            results.forEach(function (r) {
                bySrc[r.src] = r.img;
            });
            return bySrc;
        });
    }

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
        var imageJob = (typeof Image !== 'undefined')
            ? loadImages(opts.images)
            : Promise.resolve({});
        return Promise.all([Promise.all(jobs), imageJob]).then(function (both) {
            var results = both[0];
            var images = both[1];
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
            var D = dimsOf(opts);
            // Backing store may be supersampled (e.g. 3x) for crisp dots.
            // The caller sizes canvas.width/height = dims * supersample.
            var s = (canvas.width || D.w) / D.w || 1;
            if (canvas.style) {
                canvas.style.imageRendering = opts.dots ? 'auto' : 'pixelated';
                canvas.style.aspectRatio = D.w + ' / ' + D.h;
            }
            var off = null;
            var octx = null;
            if (opts.dots && typeof document !== 'undefined' && document.createElement) {
                off = document.createElement('canvas');
                off.width = D.w;
                off.height = D.h;
                octx = off.getContext && off.getContext('2d');
                if (!octx || !octx.getImageData) {
                    off = null;
                    octx = null;
                }
            }
            if (off) {
                draw(octx, fonts, opts, images);
                var data = octx.getImageData(0, 0, D.w, D.h).data;
                drawDots(ctx, function (x, y) {
                    var i = (y * D.w + x) * 4;
                    return [data[i], data[i + 1], data[i + 2]];
                }, s, D.w, D.h);
            } else {
                // Square pixels, scaled to fill the backing store.
                ctx.save();
                ctx.scale(s, s);
                draw(ctx, fonts, opts, images);
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

    // One-shot text width for scroll planning (single line; multi-line
    // is joined like the renderer does). Resolves 0 when the font is
    // unavailable. Fonts stay cached, so repeat calls are cheap.
    function measure(text, fontName, size, tracking, spaceW) {
        var line = String(text == null ? '' : text).split(/\r?\n/).join(' ');
        if (!line || !fontName) return Promise.resolve(0);
        return loadFont(fontName, size).then(function (font) {
            if (!font) return 0;
            var tr = parseInt(tracking, 10);
            if (isNaN(tr)) tr = 0;
            var sw = (spaceW === undefined || spaceW === null || spaceW === '')
                ? null : parseInt(spaceW, 10);
            if (sw !== null && (isNaN(sw) || sw < 0 || sw > 64)) sw = null;
            return measureString(font, line, tr, sw).width;
        });
    }

    window.NSLPreview = {
        render: render,
        measure: measure,
        _parseBDF: parseBDF,
        _measureString: measureString,
        _drawString: drawString,
        _draw: draw,
        _drawGuides: drawGuides,
        _drawDots: drawDots,
        _defaultBoxes: defaultBoxes
    };
})();
