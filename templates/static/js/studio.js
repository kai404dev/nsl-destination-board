/* Studio top-level tabs: load the Editor / Program partial into #contenter
 * and highlight the selected tab. Relies on NSLTabs (tabs.js) for the
 * tab groups inside the loaded partials.
 */
(function () {
    var VIEWS = {
        editor: '/templates/pages/editor.html',
        program: '/templates/pages/program.html',
        fonts: '/templates/pages/fonts.html'
    };

    var tabsEl = document.getElementById('studio-tabs');
    var contentEl = document.getElementById('contenter');

    function setActive(name) {
        tabsEl.querySelectorAll('.tab button').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.view === name);
        });
    }

    function load(name) {
        if (!VIEWS[name]) return;
        setActive(name);
        contentEl.innerHTML = '<p>Loading...</p>';
        fetch(VIEWS[name])
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.text();
            })
            .then(function (html) {
                contentEl.innerHTML = html.trim() ? html : '<p>This view is empty.</p>';
                // Editor first: it restores saved values + tab selection,
                // then tabs picks up the restored `.active` buttons.
                if (window.NSLEditor) window.NSLEditor.init(contentEl);
                if (window.NSLProgram) window.NSLProgram.init(contentEl);
                if (window.NSLFonts) window.NSLFonts.init(contentEl);
                if (window.NSLTabs) window.NSLTabs.init(contentEl);
            })
            .catch(function (err) {
                contentEl.innerHTML = '<p>Could not load this view.</p>';
                console.error(err);
            });
    }

    tabsEl.addEventListener('click', function (event) {
        var btn = event.target.closest('.tab button');
        if (btn && VIEWS[btn.dataset.view]) load(btn.dataset.view);
    });

    window.addEventListener('DOMContentLoaded', function () {
        load('editor');
    });
})();
