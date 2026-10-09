/* NSLTabs - tiny tab-switcher for `.tabs` button groups.
 *
 * A tab group is a `.tabs` element whose parent also contains a `.tab-pages`
 * element as a direct child (e.g. `.side-bar` or `.sign-attributes` in the
 * editor partial). Buttons and `.tab-page` panels are matched by order.
 * Works on content injected later via fetch - just call `NSLTabs.init(root)`.
 */
(function () {
    function panelsFor(tabsEl) {
        var parent = tabsEl.parentElement;
        if (!parent) return null;
        return parent.querySelector(':scope > .tab-pages');
    }

    function buttonsOf(tabsEl) {
        return Array.prototype.slice.call(tabsEl.querySelectorAll('.tab button'));
    }

    function pagesOf(pagesEl) {
        return Array.prototype.slice.call(pagesEl.querySelectorAll(':scope > .tab-page'));
    }

    function activate(tabsEl, index) {
        var pagesEl = panelsFor(tabsEl);
        if (!pagesEl) return false;
        var buttons = buttonsOf(tabsEl);
        var pages = pagesOf(pagesEl);
        if (!buttons.length || !pages.length) return false;
        index = Math.max(0, Math.min(index, Math.min(buttons.length, pages.length) - 1));
        buttons.forEach(function (btn, i) {
            btn.classList.toggle('active', i === index);
        });
        pages.forEach(function (page, i) {
            page.hidden = i !== index;
        });
        return true;
    }

    function init(root) {
        (root || document).querySelectorAll('.tabs').forEach(function (tabsEl) {
            var buttons = buttonsOf(tabsEl);
            var current = buttons.findIndex(function (btn) {
                return btn.classList.contains('active');
            });
            activate(tabsEl, current >= 0 ? current : 0);
        });
    }

    // Delegated so tabs loaded via fetch work without rebinding.
    document.addEventListener('click', function (event) {
        var btn = event.target.closest('.tabs .tab button');
        if (!btn) return;
        var tabsEl = btn.closest('.tabs');
        var index = buttonsOf(tabsEl).indexOf(btn);
        if (index >= 0) activate(tabsEl, index);
    });

    window.NSLTabs = { init: init, activate: activate };
})();
