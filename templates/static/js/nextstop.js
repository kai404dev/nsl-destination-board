/* Next-stop page: route display (reference TFT), browser TTS with
   premade-audio override + local-AI hook, manual test buttons, GPS auto-advance.
   Each .dest destination links to a .service file via "nextstop_service". */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var progEl = $("ns-program"), servEl = $("ns-service"), destEl = $("ns-destination");
    var fileEl = $("ns-servicefile"), linkState = $("ns-linkstate");
    var routeEl = $("ns-route"), destTitle = $("ns-dest"), timeEl = $("ns-time");
    var stopsEl = $("ns-stops"), footerEl = $("ns-footer"), clockEl = $("ns-clock");
    var editorEl = $("ns-editor"), saveState = $("ns-savestate");
    var gpsState = $("ns-gpsstate");

    var progCache = {};
    var S = { stops: [], idx: -1, running: false, announcedHere: {}, announcedNext: {} };
    var watchId = null, lastPos = null;
    var NS_WINDOW = 3; // display shows current stop + next two only

    /* ---------- clocks ---------- */
    function tick() {
        var d = new Date(), h = d.getHours(), m = d.getMinutes();
        var ap = h >= 12 ? "pm" : "am", hh = h % 12 || 12;
        var s = hh + ":" + String(m).padStart(2, "0") + ap;
        timeEl.textContent = s;
        if (clockEl) clockEl.textContent = s;
    }
    tick(); setInterval(tick, 10000);

    /* ---------- helpers ---------- */
    function sayStatus(t) { if (saveState) saveState.textContent = t; }

    function serviceKeys(p) {
        return Object.keys((p && p.services) || {}).sort(function (a, b) {
            var na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
            if (na && nb) return parseInt(a, 10) - parseInt(b, 10);
            if (na) return -1; if (nb) return 1;
            return a.localeCompare(b, undefined, { numeric: true });
        });
    }
    function destNames(p, s) { return Object.keys(((p.services || {})[s]) || {}); }
    function getProgram(n) {
        if (progCache[n]) return Promise.resolve(progCache[n]);
        return fetch("/api/programs/" + encodeURIComponent(n)).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (p) { progCache[n] = p; return p; });
    }
    function fill(sel, items, ph) {
        sel.innerHTML = "";
        if (ph) { var o = document.createElement("option"); o.value = ""; o.textContent = ph; sel.appendChild(o); }
        items.forEach(function (n) { var e = document.createElement("option"); e.value = n; e.textContent = n; sel.appendChild(e); });
    }

    /* ---------- TTS layer ----------
       Priority: premade audio file (stop.audio_next/here) -> optional local AI
       (POST /api/tts, 501 until configured) -> browser speechSynthesis.
       Announcements are serialised with a short gap after interrupting,
       so a chopped utterance never pops/clicks into the next one. */
    var speakTimer = null, currentAudio = null;
    var voiceActive = false, lastVoiceEnd = 0; // our own speech state
    function stopAudio() {
        if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
        if (currentAudio) {
            try { currentAudio.pause(); } catch (e) { }
            currentAudio = null;
        }
    }
    function engineBusy() {
        try { return speechSynthesis.speaking || speechSynthesis.pending; }
        catch (e) { return false; }
    }
    // True when speech is genuinely still in flight (see browserSpeak).
    function chopIfBusy() {
        var recentEnd = false;
        try { recentEnd = Date.now() - lastVoiceEnd < 300; } catch (e) { }
        var busy = (voiceActive || engineBusy()) && !(recentEnd && !voiceActive);
        if (busy) { try { speechSynthesis.cancel(); voiceActive = false; } catch (e) { } }
        return busy;
    }
    function browserSpeak(text) {
        if (!$("ns-tts").checked || !text) return;
        try {
            stopAudio();
            var wasBusy = chopIfBusy();
            // Terminal punctuation lets the voice decay instead of cutting
            // off hard at the last word (another end-of-speech click source).
            if (!/[.!?…:;]$/.test(text)) text += ".";
            var u = new SpeechSynthesisUtterance(text);
            var v = $("ns-voice").value;
            if (v) { var vs = speechSynthesis.getVoices().filter(function (x) { return x.name === v; }); if (vs[0]) u.voice = vs[0]; }
            u.rate = parseFloat($("ns-rate").value) || 1;
            u.pitch = 1;
            u.volume = 1;
            u.onstart = function () { voiceActive = true; };
            var done = function () { voiceActive = false; lastVoiceEnd = Date.now(); };
            u.onend = done;
            u.onerror = done;
            var go = function () { speakTimer = null; try { speechSynthesis.speak(u); } catch (e) { console.warn(e); } };
            // Gap after chopping the previous utterance: speaking into the
            // same tick as cancel() is what produces the click/pop.
            if (wasBusy) speakTimer = setTimeout(go, 150);
            else go();
        } catch (e) { console.warn(e); }
    }
    function playAudioThen(path, fallbackText) {
        path = (path || "").trim();
        if (!path) { browserSpeak(fallbackText); return; }
        stopAudio();
        chopIfBusy();
        try {
            var a = new Audio(path);
            currentAudio = a;
            a.onended = function () { if (currentAudio === a) currentAudio = null; };
            a.onerror = function () { if (currentAudio === a) currentAudio = null; browserSpeak(fallbackText); };
            var p = a.play();
            if (p && p.catch) p.catch(function () { if (currentAudio === a) currentAudio = null; browserSpeak(fallbackText); });
        } catch (e) { browserSpeak(fallbackText); }
    }
    function speak(text, audioPath) {
        if (!$("ns-tts").checked || !text) return;
        if (audioPath && audioPath.trim()) { playAudioThen(audioPath, text); return; }
        if ($("ns-localai").checked) {
            fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, voice: piperVoice() }) })
                .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (res) {
                    if (res.ok && res.j && res.j.audio) playAudioThen(res.j.audio, text);
                    else browserSpeak(text);
                }).catch(function () { browserSpeak(text); });
            return;
        }
        browserSpeak(text);
    }
    function nextText(s) { return s.announce_next || ("Next stop, " + shortName(s)); }
    function hereText(s) { return s.announce_here || shortName(s); }
    function lastText(s) { return s.announce_last || ("This is our last stop, " + shortName(s)); }
    // Arrival speech for stop i: the final stop gets the last-stop message.
    function arrivalSpeech(i) {
        var st = S.stops[i];
        if (i === S.stops.length - 1) return { text: lastText(st), audio: st.audio_last || st.audio_here };
        return { text: hereText(st), audio: st.audio_here };
    }

    /* ---------- Piper local-AI TTS (Bus Audio Studio pipeline) ----------
       Voices + engine status from the portal; live lines are synthesised
       server-side and cached, pre-bake warms the whole service at once. */
    function piperVoice() {
        var el = $("ns-piper-voice");
        return (el && el.value) || "";
    }
    function refreshPiper() {
        fetch("/api/tts/voices").then(function (r) { return r.json(); }).then(function (v) {
            var sel = $("ns-piper-voice"), cur = sel.value;
            sel.innerHTML = "";
            (v.voices || []).forEach(function (name) {
                var o = document.createElement("option");
                o.value = name;
                o.textContent = name.replace(/\.onnx$/, "");
                sel.appendChild(o);
            });
            if (cur) sel.value = cur;
            var st = $("ns-piperstate");
            if (!v.piper && !(v.voices || []).length) {
                st.textContent = "Piper not installed and no voices here — copy .onnx + JSONs to voices/ (see voices/README.md). Browser TTS in use.";
            } else if (!v.piper) {
                st.textContent = "Voices present but piper engine missing (pip install piper-tts + espeak-ng on the Pi). Browser TTS in use.";
            } else if (!(v.voices || []).length) {
                st.textContent = "Piper engine ready but no voices — copy .onnx files to voices/. Browser TTS in use.";
            } else {
                st.textContent = "Piper ready (" + v.voices.length + " voice" + (v.voices.length === 1 ? "" : "s") + ", " + v.custom_words + " custom pronunciations). Tick the box above to use it.";
            }
        }).catch(function () {
            $("ns-piperstate").textContent = "Piper status unavailable.";
        });
    }
    $("ns-pregen").addEventListener("click", function () {
        var svc = fileEl.value;
        if (!svc) { sayStatus("Pick a service file first."); return; }
        var btn = $("ns-pregen");
        btn.disabled = true;
        $("ns-piperstate").textContent = "Synthesising " + svc + "… (first run takes a while)";
        fetch("/api/tts/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: svc, voice: piperVoice() }) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error(res.j.error || "failed");
                $("ns-piperstate").textContent = "Baked " + res.j.total + " lines for " + svc + " (" + res.j.voice.replace(/\.onnx$/, "") + ": " + res.j.generated + " new, " + res.j.cached + " cached).";
            })
            .catch(function (e) { $("ns-piperstate").textContent = "Pre-bake failed: " + e.message; })
            .then(function () { btn.disabled = false; });
    });

    // Passenger-facing short name: drop the locality (sub) and leading
    // filler words, so "Opposite Market Place / Burton upon Trent"
    // announces as just "Market Place".
    function shortName(s) {
        var n = ((s && s.name) || "").trim().replace(/\s+/g, " ");
        n = n.replace(/^(opposite|adjacent to|near|outside|opposite to)\s+/i, "");
        return n || ((s && s.name) || "").trim();
    }

    function loadVoices() {
        try {
            var vs = speechSynthesis.getVoices();
            var sel = $("ns-voice"), cur = sel.value;
            sel.innerHTML = '<option value="">System default</option>';
            vs.forEach(function (v) { var o = document.createElement("option"); o.value = v.name; o.textContent = v.name + " (" + v.lang + ")"; sel.appendChild(o); });
            sel.value = cur;
        } catch (e) { /* no TTS in this browser */ }
    }
    if ("speechSynthesis" in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }

    /* ---------- display render ---------- */
    function render(routeNum, destination) {
        routeEl.textContent = routeNum || "–";
        destTitle.textContent = destination || "No route loaded";
        stopsEl.innerHTML = "";
        if (!S.stops.length) {
            footerEl.textContent = "No stops in this service file — add some below.";
            return;
        }
        // Only the current stop + next two are shown; the window slides
        // as the route advances (clamped so the last stops still fill it).
        var start = S.idx < 0 ? 0 : Math.min(S.idx, Math.max(0, S.stops.length - NS_WINDOW));
        S.stops.forEach(function (s, i) {
            if (i < start || i >= start + NS_WINDOW) return; // 3-stop window
            var li = document.createElement("li");
            li.className = i < S.idx ? "done" : (i === S.idx ? "current" : "todo");
            var rail = document.createElement("div"); rail.className = "rail";
            var dot = document.createElement("div"); dot.className = "dot"; rail.appendChild(dot);
            var body = document.createElement("div");
            var nm = document.createElement("div"); nm.className = "sname"; nm.textContent = s.name;
            body.appendChild(nm);
            if (s.sub) { var sb = document.createElement("div"); sb.className = "ssub"; sb.textContent = s.sub; body.appendChild(sb); }
            if (i === S.stops.length - 1) {
                var lb = document.createElement("div");
                lb.className = "slast";
                lb.textContent = i === S.idx ? "★ This is our last stop" : "★ Last stop";
                body.appendChild(lb);
            }
            li.appendChild(rail); li.appendChild(body);
            li.title = "Click to jump here (test)";
            li.addEventListener("click", function () { arriveAt(i, true); });
            stopsEl.appendChild(li);
        });
        var cur = S.stops[S.idx];
        footerEl.textContent = !S.running ? ("Ready: " + S.stops.length + " stops. Press Start or click a stop to test.")
            : cur ? ("Now at " + (S.idx + 1) + "/" + S.stops.length + ": " + cur.name + (lastPos ? " · GPS live" : " · manual (GPS off/no fix)") + ".")
            : ("Finished — " + S.stops.length + " stops.");
    }

    function arriveAt(i, manual) {
        if (i < 0 || i >= S.stops.length) return;
        S.idx = i;
        var key = i + ":" + S.stops[i].name;
        var prog = progCache[progEl.value];
        var svc = prog ? (prog.services || {}) : {};
        render(currentRoute(), currentDest());
        if (!S.announcedHere[key]) {
            S.announcedHere[key] = true;
            var st = S.stops[i];
            var a = arrivalSpeech(i);
            speak(a.text, a.audio);
            footerEl.textContent = (manual ? "Testing stop " : "Arrived: ") + st.name + (st.sub ? " — " + st.sub : "") + (i === S.stops.length - 1 ? " (last stop)." : ".");
        }
    }

    function announceNext(i) {
        var st = S.stops[i];
        if (!st) return;
        var key = i + ":" + st.name;
        if (S.announcedNext[key]) return;
        S.announcedNext[key] = true;
        speak(nextText(st), st.audio_next);
    }

    function currentRoute() {
        var f = null;
        try { f = JSON.parse(fileEl.selectedOptions[0].dataset.raw || "null"); } catch (e) { }
        return (S.routeNum || "").toString();
    }
    function currentDest() {
        return S.destLabel || destEl.value || "";
    }

    /* ---------- route load ---------- */
    function loadServiceFile(name, done) {
        if (!name) { S.stops = []; S.idx = -1; S.running = false; render("", ""); if (done) done(null); return; }
        fetch("/api/nextstop/services/" + encodeURIComponent(name)).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        }).then(function (svc) {
            S.routeNum = svc.route_number || "";
            S.destLabel = svc.destination || destEl.value;
            S.stops = svc.stops || [];
            S.trig = svc.trigger_radius_m; S.appr = svc.approach_radius_m;
            S.idx = -1; S.announcedHere = {}; S.announcedNext = {};
            render(S.routeNum, S.destLabel);
            buildEditor(svc);
            if (done) done(svc);
        }).catch(function (e) { console.error(e); sayStatus("Could not load service: " + e.message); });
    }

    function refreshLinkState() {
        getProgram(progEl.value).then(function (p) {
            var d = (((p.services || {})[servEl.value] || {})[destEl.value]) || {};
            var linked = d.nextstop_service || "";
            linkState.textContent = linked ? ("Destination links to: " + linked + (linked !== fileEl.value ? " (select it above to load)" : "")) : "This destination has no linked .service file yet — pick one and press Link.";
            if (linked && fileEl.querySelector('option[value="' + CSS.escape(linked) + '"]') && !fileEl.value) {
                fileEl.value = linked;
                loadServiceFile(linked);
            }
        }).catch(function () { });
    }

    function onProgram() {
        var n = progEl.value;
        if (!n) return Promise.resolve();
        return getProgram(n).then(function (p) {
            fill(servEl, serviceKeys(p));
            return onService();
        });
    }
    function onService() {
        var n = progEl.value, s = servEl.value;
        if (!n || !s) return Promise.resolve();
        return getProgram(n).then(function (p) {
            fill(destEl, destNames(p, s));
            return onDest();
        });
    }
    function onDest() { refreshLinkState(); }

    progEl.addEventListener("change", onProgram);
    servEl.addEventListener("change", onService);
    destEl.addEventListener("change", onDest);
    fileEl.addEventListener("change", function () { loadServiceFile(fileEl.value); });

    $("ns-link").addEventListener("click", function () {
        var body = { program: progEl.value, service: servEl.value, destination: destEl.value, nextstop_service: fileEl.value || "" };
        if (!body.program || !body.service || !body.destination) { sayStatus("Pick program/service/destination first."); return; }
        fetch("/api/nextstop/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error(res.j.error || "failed");
                progCache[progEl.value] = null; delete progCache[progEl.value];
                sayStatus(fileEl.value ? ("Linked to " + fileEl.value + ".") : "Unlinked.");
                refreshLinkState();
            }).catch(function (e) { sayStatus("Link failed: " + e.message); });
    });

    /* ---------- fullscreen (bus display only) ---------- */
    var displayEl = $("ns-display");
    function fsActive() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }
    function setFsLabel() {
        var b = $("ns-fs");
        if (b) b.textContent = fsActive() ? "⛶ Exit" : "⛶ Full";
        if (displayEl) displayEl.classList.toggle("fs", fsActive());
    }
    function toggleFs() {
        if (fsActive()) {
            if (displayEl) displayEl.classList.remove("fs");
            if (document.exitFullscreen) document.exitFullscreen().catch(function () { });
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else if (displayEl) {
            displayEl.classList.add("fs"); // fullscreenchange confirms it
            if (displayEl.requestFullscreen) displayEl.requestFullscreen().catch(function (e) { displayEl.classList.remove("fs"); sayStatus("Fullscreen blocked: " + e.message); });
            else if (displayEl.webkitRequestFullscreen) displayEl.webkitRequestFullscreen();
        }
    }
    $("ns-fs").addEventListener("click", toggleFs);
    $("ns-fsexit").addEventListener("click", function (e) { e.stopPropagation(); toggleFs(); });
    displayEl.addEventListener("dblclick", function (e) {
        if (e.target.closest("li")) return; // stop-jump clicks stay single-purpose
        toggleFs();
    });
    document.addEventListener("keydown", function (e) {
        if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) {
            var t = e.target && e.target.tagName;
            if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
            toggleFs();
        }
    });
    document.addEventListener("fullscreenchange", setFsLabel);
    document.addEventListener("webkitfullscreenchange", setFsLabel);

    /* ---------- transport ---------- */
    $("ns-start").addEventListener("click", function () {
        if (!S.stops.length) { sayStatus("Load a service file with stops first."); return; }
        S.running = true; S.idx = Math.max(0, 0);
        S.announcedHere = {}; S.announcedNext = {};
        render(S.routeNum, S.destLabel);
        arriveAt(0, true);
        // Board keeps looping the destination while the laptop runs next-stop.
        fetch("/api/board/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ program: progEl.value, service: servEl.value, destination: destEl.value }) })
            .then(function () { }).catch(function () { });
        footerEl.textContent = "Route running — board shows destination, this screen shows stops.";
    });
    $("ns-stop").addEventListener("click", function () {
        S.running = false; render(S.routeNum, S.destLabel);
        footerEl.textContent = "Route stopped.";
        stopAudio();
        voiceActive = false; // abandon the tail, not mid-word: no chop click
        try { speechSynthesis.cancel(); } catch (e) { }
    });
    $("ns-next").addEventListener("click", function () {
        if (!S.stops.length) return;
        S.running = true;
        // Arrival only: firing the "next stop" warning and the arrival in
        // the same tick chops the first utterance (audible click).
        arriveAt(Math.min(S.stops.length - 1, S.idx + 1), true);
    });
    $("ns-prev").addEventListener("click", function () {
        if (!S.stops.length) return;
        arriveAt(Math.max(0, S.idx - 1), true);
    });
    $("ns-say-next").addEventListener("click", function () {
        var n = S.stops[Math.min(S.stops.length - 1, S.idx + 1)] || S.stops[0];
        if (n) speak(nextText(n), n.audio_next);
    });
    $("ns-say-here").addEventListener("click", function () {
        var i = S.idx >= 0 ? S.idx : 0;
        if (!S.stops[i]) return;
        var a = arrivalSpeech(i);
        speak(a.text, a.audio);
    });

    /* ---------- GPS ---------- */
    function haversine(a, b, c, d) {
        var R = 6371000, t = Math.PI / 180;
        var x = (c - a) * t, y = (d - b) * t;
        var h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * t) * Math.cos(c * t) * Math.sin(y / 2) * Math.sin(y / 2);
        return 2 * R * Math.asin(Math.sqrt(h));
    }
    function onPos(p) {
        lastPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
        var appr = parseInt($("ns-approach").value) || 250;
        var rad = parseInt($("ns-radius").value) || 60;
        gpsState.textContent = "GPS: " + lastPos.lat.toFixed(5) + ", " + lastPos.lon.toFixed(5) + " (±" + Math.round(lastPos.acc) + "m)";
        if (!S.running || !$("ns-gps").checked || !S.stops.length) return;
        // Arrival wins over approach for the same stop: entering the
        // arrival radius means you are also inside the approach ring, so
        // firing both chops the warning mid-speech (audible click).
        var startIdx = S.idx;
        for (var i = Math.max(0, startIdx); i < S.stops.length; i++) {
            (function (i) {
                var st = S.stops[i];
                var am = st.approach_m || appr, rm = st.radius_m || rad;
                var d = haversine(lastPos.lat, lastPos.lon, st.lat, st.lon);
                if (d <= rm && i > S.idx) arriveAt(i, false);
                else if (i === S.idx + 1 && d <= am) announceNext(i);
            })(i);
        }
        render(S.routeNum, S.destLabel);
    }
    function onPosErr(e) { gpsState.textContent = "GPS error: " + (e.message || e.code) + " — use Prev/Next buttons."; }
    function armGPS() {
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        if (!$("ns-gps").checked || !navigator.geolocation) {
            gpsState.textContent = navigator.geolocation ? "GPS: off (manual buttons)" : "GPS: not available — use Prev/Next buttons.";
            return;
        }
        try {
            watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
            gpsState.textContent = "GPS: waiting for fix…";
        } catch (e) { gpsState.textContent = "GPS: " + e.message; }
    }
    $("ns-gps").addEventListener("change", armGPS);
    armGPS();

    /* ---------- service file editor ---------- */
    function stopRow(s, i) {
        var FIELDS = ["name", "sub", "lat", "lon", "approach_m", "radius_m", "announce_next", "announce_here", "announce_last", "audio_next", "audio_here", "audio_last"];
        var d = document.createElement("div");
        d.className = "ns-stop-card";
        d.innerHTML =
            '<div class="grid">' +
            '<input type="text" data-k="name" placeholder="Stop name" value="">' +
            '<input type="text" data-k="sub" placeholder="Sub (e.g. Stop E)" value="">' +
            '<input type="number" data-k="lat" step="0.000001" placeholder="lat" value="">' +
            '<input type="number" data-k="lon" step="0.000001" placeholder="lon" value="">' +
            '<input type="number" data-k="approach_m" placeholder="approach m" value="">' +
            '<input type="number" data-k="radius_m" placeholder="arrival m" value="">' +
            '<input type="text" class="full" data-k="announce_next" placeholder="Next-stop announcement (optional)" value="">' +
            '<input type="text" class="full" data-k="announce_here" placeholder="Arrival announcement (optional)" value="">' +
            '<input type="text" class="full" data-k="announce_last" placeholder="Last-stop message (final stop only)" value="">' +
            '<input type="text" data-k="audio_next" placeholder="audio_next (audio/x.mp3)" value="">' +
            '<input type="text" data-k="audio_here" placeholder="audio_here (audio/x.mp3)" value="">' +
            '<input type="text" data-k="audio_last" placeholder="audio_last (final stop)" value="">' +
            '</div><div class="ns-row" style="margin-top:.4rem">' +
            '<button class="tbtn" data-act="gps" type="button">Use GPS</button>' +
            '<button class="tbtn" data-act="del" type="button">Remove</button></div>';
        FIELDS.forEach(function (k) {
            var inp = d.querySelector('[data-k="' + k + '"]');
            if (s && s[k] !== undefined && s[k] !== "") inp.value = s[k];
        });
        d.querySelector('[data-act="del"]').addEventListener("click", function () { d.remove(); });
        d.querySelector('[data-act="gps"]').addEventListener("click", function () {
            if (!lastPos) { sayStatus("No GPS fix yet."); return; }
            d.querySelector('[data-k="lat"]').value = lastPos.lat.toFixed(6);
            d.querySelector('[data-k="lon"]').value = lastPos.lon.toFixed(6);
        });
        return d;
    }
    function buildEditor(svc) {
        editorEl.innerHTML = "";
        var meta = document.createElement("div");
        meta.className = "ns-stop-card";
        meta.innerHTML = '<div class="grid"><input type="text" id="ns-meta-route" placeholder="Route no (83)" value="">' +
            '<input type="text" id="ns-meta-dest" placeholder="Destination" value="">' +
            '<input type="text" id="ns-meta-origin" placeholder="Origin" value="">' +
            '<input type="number" id="ns-meta-appr" placeholder="approach default" value="">' +
            '<input type="number" id="ns-meta-trig" placeholder="arrival default" value=""></div>';
        editorEl.appendChild(meta);
        if (svc) {
            $("ns-meta-route").value = svc.route_number || "";
            $("ns-meta-dest").value = svc.destination || "";
            $("ns-meta-origin").value = svc.origin || "";
            $("ns-meta-appr").value = svc.approach_radius_m || 250;
            $("ns-meta-trig").value = svc.trigger_radius_m || 60;
            (svc.stops || []).forEach(function (s) { editorEl.appendChild(stopRow(s)); });
        }
    }
    $("ns-addstop").addEventListener("click", function () { editorEl.appendChild(stopRow({})); });
    $("ns-save").addEventListener("click", function () {
        var name = fileEl.value;
        if (!name) { sayStatus("Pick or create a service file first."); return; }
        var stops = [];
        editorEl.querySelectorAll(".ns-stop-card").forEach(function (card, ci) {
            if (ci === 0) return; // meta card
            function v(k) { var el = card.querySelector('[data-k="' + k + '"]'); return el ? el.value : ""; }
            stops.push({
                name: v("name"), sub: v("sub"),
                lat: parseFloat(v("lat")), lon: parseFloat(v("lon")),
                approach_m: parseInt(v("approach_m")) || 250,
                radius_m: parseInt(v("radius_m")) || 60,
                announce_next: v("announce_next"), announce_here: v("announce_here"),
                announce_last: v("announce_last"),
                audio_next: v("audio_next"), audio_here: v("audio_here"),
                audio_last: v("audio_last")
            });
        });
        var body = {
            route_number: ($("ns-meta-route") || {}).value || "",
            destination: ($("ns-meta-dest") || {}).value || "",
            origin: ($("ns-meta-origin") || {}).value || "",
            approach_radius_m: parseInt(($("ns-meta-appr") || {}).value) || 250,
            trigger_radius_m: parseInt(($("ns-meta-trig") || {}).value) || 60,
            stops: stops
        };
        sayStatus("Saving…");
        fetch("/api/nextstop/services/" + encodeURIComponent(name), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error(res.j.error || "failed");
                sayStatus("Saved " + name + " (" + stops.length + " stops).");
                loadServiceFile(name);
            }).catch(function (e) { sayStatus("Save failed: " + e.message); });
    });
    $("ns-create").addEventListener("click", function () {
        var n = ($("ns-newname").value || "").trim();
        if (!n) { sayStatus("Type a new service name first."); return; }
        fetch("/api/nextstop/services", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error(res.j.error || "failed");
                return refreshFiles().then(function () { fileEl.value = n; loadServiceFile(n); sayStatus("Created " + n + " — add stops and Save."); });
            }).catch(function (e) { sayStatus("Create failed: " + e.message); });
    });

    /* ---------- boot ---------- */
    function refreshFiles() {
        return fetch("/api/nextstop/services").then(function (r) { return r.json(); }).then(function (names) {
            var cur = fileEl.value;
            fill(fileEl, names, "– none –");
            if (names.indexOf(cur) >= 0) fileEl.value = cur;
            // stash raw for route label (reloaded on select anyway)
            Array.prototype.forEach.call(fileEl.options, function (o) { o.dataset.raw = "null"; });
        });
    }
    fetch("/api/audio").then(function (r) { return r.json(); }).then(function (files) {
        $("ns-audiolist").innerHTML = files.length ? ("Drop MP3s in <code>audio/</code>:<br>" + files.map(function (f) { return "<code>" + f.path + "</code>"; }).join("<br>")) : "No premade audio yet — drop MP3s in <code>audio/</code>.";
    }).catch(function () { $("ns-audiolist").textContent = "Audio list unavailable."; });
    refreshPiper();

    fetch("/api/programs").then(function (r) { return r.json(); }).then(function (names) {
        if (!names.length) { fill(progEl, [], "No programs"); return; }
        fill(progEl, names);
        return fetch("/api/board/state").then(function (r) { return r.json(); }).then(function (s) {
            var sel = s.selection || {};
            if (sel.program && names.indexOf(sel.program) >= 0) progEl.value = sel.program;
            return refreshFiles().then(onProgram).then(function () {
                if (sel.service) servEl.value = sel.service;
                return onService().then(function () {
                    if (sel.destination) destEl.value = sel.destination;
                    onDest();
                });
            });
        }).catch(function () { return refreshFiles().then(onProgram); });
    }).catch(function (e) { console.error(e); });

    buildEditor(null);
})();
