/**
 * Text input for the Shikimori plugin.
 *
 * The plugin used to draw its own keyboard overlay. On a TV that meant a second
 * focus system fighting with Lampa's one: the hidden <input> opened the Android
 * IME on top of the overlay, Back could call both onDone and onCancel, and after
 * closing the overlay the controller was left on a destroyed "shiki_keyboard".
 *
 * Lampa already ships a D-pad friendly on-screen keyboard (the same one used by
 * search and settings, with layouts, shift, backspace and Back handling), so the
 * plugin now just delegates to it.
 */
var ShikiKeyboard = (function () {
    'use strict';

    function platformIsTv() {
        try {
            return !!(window.Lampa && Lampa.Platform && Lampa.Platform.screen && Lampa.Platform.screen('tv'));
        } catch (e) {
            return false;
        }
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

    /**
     * Lampa's Input closes itself by toggling the settings controller. When the
     * keyboard was opened from a plugin page (and not from Settings) that
     * controller does not exist, so the D-pad would stay bound to the destroyed
     * keyboard. Put the previous controller back if Lampa did not do it.
     */
    function restoreController(previous) {
        try {
            if (!window.Lampa || !Lampa.Controller || !previous) return;
            var current = enabledControllerName();
            if (current === 'keybord' || current === 'select') {
                Lampa.Controller.toggle(previous);
            }
        } catch (e) {}
    }

    function open(params) {
        params = params || {};

        var onDone = typeof params.onDone === 'function' ? params.onDone : null;
        var onCancel = typeof params.onCancel === 'function' ? params.onCancel : null;
        var previous = enabledControllerName();
        var finished = false;

        function finish(value) {
            if (finished) return;
            finished = true;
            restoreController(previous);

            var text = value === null || value === undefined ? '' : String(value).trim();
            if (text) {
                if (onDone) onDone(text);
            } else if (onCancel) {
                onCancel();
            }
        }

        if (window.Lampa && Lampa.Input && typeof Lampa.Input.edit === 'function') {
            var editParams = {
                title: params.title || 'Поиск аниме на Shikimori',
                value: params.value || '',
                free: true,
                nosave: true,
                nomic: true
            };

            // On a TV always use Lampa's own on-screen keyboard: it is the only
            // one the D-pad can drive without opening the system IME.
            if (platformIsTv()) editParams.keyboard = 'lampa';

            try {
                Lampa.Input.edit(editParams, finish);
                return;
            } catch (e) {
                // fall through to the plain prompt below
            }
        }

        var value = window.prompt ? window.prompt(params.title || 'Поиск', params.value || '') : null;
        if (value !== null) finish(value);
        else if (onCancel) onCancel();
    }

    return {
        open: open,
        // Nothing to tear down: Lampa owns the keyboard overlay.
        close: function () {}
    };
})();
