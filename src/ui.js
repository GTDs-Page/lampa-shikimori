/**
 * Lampa UI Components for Shikimori Plugin
 * Fully adapted for Android TV D-Pad Remote Navigation
 */
var ShikiUI = (function () {
    var SHIKI_ICON = '<svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>';
    var DISCOVERY_TTL = 10 * 60 * 1000;
    var discoveryCache = { at: 0, rows: null };

    function getNavigator() {
        if (typeof Navigator !== 'undefined' && Navigator && typeof Navigator.move === 'function') return Navigator;
        if (typeof window !== 'undefined' && window.Navigator && typeof window.Navigator.move === 'function') return window.Navigator;
        if (typeof Lampa !== 'undefined' && Lampa.Navigator && typeof Lampa.Navigator.move === 'function') return Lampa.Navigator;
        return null;
    }

    function navFocus(target, htmlContainer) {
        if (!target) return;
        var elem = target instanceof jQuery ? target[0] : target;
        if (!elem || !document.contains(elem)) return;

        // One call only. Navigator.focus already emits "focus", which makes
        // Lampa's Controller set select_active, move the focus class and fire
        // hover:focus. Doing that by hand as well fired hover:focus three times
        // per move, which is what made scrolling and card animations stutter.
        if (window.Lampa && Lampa.Controller && Lampa.Controller.collectionFocus && htmlContainer) {
            var html = htmlContainer instanceof jQuery ? htmlContainer[0] : htmlContainer;
            Lampa.Controller.collectionFocus(elem, html, true);
        } else if (window.Lampa && Lampa.Controller && Lampa.Controller.focus) {
            Lampa.Controller.focus(elem);
        }
    }

    /**
     * Is this component the activity currently on screen? Async callbacks (page
     * loads, progress events) used to re-collect and re-focus the global
     * Navigator collection even when their page was buried under another one,
     * which left the remote controlling invisible content.
     */
    function isActive(component) {
        try {
            if (!component || !window.Lampa || !Lampa.Activity || !Lampa.Activity.own) return true;
            return !!Lampa.Activity.own(component);
        } catch (e) {
            return false;
        }
    }

    /**
     * May this page touch the global focus collection right now? While a modal,
     * selectbox, keyboard, player or the head/menu layer is active the "content"
     * controller is not ours; re-collecting there would steal the focus from the
     * layer the user is actually using.
     */
    function navigationAllowed(component) {
        if (!isActive(component)) return false;
        var name = enabledControllerName();
        return !name || name === 'content';
    }

    function enabledControllerName() {
        try {
            if (window.Lampa && Lampa.Controller && Lampa.Controller.enabled) {
                var active = Lampa.Controller.enabled();
                return active ? active.name : null;
            }
        } catch (e) {}
        return null;
    }

    function restoreController(name) {
        if (!name) return;
        try {
            if (window.Lampa && Lampa.Controller && enabledControllerName() !== name) {
                Lampa.Controller.toggle(name);
            }
        } catch (e) {}
    }

    /**
     * Keep the focused card visible inside a horizontal row. The Navigator moves
     * focus spatially and knows nothing about nested scrollers, so without this
     * the focus disappears off the right edge of Lampa-like rows.
     */
    function scrollRow(element) {
        if (!element || !element.closest) return;
        var row = element.closest('.shiki-hub-cards, .shiki-filter-pills, .shikimori-view__voices, .shikimori-view__seasons');
        if (!row || row.scrollWidth <= row.clientWidth + 4) return;

        var itemRect = element.getBoundingClientRect();
        var rowRect = row.getBoundingClientRect();
        var offset = (itemRect.left - rowRect.left) - (rowRect.width - itemRect.width) / 2;
        if (Math.abs(offset) < 8) return;

        var target = row.scrollLeft + offset;
        target = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, target));
        $(row).stop(true).animate({ scrollLeft: target }, 140);
    }

    function init() {
        injectStyles();
        registerMenu();
        registerFullCardButton();
        registerComponents();
    }

    function injectStyles() {
        var css = `
            /* Strict constraints for SVGs on TV */
            .shiki-icon,
            .shiki-catalog-header svg,
            .shiki-search-wrapper svg,
            .shiki-card svg,
            .btn-shiki-search-shortcut svg,
            .shiki-filter-row svg,
            .shiki-hub-search-btn svg,
            .shiki-hub-catalog-btn svg {
                width: 20px !important;
                height: 20px !important;
                min-width: 20px !important;
                min-height: 20px !important;
                max-width: 20px !important;
                max-height: 20px !important;
                display: inline-block !important;
                vertical-align: middle !important;
                flex-shrink: 0 !important;
            }

            .shiki-badge {
                position: absolute;
                bottom: 0.5em;
                left: 0.5em;
                background: rgba(0, 0, 0, 0.82);
                border-radius: 4px;
                padding: 0.2em 0.5em;
                font-size: 0.78em;
                font-weight: bold;
                color: #2ecc71;
                border: 1px solid rgba(46, 204, 113, 0.4);
                z-index: 2;
                pointer-events: none;
            }

            .shiki-score {
                position: absolute;
                top: 0.5em;
                right: 0.5em;
                background: rgba(241, 196, 15, 0.95);
                border-radius: 4px;
                padding: 0.15em 0.45em;
                font-size: 0.78em;
                font-weight: bold;
                color: #000;
                z-index: 2;
                pointer-events: none;
            }

            /* TV D-Pad Focus Highlights.
               No will-change/backdrop-filter/shadows on every card: on a TV that
               meant a compositing layer and a blur pass per poster (200+ of them
               in the hub), which is exactly what made navigation stutter. */
            .shiki-card {
                box-sizing: border-box !important;
                transition: transform 0.18s ease-out, box-shadow 0.18s ease-out !important;
                outline: none !important;
                border-radius: 1em !important;
                cursor: pointer !important;
                position: relative !important;
                contain: layout style;
            }
            .shiki-card.focus {
                transform: scale(1.05) !important;
                box-shadow: 0 0 0 3px #2ecc71, 0 6px 14px rgba(0, 0, 0, 0.55) !important;
                z-index: 10 !important;
                will-change: transform;
            }
            .shiki-card.focus .card__title {
                color: #2ecc71 !important;
            }

            /* Standard 2:3 vertical poster proportions matching Lampa cards */
            .shiki-card .card__view {
                position: relative !important;
                width: 100% !important;
                padding-bottom: 150% !important;
                height: 0 !important;
                border-radius: 0.9em !important;
                overflow: hidden !important;
                background: #1c2026 !important;
            }
            .shiki-card .card__view img,
            .shiki-card .card__img {
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                width: 100% !important;
                height: 100% !important;
                object-fit: cover !important;
                border-radius: 0.9em !important;
            }

            .shiki-card .card__title {
                margin-top: 0.6em !important;
                font-size: 1.05em !important;
                font-weight: 600 !important;
                line-height: 1.25 !important;
                height: 2.5em !important;
                display: -webkit-box !important;
                -webkit-line-clamp: 2 !important;
                -webkit-box-orient: vertical !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                color: #ffffff !important;
            }

            .shiki-card .card__age,
            .shiki-card .card__subtitle {
                font-size: 0.85em !important;
                color: #9aa0a6 !important;
                margin-top: 0.25em !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
            }

            .shiki-hub-cards {
                display: flex !important;
                gap: 1.2em !important;
                overflow-x: auto !important;
                padding: 0.8em 0.4em 1.4em 0.4em !important;
                scrollbar-width: none !important;
            }
            .shiki-hub-cards::-webkit-scrollbar {
                display: none !important;
            }
            .shiki-hub-cards .card {
                width: 13.5em !important;
                min-width: 13.5em !important;
                max-width: 13.5em !important;
                flex-shrink: 0 !important;
            }

            /* General Catalog Grid of Titles - 7 cards per row on the TV's
               ~960 CSS px viewport, fewer only on genuinely narrow screens. */
            .category-full.shiki-catalog-grid,
            .category-full.shiki-search-grid-box,
            .shiki-catalog-grid,
            .shiki-search-grid-box {
                display: flex !important;
                flex-wrap: wrap !important;
                width: 100% !important;
                box-sizing: border-box !important;
                margin-bottom: 4em !important;
                padding-bottom: 2em !important;
            }

            .shiki-catalog-grid .card,
            .shiki-search-grid-box .card {
                width: 14.2857% !important;
                box-sizing: border-box !important;
                padding: 0 0.5em !important;
                margin-bottom: 2em !important;
                flex-shrink: 0 !important;
                min-width: 0 !important;
                max-width: none !important;
                display: flex !important;
                flex-direction: column !important;
            }

            @media (max-width: 1100px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 14.2857% !important;
                }
            }
            @media (max-width: 900px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 16.6667% !important;
                }
            }
            @media (max-width: 750px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 20% !important;
                }
            }
            @media (max-width: 600px) {
                .shiki-catalog-grid .card,
                .shiki-search-grid-box .card {
                    width: 25% !important;
                }
            }

            .shiki-pill {
                padding: 0.4em 0.8em;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 6px;
                font-size: 0.85em;
                cursor: pointer;
                transition: all 0.15s ease;
                white-space: nowrap;
                flex-shrink: 0;
                outline: none !important;
            }
            .shiki-pill.focus {
                background: #ffffff !important;
                color: #111111 !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 2px #2ecc71, 0 4px 12px rgba(0,0,0,0.6) !important;
                transform: scale(1.06);
                z-index: 5;
            }
            .shiki-pill.active {
                background: #27ae60 !important;
                border-color: #2ecc71 !important;
                color: #ffffff !important;
                font-weight: bold;
            }
            .shiki-pill.active.focus {
                background: #2ecc71 !important;
                color: #000000 !important;
                font-weight: bold;
            }

            .shiki-hub-search-btn,
            .shiki-hub-catalog-btn,
            .btn-shiki-search-shortcut,
            .shiki-btn-load-more {
                transition: all 0.2s ease;
                outline: none !important;
            }
            .shiki-hub-search-btn.focus,
            .btn-shiki-search-shortcut.focus {
                background: #ffffff !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 3px #2ecc71, 0 8px 20px rgba(0,0,0,0.7) !important;
                transform: scale(1.03);
            }
            .shiki-hub-search-btn.focus *,
            .btn-shiki-search-shortcut.focus * {
                color: #000000 !important;
                fill: #000000 !important;
            }
            .shiki-hub-catalog-btn.focus {
                background: #2ecc71 !important;
                color: #000000 !important;
                box-shadow: 0 0 0 3px #ffffff, 0 8px 20px rgba(0,0,0,0.7) !important;
                transform: scale(1.03);
            }
            .shiki-hub-catalog-btn.focus * {
                color: #000000 !important;
                fill: #000000 !important;
            }
            .shiki-btn-load-more.focus {
                background: #2ecc71 !important;
                color: #000000 !important;
                box-shadow: 0 0 0 3px #ffffff, 0 8px 20px rgba(0,0,0,0.7) !important;
                transform: scale(1.04);
            }

            .shiki-ep-card {
                transition: all 0.15s ease;
                outline: none !important;
            }
            .shiki-ep-card.focus {
                background: #ffffff !important;
                color: #000000 !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 3px #2ecc71, 0 8px 20px rgba(0,0,0,0.8) !important;
                transform: scale(1.06);
                z-index: 5;
            }
            .shiki-ep-card.focus * {
                color: #000000 !important;
            }
            .shiki-ep-watched {
                border-color: rgba(46, 204, 113, 0.4) !important;
            }
            .shiki-ep-next {
                background: rgba(231, 76, 60, 0.2) !important;
                border-color: #e74c3c !important;
            }

            .shiki-status-badge {
                position: absolute;
                top: 0.5em;
                left: 0.5em;
                border-radius: 4px;
                padding: 0.2em 0.5em;
                font-size: 0.72em;
                font-weight: bold;
                color: #fff;
                z-index: 3;
                box-shadow: 0 2px 6px rgba(0,0,0,0.7);
                pointer-events: none;
                letter-spacing: 0.3px;
                white-space: nowrap;
            }
            .shiki-status--completed {
                background: rgba(39, 174, 96, 0.95) !important;
                border: 1px solid #2ecc71 !important;
                color: #fff !important;
            }
            .shiki-status--watching {
                background: rgba(41, 128, 185, 0.95) !important;
                border: 1px solid #3498db !important;
                color: #fff !important;
            }
            .shiki-status--planned {
                background: rgba(230, 126, 34, 0.95) !important;
                border: 1px solid #f39c12 !important;
                color: #fff !important;
            }
            .shiki-status--on_hold {
                background: rgba(127, 140, 141, 0.95) !important;
                border: 1px solid #bdc3c7 !important;
                color: #fff !important;
            }
            .shiki-status--rewatching {
                background: rgba(142, 68, 173, 0.95) !important;
                border: 1px solid #9b59b6 !important;
                color: #fff !important;
            }
            .shiki-status--dropped {
                background: rgba(192, 57, 43, 0.95) !important;
                border: 1px solid #e74c3c !important;
                color: #fff !important;
            }

            .shiki-filter-row {
                display: flex;
                align-items: center;
                gap: 0.8em;
                margin-bottom: 0.6em;
            }
            .shiki-filter-label {
                font-size: 0.85em;
                font-weight: bold;
                color: #aaa;
                min-width: 105px;
                flex-shrink: 0;
            }
            .shiki-filter-pills {
                display: flex;
                gap: 0.4em;
                flex-wrap: nowrap;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 0.2em 0.1em;
                flex: 1;
                min-width: 0;
            }
            .shiki-filter-pills::-webkit-scrollbar {
                display: none;
            }

            /* Voice-over pills: one scrollable row, like the filter rows. */
            .shikimori-view__voices {
                display: flex;
                flex-wrap: nowrap;
                gap: 0.5em;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 0.2em 0.1em;
            }
            .shikimori-view__voices::-webkit-scrollbar {
                display: none;
            }

            .shikimori-view__seasons {
                display: flex;
                flex-wrap: nowrap;
                gap: 0.5em;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 0.2em 0.1em;
                margin-bottom: 1em;
            }
            .shikimori-view__seasons::-webkit-scrollbar {
                display: none;
            }

            .shikimori-view__header.focus {
                outline: 2px solid rgba(46, 204, 113, 0.65);
                outline-offset: 6px;
                border-radius: 12px;
            }

            /* Filter groups are compact chips that open Lampa's selectbox: one
               OK press instead of walking 40+ pills with the D-pad. */
            .shiki-filter-chip {
                display: inline-flex;
                align-items: baseline;
                gap: 0.45em;
                padding: 0.5em 0.9em;
                background: rgba(255, 255, 255, 0.07);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 8px;
                white-space: nowrap;
                max-width: 100%;
                cursor: pointer;
            }
            .shiki-filter-chip__label {
                color: #8a9099;
                font-size: 0.78em;
            }
            .shiki-filter-chip__value {
                color: #ffffff;
                font-size: 0.9em;
                font-weight: 600;
            }
            .shiki-filter-chip.focus {
                background: #ffffff !important;
                border-color: #2ecc71 !important;
                box-shadow: 0 0 0 2px #2ecc71, 0 6px 16px rgba(0, 0, 0, 0.6) !important;
                transform: scale(1.03);
            }
            .shiki-filter-chip.focus .shiki-filter-chip__label,
            .shiki-filter-chip.focus .shiki-filter-chip__value {
                color: #000000 !important;
            }
        `;
        $('head').append('<style id="shikimori-plugin-styles">' + css + '</style>');
    }

    function createStatusBadge(animeId) {
        if (!animeId) return '';
        var rate = ShikiApi.getUserRate(animeId);
        if (rate && rate.status) {
            var text = '';
            switch (rate.status) {
                case 'completed':
                    text = '✓ Просмотрено';
                    break;
                case 'watching':
                    text = '▶ Смотрю' + (rate.episodes ? ' (' + rate.episodes + ')' : '');
                    break;
                case 'planned':
                    text = '⏱ В планах';
                    break;
                case 'on_hold':
                    text = '⏸ Отложено';
                    break;
                case 'rewatching':
                    text = '🔄 Смотрю снова';
                    break;
                case 'dropped':
                    text = '✖ Брошено';
                    break;
                default:
                    text = rate.status;
            }
            return '<div class="shiki-status-badge shiki-status--' + rate.status + '">' + text + '</div>';
        }

        if (ShikiApi.getLocalWatchedEpisodes) {
            var localEps = ShikiApi.getLocalWatchedEpisodes(animeId);
            if (localEps && localEps.length > 0) {
                return '<div class="shiki-status-badge shiki-status--watching">▶ Серия ' + localEps[localEps.length - 1] + '</div>';
            }
        }

        return '';
    }

    /**
     * Standard TV D-Pad Spatial Navigation Controller Binder
     */
    function setupTvController(scrollInstance, component, options) {
        options = options || {};
        var root = scrollInstance.render();
        var api = {
            get lastFocusElem() {
                return root.data('shiki-last-focus') || null;
            },
            setLastFocus: function (elem) {
                elem = elem instanceof jQuery ? elem[0] : elem;
                if (elem && document.contains(elem)) root.data('shiki-last-focus', elem);
            },
            focus: function (target) {
                var elem = target instanceof jQuery ? target[0] : target;
                if (!elem || !document.contains(elem)) return;
                root.data('shiki-last-focus', elem);
                if (!navigationAllowed(component)) return;
                navFocus(elem, root);
            },
            // Kept for the old call sites. Focus is handled from the page root
            // now, so adding a card needs no per-item wiring (and used to stack
            // another hover:focus handler on every render).
            attachToItem: function () {}
        };

        // Lampa dispatches hover:focus with bubbles = false (Utils.trigger), so a
        // delegated jQuery handler on the root never sees it. A capture-phase
        // native listener does, and still binds only once for dynamically added
        // cards. Without this the focus moved but the page/rows never scrolled.
        if (!root.data('shiki-tv-bound')) {
            root.data('shiki-tv-bound', true);
            root[0].addEventListener('hover:focus', function (event) {
                var elem = event.target;
                if (!elem || !elem.classList || !elem.classList.contains('selector')) return;
                root.data('shiki-last-focus', elem);
                // Only make the element visible: centering every single move made
                // the page jump around while browsing (Lampa does the same).
                if (scrollInstance.update) scrollInstance.update(elem);
                scrollRow(elem);
            }, true);
        }

        function move(direction, fallback) {
            var nav = getNavigator();
            if (nav && nav.canmove && nav.canmove(direction) && nav.move) {
                nav.move(direction);
            } else if (fallback) {
                fallback();
            }
        }

        var controller = {
            toggle: function () {
                if (!root || !root[0]) return;
                var remembered = root.data('shiki-last-focus');
                var target = remembered && document.contains(remembered) ? remembered : false;
                // visible_only: skip cards inside collapsed search results and
                // other hidden blocks, otherwise the focus could move onto them
                // and visually disappear.
                Lampa.Controller.collectionSet(root, false, true);
                Lampa.Controller.collectionFocus(target, root, true);
            },
            left: function () {
                move('left', function () { Lampa.Controller.toggle('menu'); });
            },
            right: function () {
                move('right');
            },
            up: function () {
                var nav = getNavigator();
                if (nav && nav.canmove && nav.canmove('up') && nav.move) {
                    nav.move('up');
                } else if (options.onUp) {
                    options.onUp();
                } else {
                    Lampa.Controller.toggle('head');
                }
            },
            down: function () {
                move('down');
            },
            // No enter override: Lampa's Controller.enter already triggers
            // hover:enter on the selected element exactly once. The old override
            // fired it twice, so OK opened every card/episode twice and Back had
            // to be pressed twice as well.
            back: function () {
                Lampa.Activity.backward();
            }
        };

        Lampa.Controller.add('content', controller);
        Lampa.Controller.toggle('content');

        return api;
    }

    function registerMenu() {
        function addMenuItem() {
            var menuList = $('.menu .menu__list').eq(0);
            if (!menuList.length) return;

            if (!$('.menu [data-action="shikimori_hub"]').length) {
                var menuBtn = $(`
                    <li class="menu__item selector" data-action="shikimori_hub">
                        <div class="menu__ico">${SHIKI_ICON}</div>
                        <div class="menu__text">Shikimori</div>
                    </li>
                `);

                menuBtn.on('hover:enter', function () {
                    Lampa.Activity.push({
                        component: 'shikimori_hub',
                        title: 'Shikimori'
                    });
                });

                menuList.append(menuBtn);
            }

            if (!$('.menu [data-action="shikimori_catalog"]').length) {
                var catalogBtn = $(`
                    <li class="menu__item selector" data-action="shikimori_catalog">
                        <div class="menu__ico"><svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/></svg></div>
                        <div class="menu__text">Каталог аниме</div>
                    </li>
                `);

                catalogBtn.on('hover:enter', function () {
                    Lampa.Activity.push({
                        component: 'shikimori_catalog',
                        title: 'Каталог аниме'
                    });
                });

                menuList.append(catalogBtn);
            }

            if (!$('.menu [data-action="shikimori_search"]').length) {
                var searchBtn = $(`
                    <li class="menu__item selector" data-action="shikimori_search">
                        <div class="menu__ico"><svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg></div>
                        <div class="menu__text">Поиск аниме</div>
                    </li>
                `);

                searchBtn.on('hover:enter', function () {
                    // Input first, results immediately: no intermediate search
                    // page with an empty search bar.
                    if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                        ShikiKeyboard.open({
                            title: 'Поиск аниме на Shikimori',
                            value: '',
                            onDone: function (query) {
                                if (!query || !query.trim()) return;
                                query = query.trim();
                                Lampa.Activity.push({
                                    component: 'shikimori_search',
                                    title: 'Поиск: ' + query,
                                    query: query
                                });
                            }
                        });
                        return;
                    }

                    Lampa.Activity.push({
                        component: 'shikimori_search',
                        title: 'Поиск аниме'
                    });
                });

                menuList.append(searchBtn);
            }
        }

        addMenuItem();

        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('activity', function (e) {
                if (e.type === 'start') {
                    addMenuItem();
                }
            });
            Lampa.Listener.follow('menu', function (e) {
                if (e.type === 'end') {
                    addMenuItem();
                }
            });
        }
    }

    function registerFullCardButton() {
        if (!window.Lampa || !Lampa.Listener) return;
        Lampa.Listener.follow('full', function (e) {
            if (e && e.type === 'complite' && e.data && e.data.movie) {
                var movie = e.data.movie;
                var isAnime = false;

                if (movie.original_language === 'ja') isAnime = true;
                if (movie.genres && movie.genres.length) {
                    movie.genres.forEach(function (g) {
                        var name = (g.name || '').toLowerCase();
                        if (name.indexOf('аниме') >= 0 || name.indexOf('мультфильм') >= 0 || name.indexOf('animation') >= 0) {
                            if (movie.original_language === 'ja') isAnime = true;
                        }
                    });
                }

                if (isAnime) {
                    var shikiBtn = $(`
                        <div class="full-start__button selector view--shikimori" style="margin-left: 0.5em;">
                            ${SHIKI_ICON}
                            <span>Shikimori</span>
                        </div>
                    `);

                    shikiBtn.on('hover:enter', function () {
                        searchAndOpenAnime(movie);
                    });

                    var container = e.object && e.object.activity ? e.object.activity.render() : $('.full-start');

                    if (container.find('.view--shikimori').length) return;

                    var torrentBtn = container.find('.view--torrent');
                    if (torrentBtn.length) {
                        torrentBtn.after(shikiBtn);
                    } else {
                        var buttonsContainer = container.find('.full-start-new__buttons, .full-start__buttons');
                        if (buttonsContainer.length) {
                            buttonsContainer.append(shikiBtn);
                        } else {
                            container.append(shikiBtn);
                        }
                    }

                    // The button is injected after Lampa has built the focus
                    // collection for this card, so without appending it the remote
                    // could never reach it.
                    if (window.Lampa && Lampa.Controller && Lampa.Controller.collectionAppend) {
                        try { Lampa.Controller.collectionAppend(shikiBtn); } catch (e) {}
                    }
                }
            }
        });
    }

    function searchAndOpenAnime(movie) {
        if (!movie) return;
        var query = movie.original_name || movie.original_title || movie.name || movie.title;
        if (!query) {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Название аниме не определено');
            return;
        }

        if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Поиск на Shikimori...', { time: 2000 });
        
        ShikiApi.searchAnime(query, 5, function (results) {
            if (results && results.length) {
                var best = results[0];
                Lampa.Activity.push({
                    component: 'shikimori_view',
                    title: best.russian || best.name,
                    anime: best
                });
            } else {
                if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Аниме не найдено на Shikimori', { time: 3000 });
            }
        }, function () {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show('Ошибка поиска на Shikimori', { time: 3000 });
        });
    }

    function registerComponents() {
        Lampa.Component.add('shikimori_hub', ShikimoriHubComponent);
        Lampa.Component.add('shikimori_view', ShikimoriViewComponent);
        Lampa.Component.add('shikimori_search', ShikimoriSearchComponent);
        Lampa.Component.add('shikimori_catalog', ShikimoriCatalogComponent);
    }

    /**
     * Shikimori Catalog Component with Advanced Filtering
     */
    function ShikimoriCatalogComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var container = $('<div class="shiki-catalog-page" style="padding: 1.5em 2.5em 6em 2.5em;"></div>');
        scroll.body().append(container);

        var activeFilters = {
            order: (object && object.order) || 'popularity',
            score: (object && object.score) || 'all',
            season: (object && object.season) || '2024_2026',
            genre: (object && object.genre) || 'all',
            status: (object && object.status) || 'all'
        };

        var currentPage = 1;
        var isLoading = false;
        var hasMore = true;
        var initialLoad = true;
        var tvCtrl = null;

        var filterGroups = [
            {
                key: 'order',
                label: 'Сортировка:',
                items: [
                    { id: 'popularity', title: '🔥 Популярное' },
                    { id: 'ranked', title: '⭐ Высокий рейтинг' },
                    { id: 'aired_on', title: '📅 Свежие новинки' },
                    { id: 'name', title: '🔤 По алфавиту' }
                ]
            },
            {
                key: 'score',
                label: 'Оценка:',
                items: [
                    { id: 'all', title: 'Любая' },
                    { id: '8', title: '★ 8+ (Шедевры)' },
                    { id: '7', title: '★ 7+ (Хорошие)' },
                    { id: '6', title: '★ 6+' }
                ]
            },
            {
                key: 'season',
                label: 'Год / Сезон:',
                items: [
                    { id: '2024_2026', title: '2024—2026' },
                    { id: '2026', title: '2026 год' },
                    { id: '2025', title: '2025 год' },
                    { id: '2024', title: '2024 год' },
                    { id: '2020_2023', title: '2020—2023' },
                    { id: '2010_2019', title: '2010—2019' },
                    { id: 'all', title: 'Все года' }
                ]
            },
            {
                key: 'genre',
                label: 'Жанр:',
                items: [
                    { id: 'all', title: 'Все жанры' },
                    { id: '1', title: 'Экшен' },
                    { id: '2', title: 'Приключения' },
                    { id: '4', title: 'Комедия' },
                    { id: '10', title: 'Фэнтези' },
                    { id: '24', title: 'Фантастика' },
                    { id: '8', title: 'Драма' },
                    { id: '22', title: 'Романтика' },
                    { id: '7', title: 'Детектив' },
                    { id: '41', title: 'Триллер' },
                    { id: '36', title: 'Повседневность' },
                    { id: '37', title: 'Сверхъестественное' },
                    { id: '27', title: 'Сёнен' },
                    { id: '42', title: 'Сэйнэн' },
                    { id: '30', title: 'Спорт' },
                    { id: '18', title: 'Меха' },
                    { id: '14', title: 'Ужасы' }
                ]
            },
            {
                key: 'status',
                label: 'Статус:',
                items: [
                    { id: 'all', title: 'Все' },
                    { id: 'ongoing', title: 'Онгоинги (выходят)' },
                    { id: 'released', title: 'Завершённые' },
                    { id: 'anons', title: 'Анонсы' }
                ]
            }
        ];

        var headerElem = $(`
            <div class="shiki-catalog-header" style="margin-bottom: 1.2em;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.8em; flex-wrap: wrap; gap: 0.8em;">
                    <div style="font-size: 1.5em; font-weight: bold; margin: 0; display: flex; align-items: center; gap: 0.5em; color: #fff;">
                        ${SHIKI_ICON} Каталог аниме с фильтрами
                    </div>
                    <div class="selector btn-shiki-search-shortcut" style="padding: 0.5em 1.2em; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; gap: 0.6em; color: #eee;">
                        <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                        <span>Поиск по названию</span>
                    </div>
                </div>
                <div class="shiki-catalog-filters" style="background: rgba(0,0,0,0.35); padding: 0.8em 1em; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); margin-bottom: 1.2em;"></div>
            </div>
        `);

        headerElem.find('.btn-shiki-search-shortcut').on('hover:enter', function () {
            if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                ShikiKeyboard.open({
                    title: 'Поиск аниме на Shikimori',
                    value: '',
                    onDone: function (q) {
                        if (q && q.trim()) {
                            Lampa.Activity.push({
                                component: 'shikimori_search',
                                title: 'Поиск: ' + q.trim(),
                                query: q.trim()
                            });
                        }
                    }
                });
                return;
            }
            Lampa.Activity.push({
                component: 'shikimori_search',
                title: 'Поиск аниме'
            });
        });

        var filtersContainer = headerElem.find('.shiki-catalog-filters');
        filtersContainer.css({ display: 'flex', flexWrap: 'wrap', gap: '0.5em' });

        filterGroups.forEach(function (group) {
            var chip = $('<div class="selector shiki-filter-chip"></div>');

            function currentItem() {
                for (var i = 0; i < group.items.length; i++) {
                    if (group.items[i].id === activeFilters[group.key]) return group.items[i];
                }
                return group.items[0];
            }

            function paintChip() {
                var picked = currentItem();
                chip.html(
                    '<span class="shiki-filter-chip__label">' + group.label + '</span>' +
                    '<span class="shiki-filter-chip__value">' + picked.title + '</span>'
                );
            }

            function applyFilter(value) {
                if (value === activeFilters[group.key]) return;
                activeFilters[group.key] = value;
                paintChip();
                currentPage = 1;
                hasMore = true;
                retryLoad = false;
                gridContainer.empty();
                // Drop the removed cards from the navigation collection right
                // away; otherwise the D-pad can move into detached posters while
                // the new page is still loading.
                if (window.Lampa && Lampa.Controller) {
                    Lampa.Controller.collectionSet(scroll.render(), false, true);
                    if (tvCtrl && tvCtrl.lastFocusElem && document.contains(tvCtrl.lastFocusElem)) {
                        tvCtrl.focus(tvCtrl.lastFocusElem);
                    }
                }
                loadPage(true);
            }

            chip.on('hover:enter', function () {
                // One chip per filter group opening Lampa's own selectbox: on a
                // remote that is a few presses instead of walking dozens of pills
                // across five rows.
                if (window.Lampa && Lampa.Select && Lampa.Select.show) {
                    var previous = enabledControllerName();
                    var items = group.items.map(function (item) {
                        return {
                            title: item.title,
                            value: item.id,
                            selected: item.id === activeFilters[group.key]
                        };
                    });

                    Lampa.Select.show({
                        title: group.label.replace(/:$/, ''),
                        items: items,
                        onSelect: function (element) {
                            restoreController(previous);
                            applyFilter(element.value);
                        },
                        onBack: function () {
                            restoreController(previous);
                        }
                    });
                    return;
                }

                // Old Lampa without selectbox: cycle through the values on OK.
                var items = group.items;
                var idx = 0;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].id === activeFilters[group.key]) idx = i;
                }
                applyFilter(items[(idx + 1) % items.length].id);
            });

            paintChip();
            filtersContainer.append(chip);
        });

        var gridContainer = $('<div class="category-full shiki-catalog-grid"></div>');
        var loadMoreBtn = $(`
            <div class="selector shiki-btn-load-more" style="width: 100%; box-sizing: border-box; padding: 0.9em 2em; text-align: center; background: rgba(46, 204, 113, 0.15); border: 1px solid rgba(46, 204, 113, 0.5); color: #2ecc71; font-weight: bold; border-radius: 8px; cursor: pointer; margin: 1.5em 0;">
                Загрузить ещё аниме
            </div>
        `);

        var retryLoad = false;

        loadMoreBtn.on('hover:enter', function () {
            if (isLoading || !hasMore) return;
            if (retryLoad) {
                retryLoad = false;
                loadPage(false, true);
                return;
            }
            currentPage++;
            loadPage(false, true);
        });

        container.append(headerElem);
        container.append(gridContainer);
        container.append(loadMoreBtn);

        function loadPage(reset, focusNew) {
            if (isLoading) return;
            isLoading = true;
            retryLoad = false;
            loadMoreBtn.text('Загрузка аниме...').css('opacity', '0.6');

            ShikiApi.getCatalog(activeFilters, currentPage, 30, function (results) {
                isLoading = false;
                loadMoreBtn.css('opacity', '1');

                if (!results || !results.length) {
                    hasMore = false;
                    loadMoreBtn.text('Все аниме загружены').hide();
                    if (currentPage === 1) {
                        gridContainer.html('<div style="grid-column: 1 / -1; text-align: center; padding: 3em; color: #e74c3c; font-size: 1.1em;">По выбранным фильтрам ничего не найдено. Попробуйте изменить параметры.</div>');
                    }
                    return;
                }

                if (results.length < 30) {
                    hasMore = false;
                    loadMoreBtn.hide();
                } else {
                    hasMore = true;
                    loadMoreBtn.text('Загрузить ещё аниме (Стр. ' + (currentPage + 1) + ')').show();
                }

                var batch = document.createDocumentFragment();
                var newCards = [];

                results.forEach(function (anime) {
                    var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
                    var title = anime.russian || anime.name;
                    var statusBadge = createStatusBadge(anime.id);
                    var year = anime.aired_on ? anime.aired_on.split('-')[0] : '';
                    var kindText = anime.kind === 'movie' ? 'Фильм' : (anime.kind === 'tv' ? 'Сериал' : (anime.kind ? anime.kind.toUpperCase() : 'Аниме'));

                    var card = $(`
                        <div class="card selector card--category shiki-card">
                            <div class="card__view">
                                <img src="${posterUrl}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${anime.episodes ? `<div class="shiki-badge">${anime.episodes} эп.</div>` : ''}
                                ${anime.score && parseFloat(anime.score) > 0 ? `<div class="shiki-score">★ ${anime.score}</div>` : ''}
                            </div>
                            <div class="card__title" title="${title}">
                                ${title}
                            </div>
                            <div class="card__age">
                                ${year ? year + ' • ' : ''}${kindText}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: title,
                            anime: anime
                        });
                    });

                    batch.appendChild(card[0]);
                    newCards.push(card[0]);
                });

                // One DOM insertion for the whole page instead of one reflow per card.
                gridContainer[0].appendChild(batch);

                if (window.Lampa && Lampa.Layer) {
                    Lampa.Layer.update(scroll.render());
                }

                // On a fresh page we rebuild the collection; on "load more" we
                // only append the new cards. collectionSet() clears the current
                // selection, which was exactly why the focus disappeared and
                // the D-pad jumped to the top/bottom after loading a page.
                var firstPage = initialLoad;
                initialLoad = false;
                if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                    if (reset || firstPage) {
                        Lampa.Controller.collectionSet(scroll.render(), false, true);
                        if (firstPage && tvCtrl) {
                            var firstCard = gridContainer.find('.selector').first();
                            if (firstCard.length) tvCtrl.focus(firstCard);
                        } else if (tvCtrl) {
                            // Filter reload: stay on the filter chip the user has
                            // just used instead of dropping the highlight.
                            var remembered = tvCtrl.lastFocusElem;
                            if (remembered && document.contains(remembered)) tvCtrl.focus(remembered);
                        }
                    } else if (Lampa.Controller.collectionAppend) {
                        Lampa.Controller.collectionAppend(newCards);
                        var focusedNow = document.querySelector('.selector.focus');
                        var buttonFocused = focusedNow && focusedNow === loadMoreBtn[0];
                        // Auto-load can happen while the "load more" button is
                        // focused; after appending, that button moves below the
                        // new rows and the highlight disappears off-screen.
                        if (tvCtrl && newCards.length && (focusNew || buttonFocused || !focusedNow)) {
                            tvCtrl.focus(newCards[0]);
                        }
                    } else {
                        Lampa.Controller.collectionSet(scroll.render(), false, true);
                    }
                }

            }, function (err) {
                isLoading = false;
                retryLoad = true;
                loadMoreBtn.text('Ошибка загрузки. Нажмите чтобы повторить').css('opacity', '1');
            });
        }

        scroll.onEnd = function () {
            if (isActive(self) && !isLoading && hasMore && !retryLoad) {
                currentPage++;
                loadPage(false, false);
            }
        };

        this.create = function () {
            loadPage(true);
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        this.destroy = function () {
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self);
        };
    }

    /**
     * Standalone Shikimori Search Component
     */
    function ShikimoriSearchComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var container = $('<div class="shiki-search-page" style="padding: 1.5em 2em 3em 2em;"></div>');
        scroll.body().append(container);

        var query = (object && object.query) || '';
        var tvCtrl = null;

        var searchBar = $(`
            <div style="margin-bottom: 2em;">
                <div class="selector shiki-hub-search-btn" style="height: 52px; box-sizing: border-box; display: flex; align-items: center; gap: 0.9em; padding: 0 1.4em; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; cursor: pointer;">
                    <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="#2ecc71"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                    <span class="shiki-search-label" style="color: #eee; font-size: 1.05em; font-weight: 500;">${query ? ('Поиск: «' + query + '» (нажмите для изменения)') : 'Нажмите для ввода названия аниме с пульта...'}</span>
                </div>
                <div class="shiki-search-grid-box" style="margin-top: 1.5em;"></div>
            </div>
        `);
        container.append(searchBar);

        searchBar.find('.shiki-hub-search-btn').on('hover:enter', function () {
            if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                ShikiKeyboard.open({
                    title: 'Поиск аниме на Shikimori',
                    value: query || '',
                    onDone: function (newQ) {
                        if (newQ && newQ.trim()) {
                            query = newQ.trim();
                            searchBar.find('.shiki-search-label').text('Поиск: «' + query + '» (нажмите для изменения)');
                            doSearch();
                        }
                    }
                });
                return;
            }

            if (window.Lampa && Lampa.Input) {
                Lampa.Input.edit({
                    title: 'Поиск аниме на Shikimori',
                    value: query || '',
                    free: true,
                    nosave: true,
                    nomic: true
                }, function (newQ) {
                    if (newQ && newQ.trim()) {
                        query = newQ.trim();
                        searchBar.find('.shiki-search-label').text('Поиск: «' + query + '» (нажмите для изменения)');
                        doSearch();
                    }
                });
            }
        });

        function doSearch() {
            var gridBox = searchBar.find('.shiki-search-grid-box');
            gridBox.html('<div style="text-align: center; padding: 2em; color: #aaa;">Поиск на Shikimori...</div>');

            ShikiApi.searchAnime(query, 50, function (results) {
                gridBox.empty();
                if (!results || !results.length) {
                    gridBox.html('<div style="color: #e74c3c; text-align: center; padding: 2em; font-size: 1.1em;">По запросу «' + query + '» ничего не найдено на Shikimori</div>');
                    return;
                }

                var grid = $('<div class="category-full shiki-catalog-grid"></div>');
                var batch = document.createDocumentFragment();
                results.forEach(function (anime) {
                    var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
                    var title = anime.russian || anime.name;
                    var statusBadge = createStatusBadge(anime.id);
                    var year = anime.aired_on ? anime.aired_on.split('-')[0] : '';
                    var kindText = anime.kind === 'movie' ? 'Фильм' : (anime.kind === 'tv' ? 'Сериал' : (anime.kind ? anime.kind.toUpperCase() : 'Аниме'));

                    var card = $(`
                        <div class="card selector card--category shiki-card">
                            <div class="card__view">
                                <img src="${posterUrl}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${anime.episodes ? `<div class="shiki-badge">${anime.episodes} эп.</div>` : ''}
                                ${anime.score && parseFloat(anime.score) > 0 ? `<div class="shiki-score">★ ${anime.score}</div>` : ''}
                            </div>
                            <div class="card__title" title="${title}">
                                ${title}
                            </div>
                            <div class="card__age">
                                ${year ? year + ' • ' : ''}${kindText}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: title,
                            anime: anime
                        });
                    });

                    batch.appendChild(card[0]);
                });
                grid[0].appendChild(batch);

                gridBox.append(grid);

                if (window.Lampa && Lampa.Layer) {
                    Lampa.Layer.update(scroll.render());
                }

                if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                    Lampa.Controller.collectionSet(scroll.render(), false, true);
                    var firstCard = grid.find('.selector').first();
                    if (firstCard.length && tvCtrl) tvCtrl.focus(firstCard);
                }
            }, function (err) {
                gridBox.html('<div style="color: #e74c3c; text-align: center; padding: 2em;">Ошибка поиска: ' + err + '</div>');
            });
        }

        this.create = function () {
            if (query) {
                doSearch();
            } else {
                setTimeout(function () {
                    // Do not open the keyboard over whatever the user moved on to.
                    if (!isActive(self)) return;
                    searchBar.find('.shiki-hub-search-btn').trigger('hover:enter');
                }, 300);
            }
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        this.destroy = function () {
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self);
            var searchBtn = searchBar.find('.shiki-hub-search-btn');
            if (searchBtn.length && !query && tvCtrl) {
                tvCtrl.focus(searchBtn);
            }
        };
    }

    /**
     * Shikimori Hub Component
     */
    function ShikimoriHubComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var container = $('<div class="shiki-hub-container" style="padding: 1.5em 2.5em 6em 2.5em;"></div>');
        scroll.body().append(container);

        var lastSearchQuery = '';
        var initialRender = true;
        var tvCtrl = null;

        var searchWrapper = $(`
            <div class="shiki-search-wrapper" style="margin-bottom: 2em;">
                <div style="display: flex; gap: 1em; align-items: center; flex-wrap: wrap;">
                    <div class="selector shiki-hub-search-btn" style="flex: 1; min-width: 260px; height: 50px; box-sizing: border-box; display: flex; align-items: center; gap: 0.9em; padding: 0 1.3em; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; cursor: pointer;">
                        <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="#2ecc71"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 14z"/></svg>
                        <span class="shiki-hub-search-text" style="color: #eee; font-size: 1.05em; font-weight: 500;">Поиск аниме по названию...</span>
                    </div>
                    <div class="selector shiki-hub-catalog-btn" style="height: 50px; box-sizing: border-box; display: flex; align-items: center; gap: 0.6em; padding: 0 1.5em; background: #27ae60; color: #fff; font-weight: bold; border-radius: 8px; cursor: pointer;">
                        <svg class="shiki-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z"/></svg>
                        <span>Каталог с фильтрами</span>
                    </div>
                </div>
                <div class="shiki-search-results-area" style="display: none; margin-top: 1.5em;"></div>
            </div>
        `);
        var contentWrapper = $('<div class="shiki-content-wrapper"></div>');

        container.append(searchWrapper);
        container.append(contentWrapper);

        searchWrapper.find('.shiki-hub-catalog-btn').on('hover:enter', function () {
            Lampa.Activity.push({
                component: 'shikimori_catalog',
                title: 'Каталог аниме'
            });
        });

        searchWrapper.find('.shiki-hub-search-btn').on('hover:enter', function () {
            if (typeof ShikiKeyboard !== 'undefined' && ShikiKeyboard.open) {
                ShikiKeyboard.open({
                    title: 'Поиск аниме на Shikimori',
                    value: lastSearchQuery || '',
                    onDone: function (query) {
                        if (query && query.trim()) {
                            executeHubSearch(query.trim());
                        }
                    }
                });
                return;
            }

            if (window.Lampa && Lampa.Input) {
                Lampa.Input.edit({
                    title: 'Поиск аниме на Shikimori',
                    value: lastSearchQuery || '',
                    free: true,
                    nosave: true,
                    nomic: true
                }, function (query) {
                    if (query && query.trim()) {
                        executeHubSearch(query.trim());
                    }
                });
            }
        });

        function executeHubSearch(query) {
            lastSearchQuery = query;
            var resultsArea = searchWrapper.find('.shiki-search-results-area');
            resultsArea.show().html('<div style="color: #aaa; padding: 1.5em 0; text-align: center;">Поиск «' + query + '» в Shikimori...</div>');

            ShikiApi.searchAnime(query, 30, function (results) {
                resultsArea.empty();

                if (!results || !results.length) {
                    resultsArea.html(`
                        <div style="padding: 1em 0; display: flex; justify-content: space-between; align-items: center;">
                            <div style="color: #e74c3c;">По запросу «${query}» ничего не найдено на Shikimori</div>
                            <div class="selector shiki-btn-close-search" style="padding: 0.4em 0.8em; background: rgba(255,255,255,0.1); border-radius: 6px; cursor: pointer; font-size: 0.85em;">✖ Закрыть поиск</div>
                        </div>
                    `);
                    resultsArea.find('.shiki-btn-close-search').on('hover:enter', function () {
                        resultsArea.empty().hide();
                        if (tvCtrl) tvCtrl.focus(searchWrapper.find('.shiki-hub-search-btn'));
                    });
                    if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                        Lampa.Controller.collectionSet(scroll.render(), false, true);
                        tvCtrl && tvCtrl.focus(resultsArea.find('.shiki-btn-close-search').first());
                    }
                    return;
                }

                var searchHeader = $(`
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1em;">
                        <h2 style="font-size: 1.3em; font-weight: bold; margin: 0; color: #fff;">
                            Результаты поиска: «${query}» <span style="font-size: 0.8em; color: #888; font-weight: normal;">(${results.length})</span>
                        </h2>
                        <div class="selector shiki-btn-close-search" style="padding: 0.4em 0.9em; background: rgba(255,255,255,0.12); border-radius: 6px; cursor: pointer; font-size: 0.85em; font-weight: bold; color: #e74c3c;">
                            ✖ Сбросить поиск
                        </div>
                    </div>
                `);

                searchHeader.find('.shiki-btn-close-search').on('hover:enter', function () {
                    resultsArea.empty().hide();
                    if (tvCtrl) tvCtrl.focus(searchWrapper.find('.shiki-hub-search-btn'));
                });

                var cardsContainer = $('<div class="shiki-hub-cards" style="display: flex; gap: 1em; overflow-x: auto; padding-bottom: 1em; scrollbar-width: thin;"></div>');

                results.forEach(function (anime) {
                    var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
                    var title = anime.russian || anime.name;
                    var statusBadge = createStatusBadge(anime.id);

                    var year = anime.aired_on ? anime.aired_on.split('-')[0] : '';
                    var kindText = anime.kind === 'movie' ? 'Фильм' : (anime.kind === 'tv' ? 'Сериал' : (anime.kind ? anime.kind.toUpperCase() : 'Аниме'));

                    var card = $(`
                        <div class="card selector shiki-card">
                            <div class="card__view">
                                <img src="${posterUrl}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${anime.episodes ? `<div class="shiki-badge">${anime.episodes} эп.</div>` : ''}
                                ${anime.score && parseFloat(anime.score) > 0 ? `<div class="shiki-score">★ ${anime.score}</div>` : ''}
                            </div>
                            <div class="card__title" title="${title}">
                                ${title}
                            </div>
                            <div class="card__age">
                                ${year ? year + ' • ' : ''}${kindText}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: title,
                            anime: anime
                        });
                    });

                    if (tvCtrl) tvCtrl.attachToItem(card);
                    cardsContainer.append(card);
                });

                resultsArea.append(searchHeader);
                resultsArea.append(cardsContainer);

                if (window.Lampa && Lampa.Layer) {
                    Lampa.Layer.update(scroll.render());
                }

                if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                    Lampa.Controller.collectionSet(scroll.render(), false, true);
                    var firstSearchCard = resultsArea.find('.selector.shiki-card').first();
                    if (firstSearchCard.length && tvCtrl) {
                        tvCtrl.focus(firstSearchCard);
                    }
                }
            }, function (err) {
                resultsArea.html('<div style="color: #e74c3c; padding: 1em 0;">Ошибка поиска: ' + (err || 'сеть недоступна') + '</div>');
            });
        }

        this.create = function () {
            if (object.activity && object.activity.loader) object.activity.loader(true);
            loadCategories();
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        var refreshTimer = null;
        var onProgressUpdated = function () {
            // The hub is often buried under the view or the player when progress
            // changes. Reloading it there used to re-collect the global Navigator
            // collection of a hidden page and broke the D-pad on the visible one.
            if (!isActive(self)) return;
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(function () {
                if (isActive(self)) loadCategories();
            }, 600);
        };
        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('shikimori_progress_updated', onProgressUpdated);
        }

        this.destroy = function () {
            clearTimeout(refreshTimer);
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.remove('shikimori_progress_updated', onProgressUpdated);
            }
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self);
        };

        function loadDiscoveryRows(callback) {
            if (discoveryCache.rows && Date.now() - discoveryCache.at < DISCOVERY_TTL) {
                callback(discoveryCache.rows);
                return;
            }

            var discoveryDefs = [
                { title: '🔥 Популярные новинки (2024—2026)', filters: { order: 'popularity', season: '2024_2026' } },
                { title: '⭐ Лучшее аниме (Рейтинг 8+)', filters: { order: 'ranked', score: 8 } },
                { title: '📺 Популярные онгоинги', filters: { order: 'popularity', status: 'ongoing' } }
            ];

            var rows = new Array(discoveryDefs.length);
            var remaining = discoveryDefs.length;

            function done() {
                var result = rows.filter(Boolean);
                discoveryCache = { at: Date.now(), rows: result };
                callback(result);
            }

            discoveryDefs.forEach(function (def, defIndex) {
                ShikiApi.getCatalog(def.filters, 1, 12, function (list) {
                    if (Array.isArray(list) && list.length) {
                        var items = list.map(function (a) {
                            return {
                                id: a.id,
                                title: a.russian || a.name,
                                original_title: a.name,
                                poster_path: ShikiApi.fixImageUrl(a.image ? (a.image.original || a.image.preview) : ''),
                                vote_average: a.score,
                                episodes_total: a.episodes,
                                episodes_watched: 0,
                                anime_raw: a
                            };
                        });
                        rows[defIndex] = {
                            title: def.title,
                            id: 'discovery_' + def.filters.order + '_' + defIndex,
                            items: items
                        };
                    }
                    remaining--;
                    if (remaining <= 0) done();
                }, function () {
                    remaining--;
                    if (remaining <= 0) done();
                });
            });
        }

        function loadCategories() {
            var userRows = [];

            function finish(allRows) {
                if (ShikiApi.getLocalHistory) {
                    var localHist = ShikiApi.getLocalHistory();
                    if (localHist && localHist.length) {
                        var histItems = localHist.map(function (item) {
                            return {
                                id: item.id,
                                title: item.title,
                                original_title: item.name,
                                poster_path: ShikiApi.fixImageUrl(item.poster_path || (item.image ? (item.image.original || item.image.preview) : '')),
                                vote_average: item.vote_average,
                                episodes_total: item.episodes_total,
                                episodes_watched: item.lastEpisode,
                                anime_raw: item
                            };
                        });
                        allRows.unshift({
                            title: '🕒 История просмотров',
                            id: 'local_history',
                            items: histItems
                        });
                    }
                }

                if (object.activity && object.activity.loader) object.activity.loader(false);
                renderRows(allRows);
            }

            if (!ShikiApi.isAuthorized()) {
                loadDiscoveryRows(function (discRows) {
                    finish(discRows);
                });
                return;
            }

            var categories = [
                { id: 'watching', title: 'Смотрю' },
                { id: 'planned', title: 'В планах' },
                { id: 'rewatching', title: 'Пересматриваю' },
                { id: 'completed', title: 'Просмотрено' },
                { id: 'on_hold', title: 'Отложено' }
            ];

            var pending = categories.length;

            categories.forEach(function (cat) {
                ShikiApi.getUserRates(cat.id, 1, 15, function (rates) {
                    var items = [];
                    if (Array.isArray(rates)) {
                        rates.forEach(function (r) {
                            if (r.anime) {
                                items.push({
                                    id: r.anime.id,
                                    title: r.anime.russian || r.anime.name,
                                    original_title: r.anime.name,
                                    poster_path: ShikiApi.fixImageUrl(r.anime.image ? (r.anime.image.original || r.anime.image.preview) : ''),
                                    vote_average: r.anime.score,
                                    episodes_total: r.anime.episodes,
                                    episodes_watched: r.episodes,
                                    rate_id: r.id,
                                    rate_status: r.status,
                                    anime_raw: r.anime
                                });
                            }
                        });
                    }

                    if (items.length) {
                        userRows.push({
                            title: cat.title,
                            id: cat.id,
                            items: items
                        });
                    }

                    pending--;
                    if (pending <= 0) {
                        loadDiscoveryRows(function (discRows) {
                            finish(userRows.concat(discRows));
                        });
                    }
                }, function () {
                    pending--;
                    if (pending <= 0) {
                        loadDiscoveryRows(function (discRows) {
                            finish(userRows.concat(discRows));
                        });
                    }
                });
            });
        }

        function renderRows(rows) {
            contentWrapper.empty();

            if (!ShikiApi.isAuthorized()) {
                showAuthPrompt();
            }

            if (!rows.length) {
                if (ShikiApi.isAuthorized()) {
                    contentWrapper.append('<div style="text-align: center; padding: 3em; color: #aaa;">Ваши списки на Shikimori пусты</div>');
                }
                return;
            }

            var rowsFragment = document.createDocumentFragment();

            rows.forEach(function (rowObj) {
                var rowElem = $(`
                    <div class="shiki-hub-row" style="margin-bottom: 2em;">
                        <h2 style="font-size: 1.3em; font-weight: bold; margin-bottom: 0.8em; display: flex; align-items: center; gap: 0.5em; color: #fff;">
                            ${rowObj.title} <span style="font-size: 0.8em; color: #888; font-weight: normal;">(${rowObj.items.length})</span>
                        </h2>
                        <div class="shiki-hub-cards"></div>
                    </div>
                `);

                var cardsContainer = rowElem.find('.shiki-hub-cards');

                rowObj.items.forEach(function (item) {
                    var statusBadge = createStatusBadge(item.id);
                    var epCount = item.episodes_watched ? (item.episodes_watched + ' / ' + (item.episodes_total || '?') + ' эп.') : (item.episodes_total ? (item.episodes_total + ' эп.') : '');
                    var card = $(`
                        <div class="card selector shiki-card">
                            <div class="card__view">
                                <img src="${item.poster_path}" class="card__img" loading="lazy" decoding="async" />
                                ${statusBadge}
                                ${item.episodes_watched ? `<div class="shiki-badge">${item.episodes_watched} / ${item.episodes_total || '?'}</div>` : (item.episodes_total ? `<div class="shiki-badge">${item.episodes_total} эп.</div>` : '')}
                                ${item.vote_average && parseFloat(item.vote_average) > 0 ? `<div class="shiki-score">★ ${item.vote_average}</div>` : ''}
                            </div>
                            <div class="card__title" title="${item.title}">
                                ${item.title}
                            </div>
                            <div class="card__age">
                                ${epCount}
                            </div>
                        </div>
                    `);

                    card.on('hover:enter', function () {
                        Lampa.Activity.push({
                            component: 'shikimori_view',
                            title: item.title,
                            anime: item.anime_raw,
                            rateId: item.rate_id,
                            episodesWatched: item.episodes_watched
                        });
                    });

                    if (tvCtrl) tvCtrl.attachToItem(card);
                    cardsContainer.append(card);
                });

                rowsFragment.appendChild(rowElem[0]);
            });

            // Single insertion for all rows: avoids a reflow per row.
            contentWrapper[0].appendChild(rowsFragment);

            if (window.Lampa && Lampa.Layer) {
                Lampa.Layer.update(scroll.render());
            }

            // Keep the current card focused when the rows are rebuilt (progress
            // sync, returning from an activity); only pick the first card when
            // nothing inside the hub is focused yet.
            var firstRender = initialRender;
            initialRender = false;
            if (navigationAllowed(self) && window.Lampa && Lampa.Controller) {
                Lampa.Controller.collectionSet(scroll.render(), false, true);
                if (firstRender || !scroll.render().find('.selector.focus').length) {
                    var firstElem = contentWrapper.find('.card').first();
                    if (!firstElem.length) firstElem = contentWrapper.find('.selector').first();
                    if (!firstElem.length) firstElem = searchWrapper.find('.selector').first();
                    if (firstElem.length && tvCtrl) {
                        tvCtrl.focus(firstElem);
                    }
                }
            }
        }

        function showAuthPrompt() {
            var html = $(`
                <div class="shiki-hub-auth-prompt" style="padding: 0.9em 1.4em; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.04); border-radius: 8px; margin-bottom: 1.5em; border: 1px dashed rgba(255,255,255,0.18); flex-wrap: wrap; gap: 0.8em;">
                    <div>
                        <div style="font-size: 1.1em; font-weight: bold; color: #fff;">Вход в аккаунт Shikimori</div>
                        <div style="color: #aaa; font-size: 0.85em; margin-top: 0.1em;">Синхронизация списков «Смотрю», «В планах» и авто-запись серий</div>
                    </div>
                    <div class="selector btn-shiki-login" style="padding: 0.55em 1.4em; background: #2ecc71; color: #fff; font-weight: bold; border-radius: 6px; cursor: pointer; font-size: 0.9em;">
                        Войти в аккаунт
                    </div>
                </div>
            `);

            html.find('.btn-shiki-login').on('hover:enter', function () {
                ShikiSettings.openAuthModal();
            });

            if (tvCtrl) tvCtrl.attachToItem(html.find('.btn-shiki-login'));
            contentWrapper.prepend(html);
        }
    }

    /**
     * Anime View Component
     */
    function ShikimoriViewComponent(object) {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: false, over: true, step: 250 });
        scroll.minus();
        scroll.render().css({
            height: 'calc(100vh - 4.5em)',
            maxHeight: 'calc(100vh - 4.5em)',
            overflow: 'hidden'
        });
        var anime = object.anime || {};
        var translations = [];
        var activeTranslation = 0;
        var activeSeason = 1;
        var episodesWatched = object.episodesWatched || 0;
        var rateId = object.rateId || null;
        var tvCtrl = null;

        var view = $(`
            <div class="shikimori-view" style="padding: 1.5em 2.5em 8em 2.5em;">
                <div class="shikimori-view__header selector" style="display: flex; gap: 1.5em; margin-bottom: 1.5em;">
                    <img class="shikimori-view__poster" style="width: 150px; height: 220px; border-radius: 8px; object-fit: cover; box-shadow: 0 4px 14px rgba(0,0,0,0.6);" />
                    <div class="shikimori-view__info" style="flex: 1;">
                        <h2 class="shikimori-view__title" style="margin: 0 0 0.2em 0; font-size: 1.8em; color: #fff;"></h2>
                        <div class="shikimori-view__subtitle" style="color: #aaa; margin-bottom: 0.5em; font-size: 1em;"></div>
                        <div class="shikimori-view__user-status" style="margin-bottom: 0.5em;"></div>
                        <div class="shikimori-view__meta" style="color: #2ecc71; font-weight: bold; margin-bottom: 0.8em;"></div>
                        <div class="shikimori-view__desc" style="color: #ddd; font-size: 0.9em; line-height: 1.4; max-height: 5em; overflow: hidden;"></div>
                    </div>
                </div>

                <div style="font-weight: bold; margin-bottom: 0.5em; color: #aaa;">Озвучка:</div>
                <div class="shikimori-view__voices shiki-filter-row" style="margin-bottom: 1.2em;"></div>

                <div class="shikimori-view__seasons" style="display: none;"></div>

                <h3 style="margin: 1em 0 0.6em 0; color: #fff;">Серии:</h3>
                <div class="shikimori-view__episodes" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0.7em;"></div>
            </div>
        `);

        scroll.body().append(view);

        this.create = function () {
            if (self.activity && self.activity.loader) self.activity.loader(true);
            else if (object.activity && object.activity.loader) object.activity.loader(true);
            setupHeader();

            if (!anime.description && anime.id) {
                ShikiApi.getAnime(anime.id, function (fullData) {
                    if (fullData) {
                        anime.description = fullData.description || anime.description;
                        anime.score = fullData.score || anime.score;
                        anime.episodes = fullData.episodes || anime.episodes;
                        setupHeader();
                    }
                });
            }

            loadAnimeStreams();
            return this.render();
        };

        this.render = function (js) {
            return scroll.render(js);
        };

        var onProgressUpdated = function (e) {
            if (e && String(e.animeId) === String(anime.id) && isActive(self)) {
                setupHeader();
                renderEpisodes();
            }
        };
        var onActivityEvent = function (e) {
            if (e && e.type === 'active' && isActive(self)) {
                setupHeader();
                renderEpisodes();
            }
        };
        if (window.Lampa && Lampa.Listener) {
            Lampa.Listener.follow('shikimori_progress_updated', onProgressUpdated);
            Lampa.Listener.follow('activity', onActivityEvent);
        }

        this.destroy = function () {
            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.remove('shikimori_progress_updated', onProgressUpdated);
                Lampa.Listener.remove('activity', onActivityEvent);
            }
            scroll.destroy();
        };

        this.start = function () {
            tvCtrl = setupTvController(scroll, self, {
                onUp: function () {
                    var root = scroll.render()[0];
                    var body = root.querySelector('.scroll__body');
                    var header = view.find('.shikimori-view__header')[0];
                    var rootTop = root.getBoundingClientRect().top;
                    var bodyTop = body ? body.getBoundingClientRect().top : rootTop;

                    // At the topmost focusable row (voices/seasons): first scroll
                    // the poster back into view, and only the next Up goes to the
                    // fixed top bar. Without this the poster stayed off-screen.
                    if (header && bodyTop < rootTop - 10) {
                        scroll.update(header);
                    } else {
                        Lampa.Controller.toggle('head');
                    }
                }
            });
        };

        function setupHeader() {
            view.find('.shikimori-view__title').text(anime.russian || anime.name);
            view.find('.shikimori-view__subtitle').text(anime.name + (anime.aired_on ? ' • ' + anime.aired_on.split('-')[0] : ''));
            view.find('.shikimori-view__meta').text('★ ' + (anime.score || '-') + ' • Всего серий: ' + (anime.episodes || anime.episodes_aired || '?'));
            
            var rawDesc = anime.description || '';
            var cleanDesc = rawDesc
                .replace(/\[\/?(character|anime|manga|person|b|i|u|s|url|quote|spoiler)[^\]]*\]/gi, '')
                .replace(/\r\n|\r|\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            view.find('.shikimori-view__desc').text(cleanDesc);

            var userRate = ShikiApi.getUserRate(anime.id);
            var statusBox = view.find('.shikimori-view__user-status');
            statusBox.empty();

            if (userRate && userRate.status) {
                var statusNames = {
                    completed: '✓ Просмотрено',
                    watching: '▶ Смотрю',
                    planned: '⏱ В планах',
                    on_hold: '⏸ Отложено',
                    rewatching: '🔄 Пересматриваю',
                    dropped: '✖ Брошено'
                };
                var sName = statusNames[userRate.status] || userRate.status;
                var epInfo = (userRate.episodes !== undefined && userRate.episodes !== null) ? (' • Просмотрено: ' + userRate.episodes + ' из ' + (anime.episodes || anime.episodes_aired || '?') + ' сер.') : '';
                var scInfo = userRate.score ? (' • Ваша оценка: ★ ' + userRate.score + '/10') : '';
                statusBox.html(`
                    <div class="shiki-status-badge shiki-status--${userRate.status}" style="position: static; display: inline-block; font-size: 0.85em; padding: 0.35em 0.8em; margin-bottom: 0.4em;">
                        ${sName}${epInfo}${scInfo}
                    </div>
                `);
            } else if (ShikiApi.getLocalWatchedEpisodes) {
                var localEps = ShikiApi.getLocalWatchedEpisodes(anime.id);
                if (localEps && localEps.length > 0) {
                    var lastEp = localEps[localEps.length - 1];
                    var isAll = anime.episodes && localEps.length >= anime.episodes;
                    var label = isAll ? '✓ Просмотрено полностью' : ('▶ Смотрю • Просмотрено серий: ' + localEps.length + ' из ' + (anime.episodes || '?') + ' (последняя: ' + lastEp + ')');
                    statusBox.html(`
                        <div class="shiki-status-badge shiki-status--${isAll ? 'completed' : 'watching'}" style="position: static; display: inline-block; font-size: 0.85em; padding: 0.35em 0.8em; margin-bottom: 0.4em;">
                            ${label}
                        </div>
                    `);
                }
            }

            var posterUrl = ShikiApi.fixImageUrl(anime.image ? (anime.image.original || anime.image.preview) : '');
            view.find('.shikimori-view__poster').attr('src', posterUrl);
        }

        function loadAnimeStreams() {
            var allTrans = [];

            function onTranslationsLoaded() {
                translations = allTrans;
                renderVoicesAndEpisodes();
            }

            function searchByTitleFallback() {
                var title = anime.russian || anime.name;
                if (!title) {
                    tryAniLibriaFallback();
                    return;
                }
                KodikBalancer.searchByTitle(title, function (titleResults) {
                    if (titleResults && titleResults.length) {
                        allTrans = titleResults;
                        onTranslationsLoaded();
                    } else {
                        tryAniLibriaFallback();
                    }
                }, function () {
                    tryAniLibriaFallback();
                });
            }

            function tryAniLibriaFallback() {
                var title = anime.russian || anime.name;
                if (!title) {
                    showStreamError();
                    return;
                }
                AniLibriaBalancer.search(title, function (anilibriaResults) {
                    if (anilibriaResults && anilibriaResults.length) {
                        allTrans = anilibriaResults;
                        onTranslationsLoaded();
                    } else {
                        showStreamError();
                    }
                }, function () {
                    showStreamError();
                });
            }

            function showStreamError() {
                if (self.activity && self.activity.loader) self.activity.loader(false);
                else if (object.activity && object.activity.loader) object.activity.loader(false);
                view.find('.shikimori-view__episodes').html('<div style="color: #e74c3c; padding: 1em;">Не удалось найти видеопотоки для этого тайтла.</div>');
            }

            if (anime.id) {
                KodikBalancer.searchByShikimoriId(anime.id, function (kodikResults) {
                    if (kodikResults && kodikResults.length) {
                        allTrans = kodikResults;
                        onTranslationsLoaded();
                    } else {
                        searchByTitleFallback();
                    }
                }, function () {
                    searchByTitleFallback();
                });
            } else {
                searchByTitleFallback();
            }
        }

        function seasonKeys(trans) {
            var seasons = (trans && trans.seasons) || {};
            var keys = Object.keys(seasons);
            keys.sort(function (a, b) {
                return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
            });
            return keys;
        }

        function renderSeasons() {
            var container = view.find('.shikimori-view__seasons');
            container.empty();

            var currentTrans = translations[activeTranslation];
            var keys = seasonKeys(currentTrans);

            if (keys.length <= 1) {
                if (keys.length === 1) activeSeason = parseInt(keys[0], 10) || 1;
                container.hide();
                return;
            }

            if (keys.indexOf(String(activeSeason)) === -1) {
                activeSeason = parseInt(keys[0], 10) || 1;
            }

            container.show();

            keys.forEach(function (key) {
                var num = parseInt(key, 10) || 1;
                var btn = $('<div class="shiki-pill selector' + (num === activeSeason ? ' active' : '') + '">Сезон ' + num + '</div>');

                btn.on('hover:enter', function () {
                    if (num === activeSeason) return;
                    activeSeason = num;
                    container.find('.shiki-pill').removeClass('active');
                    btn.addClass('active');
                    // Stay on the season pill; only the episode grid changes.
                    renderEpisodes({ focus: false });
                });

                container.append(btn);
            });
        }

        function renderVoicesAndEpisodes() {
            if (self.activity && self.activity.loader) self.activity.loader(false);
            else if (object.activity && object.activity.loader) object.activity.loader(false);

            var voicesContainer = view.find('.shikimori-view__voices');
            voicesContainer.empty();

            if (!translations.length) {
                view.find('.shikimori-view__episodes').html('<div style="color: #e74c3c; padding: 1em;">Видео не найдено.</div>');
                return;
            }

            var prefVoice = Lampa.Storage.get('shikimori_preferred_voice', '');
            if (prefVoice) {
                translations.forEach(function (t, idx) {
                    if (t.title.toLowerCase().indexOf(prefVoice.toLowerCase()) >= 0) {
                        activeTranslation = idx;
                    }
                });
            }

            translations.forEach(function (trans, idx) {
                var btn = $('<div class="shiki-pill selector' + (idx === activeTranslation ? ' active' : '') + '">' + trans.title + ' (' + (trans.quality || '1080p') + ')</div>');
                btn.on('hover:enter', function () {
                    activeTranslation = idx;
                    voicesContainer.find('.shiki-pill').removeClass('active');
                    btn.addClass('active');
                    // Keep the focus on the voice pill the user just pressed:
                    // moving it down to the episode list on every change is what
                    // made the row impossible to browse with the remote.
                    renderSeasons();
                    renderEpisodes({ focus: false });
                });
                voicesContainer.append(btn);
            });

            renderSeasons();
            // Keep the initial focus on the header/poster instead of jumping to
            // the next episode, which scrolled the poster out of view on long
            // series (26+ episodes).
            renderEpisodes({ focus: false });
        }

        function renderEpisodes(options) {
            options = options || {};
            var episodesContainer = view.find('.shikimori-view__episodes');
            var focusedCard = episodesContainer.find('.shiki-ep-card.focus').first();
            var focusedEpisode = focusedCard.length ? focusedCard.attr('data-episode') : null;
            var hadOtherFocus = focusedEpisode === null && scroll.render().find('.selector.focus').length > 0;
            var focusToKeep = document.querySelector('.selector.focus');

            episodesContainer.empty();

            var currentTrans = translations[activeTranslation];
            if (!currentTrans || !currentTrans.seasons) {
                episodesContainer.html('<div>Нет серий в этой озвучке</div>');
                return;
            }

            var seasonObj = currentTrans.seasons[activeSeason] || currentTrans.seasons['1'] || Object.values(currentTrans.seasons)[0];
            if (!seasonObj || !seasonObj.episodes) {
                episodesContainer.html('<div>Нет серий</div>');
                return;
            }

            var episodes = seasonObj.episodes;
            var localWatchedEps = (ShikiApi.getLocalWatchedEpisodes && ShikiApi.getLocalWatchedEpisodes(anime.id)) || [];
            var maxWatched = episodesWatched || 0;
            if (localWatchedEps.length > 0) {
                var maxLocal = Math.max.apply(Math, localWatchedEps);
                maxWatched = Math.max(maxWatched, maxLocal);
            }
            var firstEpNum = episodes.length ? episodes[0].episode : 1;
            var nextEpisodeNum = maxWatched >= firstEpNum ? (maxWatched + 1) : firstEpNum;

            var episodeFragment = document.createDocumentFragment();

            episodes.forEach(function (ep) {
                var isWatched = (ep.episode <= maxWatched && maxWatched >= firstEpNum) || (localWatchedEps.indexOf(ep.episode) !== -1);
                var isNext = (ep.episode === nextEpisodeNum) && !isWatched;

                var epCard = $(`
                    <div class="selector shiki-ep-card" data-episode="${ep.episode}" style="padding: 0.8em; text-align: center; border-radius: 6px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); cursor: pointer;">
                        <div style="font-weight: bold; font-size: 1.1em; margin-bottom: 0.2em;">Серия ${ep.episode}</div>
                        <div class="shiki-ep-status" style="font-size: 0.8em; color: ${isWatched ? '#2ecc71' : (isNext ? '#e74c3c' : '#aaa')};">
                            ${isWatched ? '✓ Просмотрено' : (isNext ? '▶ Смотреть' : 'Не просмотрено')}
                        </div>
                    </div>
                `);

                if (isWatched) epCard.addClass('shiki-ep-watched');
                if (isNext) epCard.addClass('shiki-ep-next');

                epCard.on('hover:enter', function () {
                    playEpisode(ep, currentTrans);
                });

                episodeFragment.appendChild(epCard[0]);
            });

            episodesContainer[0].appendChild(episodeFragment);

            if (window.Lampa && Lampa.Layer) {
                Lampa.Layer.update(scroll.render());
            }

            if (!navigationAllowed(self) || !window.Lampa || !Lampa.Controller) return;

            Lampa.Controller.collectionSet(scroll.render(), false, true);

            if (options.focus === false) {
                // collectionSet() clears the focus class; restore the pill/header
                // the user was on (voice/season change must not drop the highlight).
                if (focusToKeep && document.contains(focusToKeep) && tvCtrl) {
                    tvCtrl.focus(focusToKeep);
                }
                return;
            }

            // Something else on the page is focused (a voice pill, the header):
            // a late async render must not pull the selection away from it.
            if (hadOtherFocus) return;

            // Re-rendering episodes (voice change, progress sync, coming back
            // from the player) used to throw the focus to the next episode. Keep
            // the same episode selected when it still exists.
            var toFocus = null;
            if (focusedEpisode !== null) {
                toFocus = episodesContainer.find('.shiki-ep-card[data-episode="' + focusedEpisode + '"]').first();
            }
            if (!toFocus || !toFocus.length) {
                toFocus = episodesContainer.find('.shiki-ep-next').first();
            }
            if (!toFocus.length) {
                toFocus = episodesContainer.find('.shiki-ep-card').first();
            }
            if (toFocus.length && tvCtrl) {
                tvCtrl.focus(toFocus);
            }
        }

        function playEpisode(ep, translation) {
            Lampa.Noty.show('Запуск ' + (anime.russian || anime.name) + ' — Серия ' + ep.episode + '...', { time: 2000 });

            if (ep.streamUrl && ep.streamUrl.indexOf('.m3u8') >= 0) {
                launchPlayer(ep.streamUrl, ep, translation);
                return;
            }

            KodikBalancer.resolveStream(ep.link, function (res) {
                if (res && res.streamUrl) {
                    launchPlayer(res.streamUrl, ep, translation);
                } else {
                    Lampa.Noty.show('Не удалось получить поток видео', { time: 3000 });
                }
            }, function (err) {
                Lampa.Noty.show('Ошибка: ' + (err || 'не удалось извлечь поток'), { time: 3000 });
            });
        }

        function launchPlayer(streamUrl, ep, translation) {
            var currentSeason = translations[activeTranslation] ? (translations[activeTranslation].seasons[activeSeason] || translations[activeTranslation].seasons['1']) : null;
            var epList = currentSeason ? currentSeason.episodes : [];

            if (window.shikiSendLog) {
                window.shikiSendLog('LAUNCH_PLAYER: animeId=' + anime.id + ' ep=' + ep.episode);
            }

            if (typeof ShikiApi !== 'undefined' && ShikiApi.markLocalEpisodeWatched) {
                ShikiApi.markLocalEpisodeWatched(anime, ep.episode);
            }

            if (window.Lampa && Lampa.Listener) {
                Lampa.Listener.send('shikimori_progress_updated', {
                    animeId: anime.id,
                    episode: ep.episode
                });
            }
            setupHeader();
            renderEpisodes();

            syncWatchProgress(ep.episode);

            ShikiPlayer.play({
                anime: anime,
                season: activeSeason,
                episode: ep.episode,
                streamUrl: streamUrl,
                url: streamUrl,
                title: anime.russian || anime.name,
                subtitle: (translation.title || '') + ' • Серия ' + ep.episode,
                voiceTitle: translation.title || '',
                playlist: epList
            });
        }

        function syncWatchProgress(epNum) {
            if (!ShikiApi.isAuthorized() || !anime || !anime.id) return;

            var newStatus = 'watching';
            if (anime.episodes && epNum >= anime.episodes) {
                newStatus = 'completed';
            }

            ShikiApi.updateProgress(anime.id, rateId, epNum, anime.episodes, function (res) {
                if (res && res.id) rateId = res.id;
                if (window.Lampa && Lampa.Noty) {
                    Lampa.Noty.show('Shikimori: отмечена серия ' + epNum + (newStatus === 'completed' ? ' (Просмотрено)' : ' (Смотрю)'), { time: 3000 });
                }
                setupHeader();
            }, function (err) {
                console.warn('Shikimori syncWatchProgress error:', err);
            });
        }
    }

    return {
        init: init,
        createStatusBadge: createStatusBadge
    };
})();
window.ShikiUI = ShikiUI;
