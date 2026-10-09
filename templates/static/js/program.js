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

    function blankElements() {
        return {
            number: { text: '', font: 'johnston100-45', colour: '#db9600', from_X: 210, to_X: 240, front_Y: 0, to_Y: 40 },
            destination: { text: '', font: 'johnston100-33', colour: '#db9600', from_X: 0, to_X: 220, front_Y: 0, to_Y: 26 },
            via: { text: '', font: 'johnston100-20', colour: '#db9600', from_X: 0, to_X: 220, front_Y: 26, to_Y: 40 }
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
        number: { x: 210, y: 0, w: 30, h: 40 },
        destination: { x: 0, y: 0, w: 220, h: 26 },
        via: { x: 0, y: 26, w: 220, h: 14 }
    };

    // Module state for the currently open program.
    var S = { name: '', data: null, dirty: false, lastSaved: 0 };

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

    function persist(root) {
        S.dirty = true;
        if (S.name && S.data) storeSet(draftKey(S.name), JSON.stringify(S.data));
        setStatus(root, 'Unsaved changes');
    }

    function servicePages(service) {
        if (service && service.text && typeof service.text === 'object') return service.text;
        return null;
    }

    function render(root) {
        var list = $(root, 'service-list');
        if (!list || !S.data) return;
        var services = S.data.services || {};
        var html = '';
        sortedKeys(services).forEach(function (service) {
            html += '<h3 class="service-key">Service ' + esc(service) + '</h3>';
            sortedKeys(services[service]).forEach(function (name) {
                var destination = services[service][name] || {};
                html += '<div class="service"><div class="service-head"><strong>' + esc(name) + '</strong>' +
                    '<span class="code">' + esc(destination.service_code || '') + '</span></div><div class="page-list">';
                var pages = servicePages(destination);
                if (pages) {
                    sortedKeys(pages).forEach(function (pageKey) {
                        var page = pages[pageKey] || {};
                        var dest = page.destination || {};
                        var label = pageKey + (dest.text ? ' ' + dest.text : '');
                        html += '<button type="button" data-action="edit" data-service="' + esc(service) +
                            '" data-destination="' + esc(name) + '" data-page="' + esc(pageKey) + '">' +
                            esc(label) + '</button>';
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
                S.dirty = true;
                render(root);
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
                S.dirty = false;
                render(root);
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
                storeDel(draftKey(S.name));
                try {
                    setStatus(root, 'Saved ' + new Date(S.lastSaved).toLocaleTimeString());
                } catch (err) {
                    setStatus(root, 'Saved');
                }
            })
            .catch(function (err) {
                console.error(err);
                setStatus(root, 'Save failed');
            });
    }

    function addPage(root, service, destinationName) {
        var destination = S.data && S.data.services && S.data.services[service] && S.data.services[service][destinationName];
        var pages = servicePages(destination);
        if (!pages) return;
        var key = nextPageKey(pages);
        pages[key] = blankElements();
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
            service_code: codeEl ? codeEl.value.trim() : '',
            service_name: name,
            text: { '0:': blankElements() }
        };
        if (nameEl) nameEl.value = '';
        if (codeEl) codeEl.value = '';
        persist(root);
        render(root);
        setStatus(root, 'Unsaved changes');
    }

    function editPage(root, service, destinationName, pageKey) {
        var destination = S.data.services[service][destinationName];
        var page = servicePages(destination)[pageKey] || {};
        function styleOf(el, fb) {
            el = el || {};
            var split = splitFont(el.font);
            return {
                font: split.name, size: split.size,
                color: el.colour || '#db9600',
                align: 'center', valign: 'middle',
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
        else if (action === 'add-page') addPage(root, btn.dataset.service, btn.dataset.destination);
        else if (action === 'add-destination') addDestination(root);
        else if (action === 'edit') editPage(root, btn.dataset.service, btn.dataset.destination, btn.dataset.page);
    }

    function onChange(root, event) {
        var t = event.target;
        if (t && t.id === 'prog-select' && root.contains(t)) {
            S.name = t.value;
            S.data = null;
            S.dirty = false;
            storeSet(SEL_KEY, S.name);
            loadProgram(root);
        }
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
    }

    window.NSLProgram = { init: init };
})();
