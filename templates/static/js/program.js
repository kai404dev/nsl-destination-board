/* NSLProgram - program/destination/page manager for the program partial.
 *
 *  - Picks which .dest program to work on (/api/programs).
 *  - Lists destinations + pages, adds destinations and pages.
 *  - Saves the whole file back with PUT.
 *  - "Edit" loads a page into the Editor draft and jumps to the Editor tab.
 *
 * Working copy autosaves to localStorage per program, so switching tabs
 * never loses unsaved program edits. Call `NSLProgram.init(root)` after
 * injecting the partial (studio.js does).
 */
(function () {
    var SEL_KEY = 'nsl.programSel';
    var DRAFT_KEY = 'nsl.signDraft.v1';
    var CTX_KEY = 'nsl.programCtx';

    function draftKey(name) {
        return 'nsl.programDraft.' + name;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function $(root, id) {
        return root.querySelector('#' + id);
    }

    function defaultColour() {
        try {
            if (window.NSLSettings) {
                var c = window.NSLSettings.get().colour;
                if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
            }
        } catch (err) { /* ignore */ }
        return '#DB7700';
    }

    function blankElements() {
        var colour = defaultColour();
        return {
            number: { text: '', font: 'johnston100-45', colour: colour, from_X: 180, to_X: 240, front_Y: 0, to_Y: 40, align: 'center', valign: 'middle' },
            destination: { text: '', font: 'johnston100-33', colour: colour, from_X: 0, to_X: 180, front_Y: 0, to_Y: 25, align: 'center', valign: 'middle' },
            via: { text: '', font: 'johnston100-18', colour: colour, from_X: 0, to_X: 180, front_Y: 25, to_Y: 40, align: 'center', valign: 'middle' }
        };
    }

    function nextPageKey(text) {
        var max = -1;
        Object.keys(text || {}).forEach(function (k) {
            var m = /^(\d+):?$/.exec(k);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return (max + 1) + ':';
    }

    function sortedKeys(obj) {
        return Object.keys(obj || {}).sort(function (a, b) {
            return a.localeCompare(b, undefined, { numeric: true });
        });
    }

    // Destinations order by service code (numeric codes first, numerically),
    // falling back to name. Services keep key order.
    function sortedDestinations(services, service) {
        var group = services[service] || {};
        return Object.keys(group).sort(function (a, b) {
            var ca = ((group[a] || {}).service_code || '').trim();
            var cb = ((group[b] || {}).service_code || '').trim();
            var na = /^\d+$/.test(ca);
            var nb = /^\d+$/.test(cb);
            if (na && nb) {
                var diff = parseInt(ca, 10) - parseInt(cb, 10);
                if (diff) return diff;
            } else if (na) {
                return -1;
            } else if (nb) {
                return 1;
            } else if (ca !== cb) {
                return ca.localeCompare(cb);
            }
            return a.localeCompare(b, undefined, { numeric: true });
        });
    }

    function splitFont(f) {
        var s = String(f || '');
        var i = s.lastIndexOf('-');
        if (i < 0) return { name: s, size: '' };
        return { name: s.slice(0, i), size: s.slice(i + 1) };
    }

    function num(v, fallback) {
        var n = parseInt(v, 10);
        return isNaN(n) ? fallback : n;
    }

    function boxOf(el, fb) {
        el = el || {};
        var y = num(el.front_Y != null ? el.front_Y : el.from_Y, fb.y);
        var x = num(el.from_X, fb.x);
        var w = num(el.to_X, fb.x + fb.w) - x;
        var h = num(el.to_Y, fb.y + fb.h) - y;
        return {
            x: Math.max(0, Math.min(239, x)),
            y: Math.max(0, Math.min(39, y)),
            w: w >= 1 && w <= 240 ? w : fb.w,
            h: h >= 1 && h <= 40 ? h : fb.h
        };
    }

    var FALLBACK_BOXES = {
        number: { x: 180, y: 0, w: 60, h: 40 },
        destination: { x: 0, y: 0, w: 180, h: 25 },
        via: { x: 0, y: 25, w: 180, h: 15 }
    };

    // Module state for the currently open program.
    var S = { name: '', data: null, dirty: false, lastSaved: 0, version: 1, migratePending: false };

    function progVersion(data) {
        return (data && data.defaults && data.defaults.version) || 1;
    }

    // Badge the open program's file format; offer one-click migration
    // for v1 files (any save converts, so this just saves + announces).
    function updateVersionBadge(root) {
        var badge = $(root, 'prog-version');
        var btn = $(root, 'prog-migrate');
        var v = S.data ? S.version : 0;
        if (badge) badge.textContent = v === 2 ? 'v2' : v === 1 ? 'v1 — old format' : '';
        if (btn) btn.hidden = v !== 1;
    }

    var TEMPLATE_DEFAULTS = {
        colour: '#DB7700', rotation_speed: 3, px_width: 240, px_height: 40,
        scroll_speed: 30
    };

    // Older .dest files may lack `defaults` - merge the template in so the
    // Defaults form always has something to show and save.
    function ensureDefaults() {
        if (!S.data || typeof S.data !== 'object') return null;
        var d = S.data.defaults;
        if (!d || typeof d !== 'object') {
            d = {};
            S.data.defaults = d;
        }
        Object.keys(TEMPLATE_DEFAULTS).forEach(function (k) {
            if (d[k] === undefined || d[k] === null || d[k] === '') {
                d[k] = TEMPLATE_DEFAULTS[k];
            }
        });
        return d;
    }

    function setVal(root, id, value) {
        var el = $(root, id);
        if (el && value !== undefined && value !== null) el.value = value;
    }

    function fillDefaults(root) {
        var d = ensureDefaults();
        if (!d) return;
        setVal(root, 'prog-def-colour', String(d.colour || TEMPLATE_DEFAULTS.colour));
        setVal(root, 'prog-def-speed', d.rotation_speed);
        setVal(root, 'prog-def-width', d.px_width);
        setVal(root, 'prog-def-height', d.px_height);
        setVal(root, 'prog-def-scroll', d.scroll_speed);
    }

    function numOr(v, fallback) {
        var n = typeof v === 'number' ? v : parseFloat(v);
        return isNaN(n) ? fallback : n;
    }

    function onDefaultsInput(root, event) {
        var t = event.target;
        if (!t || !t.id || t.id.indexOf('prog-def-') !== 0 || !root.contains(t)) return;
        var d = ensureDefaults();
        if (!d) return;
        if (t.id === 'prog-def-colour') {
            if (/^#[0-9a-fA-F]{6}$/.test(t.value)) d.colour = t.value;
        } else if (t.id === 'prog-def-speed') {
            d.rotation_speed = Math.max(0.3, numOr(t.value, TEMPLATE_DEFAULTS.rotation_speed));
        } else if (t.id === 'prog-def-width') {
            d.px_width = Math.max(1, Math.round(numOr(t.value, TEMPLATE_DEFAULTS.px_width)));
        } else if (t.id === 'prog-def-height') {
            d.px_height = Math.max(1, Math.round(numOr(t.value, TEMPLATE_DEFAULTS.px_height)));
        } else if (t.id === 'prog-def-scroll') {
            d.scroll_speed = Math.max(1, Math.min(240, Math.round(numOr(t.value, TEMPLATE_DEFAULTS.scroll_speed))));
        }
        persist(root);
    }

    // Copy/move clipboard: { mode: 'copy'|'move', snapshot, label, from: { program, service, destination, page } }.
    var clipboard = null;

    // Collapsed-destination view state: which destination page lists are
    // expanded. Keyed by program so switching files never leaks, and
    // persisted so a refresh restores the same view.
    var EXP_KEY = 'nsl.programExpanded.v1';
    var expanded = {};
    try {
        var _savedExp = JSON.parse(storeGet(EXP_KEY));
        if (_savedExp && typeof _savedExp === 'object') expanded = _savedExp;
    } catch (err) { /* ignore */ }

    function saveExpanded() {
        try {
            if (Object.keys(expanded).length > 1000) expanded = {};
            storeSet(EXP_KEY, JSON.stringify(expanded));
        } catch (err) { /* ignore */ }
    }

    function expKey(service, destinationName) {
        return S.name + '\0' + service + '\0' + destinationName;
    }

    function setExpanded(service, destinationName, on) {
        var k = expKey(service, destinationName);
        if (on) expanded[k] = true;
        else delete expanded[k];
        saveExpanded();
    }

    function dropExpanded(service, destinationName) {
        var prefix = S.name + '\0' + service + '\0';
        Object.keys(expanded).forEach(function (k) {
            if (k === prefix + destinationName || (destinationName === undefined && k.indexOf(prefix) === 0)) {
                delete expanded[k];
            }
        });
        saveExpanded();
    }

    function storeGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (err) {
            return null;
        }
    }

    function storeSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (err) { /* ignore */ }
    }

    function storeDel(key) {
        try {
            localStorage.removeItem(key);
        } catch (err) { /* ignore */ }
    }

    function setStatus(root, text) {
        var el = $(root, 'prog-status');
        if (el) el.textContent = text;
    }

    function nextServiceCode() {
        var max = null;
        Object.keys(S.data && S.data.services || {}).forEach(function (service) {
            Object.keys(S.data.services[service] || {}).forEach(function (name) {
                var code = (S.data.services[service][name].service_code || '').trim();
                if (/^\d+$/.test(code)) {
                    var n = parseInt(code, 10);
                    if (max === null || n > max) max = n;
                }
            });
        });
        return max === null ? '' : String(max + 1);
    }

    function suggestCode(root) {
        var el = $(root, 'new-code');
        if (el && !el.value.trim()) {
            el.value = nextServiceCode();
        }
    }

    function persist(root) {
        S.dirty = true;
        if (S.name && S.data) storeSet(draftKey(S.name), JSON.stringify(S.data));
        setStatus(root, 'Unsaved changes');
    }

    function servicePages(service) {
        if (service && service.text && typeof service.text === 'object') return service.text;
        return null;
    }

    // True when any page of a destination flags scrolling text.
    function destinationScrolls(destination) {
        var pages = servicePages(destination);
        if (!pages) return false;
        return Object.keys(pages).some(function (pageKey) {
            var page = pages[pageKey] || {};
            return ['number', 'destination', 'via'].some(function (k) {
                return !!(page[k] && page[k].scroll);
            });
        });
    }

    function render(root) {
        var list = $(root, 'service-list');
        if (!list) return;
        if (!S.data) {
            list.innerHTML = '<p class="muted">No programs yet - create one above.</p>';
            updateVersionBadge(root);
            return;
        }
        var services = S.data.services || {};
        var destTotal = 0;
        sortedKeys(services).forEach(function (service) {
            destTotal += Object.keys(services[service] || {}).length;
        });
        var html = '';
        if (destTotal) {
            html += '<div class="prog-list-bar"><span class="muted">' + destTotal +
                ' destination' + (destTotal === 1 ? '' : 's') + '</span>' +
                '<button type="button" data-action="expand-all">Expand all</button>' +
                '<button type="button" data-action="collapse-all">Collapse all</button></div>';
        }
        sortedKeys(services).forEach(function (service) {
            html += '<div class="service-group-head"><h3 class="service-key">Service ' + esc(service) + '</h3>' +
                '<button type="button" class="danger-ghost" data-action="delete-service" data-service="' + esc(service) +
                '" aria-label="Delete service ' + esc(service) + '">Delete service</button></div>';
            sortedDestinations(services, service).forEach(function (name) {
                var destination = services[service][name] || {};
                var isExp = !!expanded[expKey(service, name)];
                html += '<div class="service"><div class="service-head">' +
                    '<button type="button" class="dest-toggle" data-action="toggle-destination" data-service="' + esc(service) +
                    '" data-destination="' + esc(name) + '" aria-expanded="' + (isExp ? 'true' : 'false') +
                    '" aria-label="' + (isExp ? 'Collapse ' : 'Expand ') + esc(name) + '">' +
                    (isExp ? '▾' : '▸') + '</button>' +
                    '<strong>' + esc(name) + '</strong>' +
                    '<input type="text" class="code-edit" data-service="' + esc(service) +
                    '" data-destination="' + esc(name) + '" value="' + esc(destination.service_code || '') +
                    '" maxlength="12" spellcheck="false" aria-label="Service code for ' + esc(name) + '">';
                if (destinationScrolls(destination)) {
                    html += '<span class="scroll-badge" title="Destination or via text scrolls when too wide">scroll</span>';
                }
                html += '<button type="button" class="danger-ghost" data-action="delete-destination" data-service="' + esc(service) +
                    '" data-destination="' + esc(name) + '" aria-label="Delete destination ' + esc(name) + '">Delete</button>';
                if (clipboard) {
                    html += '<button type="button" class="paste-btn" data-action="paste-page" data-service="' + esc(service) +
                        '" data-destination="' + esc(name) + '">Paste here</button>';
                }
                html += '</div><div class="page-list"' + (isExp ? '' : ' hidden') + '>';
                var pages = servicePages(destination);
                if (pages) {
                    sortedKeys(pages).forEach(function (pageKey, idx, arr) {
                        var page = pages[pageKey] || {};
                        var dest = page.destination || {};
                        var label = pageKey + (dest.text ? ' ' + dest.text : '');
                        html += '<span class="page-chip"><button type="button" data-action="edit" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) + '">' +
                            esc(label) + '</button>' +
                            '<button type="button" data-action="shift-left" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) + '"' +
                            (idx === 0 ? ' disabled' : '') +
                            ' aria-label="Move page ' + esc(pageKey) + ' earlier">◀</button>' +
                            '<button type="button" data-action="shift-right" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) + '"' +
                            (idx === arr.length - 1 ? ' disabled' : '') +
                            ' aria-label="Move page ' + esc(pageKey) + ' later">▶</button>' +
                            '<button type="button" data-action="copy-page" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) +
                            '" aria-label="Copy page ' + esc(pageKey) + '">Copy</button>' +
                            '<button type="button" data-action="move-page" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) +
                            '" aria-label="Move page ' + esc(pageKey) + '">Move</button>' +
                            '<button type="button" data-action="delete-page" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) +
                            '" aria-label="Delete page ' + esc(pageKey) + '">×</button></span>';
                    });
                } else {
                    html += '<span class="muted">Bitmap service</span>';
                }
                if (pages) {
                    html += '<button type="button" class="ghost" data-action="add-page" data-service="' + esc(service) +
                        '" data-destination="' + esc(name) + '">+ Page</button>';
                }
                html += '</div></div>';
            });
        });
        if (!html) html = '<p class="muted">No destinations yet.</p>';
        list.innerHTML = html;
        suggestCode(root);
        updateVersionBadge(root);
    }

    function fillProgramSelect(root, names) {
        var sel = $(root, 'prog-select');
        if (!sel) return;
        sel.innerHTML = '';
        names.forEach(function (name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        if (names.indexOf(S.name) >= 0) {
            sel.value = S.name;
        } else if (names.length) {
            S.name = names[0];
            sel.value = S.name;
        }
    }

    function loadProgram(root) {
        if (!S.name) return Promise.resolve();
        var raw = storeGet(draftKey(S.name));
        if (raw) {
            try {
                S.data = JSON.parse(raw);
                S.version = progVersion(S.data);
                S.dirty = true;
                render(root);
                fillDefaults(root);
                setStatus(root, 'Unsaved changes');
                return Promise.resolve();
            } catch (err) { /* fall through to fetch */ }
        }
        setStatus(root, 'Loading…');
        return fetch('/api/programs/' + encodeURIComponent(S.name))
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) {
                S.data = data;
                S.version = progVersion(data);
                S.dirty = false;
                render(root);
                fillDefaults(root);
                setStatus(root, '');
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load program');
            });
    }

    function doSave(root) {
        if (!S.name || !S.data) return;
        setStatus(root, 'Saving…');
        fetch('/api/programs/' + encodeURIComponent(S.name), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(S.data)
        })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function () {
                S.dirty = false;
                S.lastSaved = Date.now();
                // The server stores v2 on every save, whatever we sent.
                S.version = 2;
                storeDel(draftKey(S.name));
                render(root);
                if (S.migratePending) {
                    S.migratePending = false;
                    setStatus(root, 'Migrated ' + S.name + ' to v2');
                } else {
                    try {
                        setStatus(root, 'Saved ' + new Date(S.lastSaved).toLocaleTimeString());
                    } catch (err) {
                        setStatus(root, 'Saved');
                    }
                }
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Save failed');
            });
    }

    function oneOf(v, allowed, fallback) {
        return allowed.indexOf(v) >= 0 ? v : fallback;
    }

    function carryElement(el, fb, clearText) {
        el = el || {};
        function n(v, fallback) {
            var parsed = parseInt(v, 10);
            return isNaN(parsed) ? fallback : parsed;
        }
        var out = {
            text: clearText ? '' : (el.text || ''),
            font: el.font || fb.font,
            colour: el.colour || fb.colour,
            from_X: n(el.from_X, fb.from_X),
            to_X: n(el.to_X, fb.to_X),
            front_Y: n(el.front_Y != null ? el.front_Y : el.from_Y, fb.front_Y),
            to_Y: n(el.to_Y, fb.to_Y),
            align: oneOf(el.align, ['left', 'center', 'right'], 'center'),
            valign: oneOf(el.valign, ['top', 'middle', 'bottom'], 'middle')
        };
        var lh = parseInt(el.line_height, 10);
        if (!isNaN(lh) && lh >= 1 && lh <= 256) out.line_height = lh;
        var lg = parseInt(el.line_gap, 10);
        if (!isNaN(lg) && lg !== 0) {
            out.line_gap = Math.max(-64, Math.min(200, lg));
        }
        var ls = parseInt(el.letter_spacing, 10);
        if (!isNaN(ls) && ls !== 0) {
            out.letter_spacing = Math.max(-20, Math.min(40, ls));
        }
        var sw = (el.space_width === undefined || el.space_width === null || el.space_width === '')
            ? null : parseInt(el.space_width, 10);
        if (sw !== null && !isNaN(sw)) {
            out.space_width = Math.max(0, Math.min(64, sw));
        }
        if (el.scroll) out.scroll = true;
        return out;
    }

    // New pages inherit the last page's route, destination and styling so
    // only the new content (usually the via) needs typing.
    function carryPage(template) {
        var fb = blankElements();
        if (!template) return fb;
        var page = {
            number: carryElement(template.number, fb.number, false),
            destination: carryElement(template.destination, fb.destination, false),
            via: carryElement(template.via, fb.via, true)
        };
        if (Array.isArray(template.images)) {
            page.images = JSON.parse(JSON.stringify(template.images)).slice(0, 8);
        }
        return page;
    }

    function addPage(root, service, destinationName) {
        var destination = S.data && S.data.services && S.data.services[service] && S.data.services[service][destinationName];
        var pages = servicePages(destination);
        if (!pages) return;
        var keys = sortedKeys(pages);
        var key = nextPageKey(pages);
        pages[key] = carryPage(keys.length ? pages[keys[keys.length - 1]] : null);
        persist(root);
        render(root);
        // Save straight through so the server file matches: the Editor tab
        // reads pages from the server, not from this working copy.
        doSave(root);
    }

    function addProgram(root) {
        var input = $(root, 'new-program');
        var name = input ? input.value.trim() : '';
        if (!name) {
            setStatus(root, 'Type a program name first');
            return;
        }
        setStatus(root, 'Creating…');
        fetch('/api/programs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        })
            .then(function (response) {
                if (!response.ok) throw new Error(response.status === 409 ? 'exists' : 'HTTP ' + response.status);
                return response.json();
            })
            .then(function (result) {
                if (input) input.value = '';
                S.name = result.name;
                S.data = null;
                S.dirty = false;
                storeSet(SEL_KEY, S.name);
                return refresh(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, err.message === 'exists' ? 'Program already exists' : 'Could not create program');
            });
    }

    function fetchProgramFile(name) {
        return fetch('/api/programs/' + encodeURIComponent(name)).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        });
    }

    function putProgramFile(name, data) {
        return fetch('/api/programs/' + encodeURIComponent(name), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        });
    }

    function deleteProgram(root) {
        if (!S.name) return;
        if (!window.confirm('Delete program ' + S.name + '? This cannot be undone.')) return;
        setStatus(root, 'Deleting…');
        fetch('/api/programs/' + encodeURIComponent(S.name), { method: 'DELETE' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function () {
                storeDel(draftKey(S.name));
                S.name = '';
                S.data = null;
                S.dirty = false;
                clipboard = null;
                return refresh(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not delete program');
            });
    }

    // Convert the open program to v2: just save it (the server stores
    // v2 on every write) and announce the migration on success.
    function migrateProgram(root) {
        if (!S.name || !S.data) return;
        if (S.version === 2) {
            setStatus(root, 'Already v2');
            return;
        }
        if (!window.confirm('Convert program ' + S.name + ' to the v2 format?' +
                (S.dirty ? ' This also saves your unsaved changes.' : ''))) return;
        S.migratePending = true;
        doSave(root);
    }

    // Convert every v1 program file to v2: fetch each file fresh from the
    // server and write it straight back (untouched content, new format).
    // Browser drafts are left alone - they convert on their next save.
    function migrateAll(root) {
        setStatus(root, 'Checking programs…');
        fetch('/api/programs')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (names) {
                var queue = names.slice();
                var migrated = 0;
                var checked = 0;
                function next() {
                    if (!queue.length) {
                        setStatus(root, migrated
                            ? 'Migrated ' + migrated + ' program' + (migrated === 1 ? '' : 's') + ' to v2'
                            : 'All programs are already v2');
                        return;
                    }
                    var n = queue.shift();
                    checked++;
                    setStatus(root, 'Checking ' + n + '… (' + checked + '/' + names.length + ')');
                    fetchProgramFile(n).then(function (prog) {
                        if (progVersion(prog) === 2) {
                            next();
                            return null;
                        }
                        return putProgramFile(n, prog).then(function () {
                            migrated++;
                            if (n === S.name && S.data) {
                                // Converted under our working copy: stamp it
                                // so the badge is honest (edits still pending
                                // as before, they save as v2 next time).
                                if (!S.data.defaults || typeof S.data.defaults !== 'object') {
                                    S.data.defaults = {};
                                }
                                S.data.defaults.version = 2;
                                S.version = 2;
                                persist(root);
                                render(root);
                            }
                            next();
                        });
                    }).catch(function (err) {
                        console.error(err);
                        next(); // skip failures, keep going
                    });
                }
                next();
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not list programs');
            });
    }

    function grabPage(mode, root, service, destinationName, pageKey) {
        var destination = S.data.services[service][destinationName];
        var page = servicePages(destination)[pageKey];
        if (!page) return;
        var dest = (page.destination || {}).text || pageKey;
        // Clicking the same page again clears the clipboard.
        if (clipboard && clipboard.mode === mode &&
            clipboard.from.program === S.name && clipboard.from.service === service &&
            clipboard.from.destination === destinationName && clipboard.from.page === pageKey) {
            clipboard = null;
            setStatus(root, '');
            render(root);
            return;
        }
        clipboard = {
            mode: mode,
            snapshot: JSON.parse(JSON.stringify(page)),
            label: pageKey + (dest ? ' ' + dest : ''),
            from: { program: S.name, service: service, destination: destinationName, page: pageKey }
        };
        setStatus(root, (mode === 'copy' ? 'Copied ' : 'Moving ') + clipboard.label + ' — choose a destination, then Paste');
        render(root);
    }

    function pastePage(root, service, destinationName) {
        if (!clipboard || !S.data || !S.data.services) return;
        var destination = S.data.services[service] && S.data.services[service][destinationName];
        var pages = servicePages(destination);
        if (!pages) {
            setStatus(root, 'Cannot paste into a bitmap service');
            return;
        }
        var key = nextPageKey(pages);
        pages[key] = JSON.parse(JSON.stringify(clipboard.snapshot));
        if (clipboard.mode === 'move' && clipboard.from.program === S.name) {
            var src = S.data.services[clipboard.from.service] &&
                S.data.services[clipboard.from.service][clipboard.from.destination];
            var srcPages = servicePages(src);
            if (!srcPages || !srcPages[clipboard.from.page] || Object.keys(srcPages).length <= 1) {
                delete pages[key]; // roll back: cannot move the last page
                setStatus(root, 'Cannot move the last page');
                render(root);
                return;
            }
            delete srcPages[clipboard.from.page];
        }
        var mode = clipboard.mode;
        var from = clipboard.from;
        clipboard = null;
        setExpanded(service, destinationName, true);
        persist(root);
        render(root);
        if (mode === 'move' && from.program !== S.name) {
            // Source lives in another file: remove it there right away.
            setStatus(root, 'Pasted here (unsaved) — removing from ' + from.program + '…');
            fetchProgramFile(from.program)
                .then(function (srcProg) {
                    var srcDest = srcProg.services && srcProg.services[from.service] &&
                        srcProg.services[from.service][from.destination];
                    var srcKeys = servicePages(srcDest);
                    if (!srcKeys || !srcKeys[from.page] || Object.keys(srcKeys).length <= 1) {
                        throw new Error('source page unavailable');
                    }
                    delete srcKeys[from.page];
                    return putProgramFile(from.program, srcProg);
                })
                .then(function () {
                    storeDel(draftKey(from.program));
                    setStatus(root, 'Moved here — Save to write this file');
                })
                .catch(function (err) {
                    console.error(err);
                    setStatus(root, 'Pasted, but source cleanup failed — Save to write this file');
                });
        } else {
            setStatus(root, (mode === 'copy' ? 'Copied' : 'Moved') + ' here — Save to write the file');
        }
    }

    function deletePage(root, service, destinationName, pageKey) {
        var destination = S.data && S.data.services && S.data.services[service] && S.data.services[service][destinationName];
        var pages = servicePages(destination);
        if (!pages || !pages[pageKey]) return;
        if (Object.keys(pages).length <= 1) {
            setStatus(root, 'A destination needs at least one page');
            return;
        }
        if (!window.confirm('Delete page ' + pageKey + ' of ' + destinationName + '?')) return;
        delete pages[pageKey];
        persist(root);
        render(root);
    }

    function deleteDestination(root, service, destinationName) {
        var group = S.data && S.data.services && S.data.services[service];
        if (!group || !group[destinationName]) return;
        if (!window.confirm('Delete destination ' + destinationName + ' (service ' + service + ')?')) return;
        delete group[destinationName];
        if (Object.keys(group).length === 0) {
            delete S.data.services[service];
        }
        dropExpanded(service, destinationName);
        persist(root);
        render(root);
    }

    function deleteService(root, service) {
        var group = S.data && S.data.services && S.data.services[service];
        if (!group) return;
        var n = Object.keys(group).length;
        if (!window.confirm('Delete service ' + service + ' with ' + n + ' destination' + (n === 1 ? '' : 's') + '?')) return;
        delete S.data.services[service];
        dropExpanded(service);
        persist(root);
        render(root);
    }

    // Reorder rotation: keys ("0:", "1:", ...) define display order, so
    // shifting swaps the two pages' contents, keeping keys stable.
    function shiftPage(root, service, destinationName, pageKey, dir) {
        var destination = S.data && S.data.services && S.data.services[service] && S.data.services[service][destinationName];
        var pages = servicePages(destination);
        if (!pages || !pages[pageKey]) return;
        var keys = sortedKeys(pages);
        var i = keys.indexOf(pageKey);
        var j = i + dir;
        if (i < 0 || j < 0 || j >= keys.length) return;
        var tmp = pages[keys[i]];
        pages[keys[i]] = pages[keys[j]];
        pages[keys[j]] = tmp;
        persist(root);
        render(root);
    }

    function addDestination(root) {
        var serviceEl = $(root, 'new-service');
        var nameEl = $(root, 'new-destination');
        var codeEl = $(root, 'new-code');
        var name = nameEl ? nameEl.value.trim() : '';
        if (!S.data || !name) return;
        var service = (serviceEl && serviceEl.value.trim()) || sortedKeys(S.data.services || {})[0] || '1';
        if (!S.data.services) S.data.services = {};
        if (!S.data.services[service]) S.data.services[service] = {};
        if (S.data.services[service][name]) {
            setStatus(root, 'Destination already exists');
            return;
        }
        S.data.services[service][name] = {
            service_code: (codeEl && codeEl.value.trim()) || nextServiceCode(),
            service_name: name,
            text: { '0:': blankElements() }
        };
        if (nameEl) nameEl.value = '';
        if (codeEl) codeEl.value = '';
        setExpanded(service, name, true);
        persist(root);
        render(root);
        // Save straight through so the .dest file matches: the Editor tab
        // reads destinations from the server, not from this working copy.
        doSave(root);
    }

    function editPage(root, service, destinationName, pageKey) {
        var destination = S.data.services[service][destinationName];
        var page = servicePages(destination)[pageKey] || {};
        function styleOf(el, fb) {
            el = el || {};
            var split = splitFont(el.font);
            var lh = parseInt(el.line_height, 10);
            if (isNaN(lh) || lh < 1 || lh > 256) lh = null;
            var lg = parseInt(el.line_gap, 10);
            if (isNaN(lg)) lg = 0;
            var ls = parseInt(el.letter_spacing, 10);
            if (isNaN(ls)) ls = 0;
            var sw = (el.space_width === undefined || el.space_width === null || el.space_width === '')
                ? null : parseInt(el.space_width, 10);
            if (sw !== null && (isNaN(sw) || sw < 0 || sw > 64)) sw = null;
            return {
                font: split.name, size: split.size,
                color: el.colour || '#DB7700',
                align: oneOf(el.align, ['left', 'center', 'right'], 'center'),
                valign: oneOf(el.valign, ['top', 'middle', 'bottom'], 'middle'),
                lineHeight: lh,
                lineGap: Math.max(-64, Math.min(200, lg)),
                letterSpacing: Math.max(-20, Math.min(40, ls)),
                spaceWidth: sw,
                scroll: !!el.scroll,
                box: boxOf(el, fb)
            };
        }
        var draft = {
            v: 1,
            route: ((page.number || {}).text) || '',
            destination: ((page.destination || {}).text) || '',
            via: ((page.via || {}).text) || '',
            layout: 'bottom',
            guides: false,
            dots: true,
            outerTab: 0,
            innerTab: 0,
            images: Array.isArray(page.images)
                ? JSON.parse(JSON.stringify(page.images)).slice(0, 8) : [],
            styles: {
                number: styleOf(page.number, FALLBACK_BOXES.number),
                destination: styleOf(page.destination, FALLBACK_BOXES.destination),
                via: styleOf(page.via, FALLBACK_BOXES.via)
            },
            updatedAt: Date.now()
        };
        storeSet(DRAFT_KEY, JSON.stringify(draft));
        storeSet(CTX_KEY, JSON.stringify({ program: S.name, service: service, destination: destinationName, page: pageKey }));
        var btn = document.querySelector('#studio-tabs [data-view="editor"]');
        if (btn) btn.click();
    }

    function onClick(root, event) {
        var btn = event.target.closest ? event.target.closest('[data-action]') : null;
        if (!btn || !root.contains(btn)) return;
        var action = btn.dataset.action;
        if (action === 'save') doSave(root);
        else if (action === 'migrate') migrateProgram(root);
        else if (action === 'migrate-all') migrateAll(root);
        else if (action === 'add-program') addProgram(root);
        else if (action === 'add-page') addPage(root, btn.dataset.service, btn.dataset.destination);
        else if (action === 'add-destination') addDestination(root);
        else if (action === 'delete-page') deletePage(root, btn.dataset.service, btn.dataset.destination, btn.dataset.page);
        else if (action === 'delete-destination') deleteDestination(root, btn.dataset.service, btn.dataset.destination);
        else if (action === 'delete-service') deleteService(root, btn.dataset.service);
        else if (action === 'toggle-destination') {
            setExpanded(btn.dataset.service, btn.dataset.destination,
                !expanded[expKey(btn.dataset.service, btn.dataset.destination)]);
            render(root);
        }
        else if (action === 'expand-all') {
            Object.keys(S.data && S.data.services || {}).forEach(function (service) {
                Object.keys(S.data.services[service] || {}).forEach(function (name) {
                    setExpanded(service, name, true);
                });
            });
            render(root);
        }
        else if (action === 'collapse-all') {
            Object.keys(S.data && S.data.services || {}).forEach(function (service) {
                Object.keys(S.data.services[service] || {}).forEach(function (name) {
                    setExpanded(service, name, false);
                });
            });
            render(root);
        }
        else if (action === 'shift-left') shiftPage(root, btn.dataset.service, btn.dataset.destination, btn.dataset.page, -1);
        else if (action === 'shift-right') shiftPage(root, btn.dataset.service, btn.dataset.destination, btn.dataset.page, 1);
        else if (action === 'delete-program') deleteProgram(root);
        else if (action === 'copy-page') grabPage('copy', root, btn.dataset.service, btn.dataset.destination, btn.dataset.page);
        else if (action === 'move-page') grabPage('move', root, btn.dataset.service, btn.dataset.destination, btn.dataset.page);
        else if (action === 'paste-page') pastePage(root, btn.dataset.service, btn.dataset.destination);
        else if (action === 'edit') editPage(root, btn.dataset.service, btn.dataset.destination, btn.dataset.page);
        else if (action === 'export') exportProgram(root);
    }

    // Download the working copy (including any unsaved edits) as <name>.dest.
    function exportProgram(root) {
        if (!S.name || !S.data) {
            setStatus(root, 'Nothing to export');
            return;
        }
        try {
            var blob = new Blob([JSON.stringify(S.data, null, 2) + '\n'], { type: 'application/json' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = S.name + '.dest';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                try {
                    URL.revokeObjectURL(a.href);
                    a.remove();
                } catch (err) { /* ignore */ }
            }, 500);
            setStatus(root, S.dirty
                ? 'Exported ' + S.name + '.dest (includes unsaved changes)'
                : 'Exported ' + S.name + '.dest');
        } catch (err) {
            console.error(err);
            setStatus(root, 'Export failed');
        }
    }

    // Import a .dest file: create (or, with confirmation, overwrite) the
    // program, write the file content, then open it.
    function importProgram(root, file) {
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            setStatus(root, 'File too big (2 MB max)');
            return;
        }
        var reader = new FileReader();
        reader.onload = function () {
            var data;
            try {
                data = JSON.parse(reader.result);
            } catch (err) {
                setStatus(root, 'Not a valid .dest file');
                return;
            }
            if (!data || typeof data !== 'object' || typeof data.services !== 'object') {
                setStatus(root, 'File must be a program with services');
                return;
            }
            var name = String(file.name || '').replace(/\.dest$/i, '');
            if (!/^[A-Za-z0-9_-]+$/.test(name)) {
                setStatus(root, 'File name must be letters, digits, - or _');
                return;
            }
            setStatus(root, 'Importing ' + name + '…');
            fetch('/api/programs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name })
            }).then(function (response) {
                if (response.status === 409) {
                    if (!window.confirm('Program ' + name + ' exists. Overwrite it?')) {
                        throw new Error('cancelled');
                    }
                    return null; // exists: PUT overwrites it below
                }
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            }).then(function () {
                return fetch('/api/programs/' + encodeURIComponent(name), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
            }).then(function (put) {
                if (!put.ok) throw new Error('HTTP ' + put.status);
                storeDel(draftKey(name)); // drop any stale browser draft
                storeSet(SEL_KEY, name);
                var input = $(root, 'import-file');
                if (input) input.value = '';
                return refresh(root);
            }).then(function () {
                setStatus(root, 'Imported ' + name);
            }).catch(function (err) {
                console.error(err);
                setStatus(root, err.message === 'cancelled' ? 'Import cancelled' : 'Import failed');
            });
        };
        reader.onerror = function () {
            setStatus(root, 'Could not read file');
        };
        reader.readAsText(file);
    }

    function onChange(root, event) {
        var t = event.target;
        if (t && t.id === 'prog-select' && root.contains(t)) {
            S.name = t.value;
            S.data = null;
            S.dirty = false;
            storeSet(SEL_KEY, S.name);
            loadProgram(root);
            return;
        }
        // .dest file import.
        if (t && t.id === 'import-file' && root.contains(t)) {
            importProgram(root, t.files && t.files[0]);
            return;
        }
        // Service code edit: update the working copy (Save writes the file).
        if (t && t.classList && t.classList.contains('code-edit') && root.contains(t)) {
            var group = S.data && S.data.services && S.data.services[t.dataset.service];
            var dest = group && group[t.dataset.destination];
            if (dest) {
                dest.service_code = (t.value || '').trim();
                persist(root);
                render(root); // re-sort destinations by code
            }
            return;
        }
        onDefaultsInput(root, event);
    }

    var boundRoot = null;

    function refresh(root) {
        return fetch('/api/programs')
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (names) {
                var saved = storeGet(SEL_KEY);
                S.name = saved && names.indexOf(saved) >= 0 ? saved : (names[0] || '');
                fillProgramSelect(root, names);
                return loadProgram(root);
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Could not load programs');
            });
    }

    function init(root) {
        if (!root || !root.querySelector('#program-root')) return;
        refresh(root);
        if (boundRoot === root) return;
        boundRoot = root;
        root.addEventListener('click', function (event) { onClick(root, event); });
        root.addEventListener('change', function (event) { onChange(root, event); });
        // Colour picker drags only fire `input`, so listen for that too.
        root.addEventListener('input', function (event) { onDefaultsInput(root, event); });
    }

    window.NSLProgram = { init: init };
})();
